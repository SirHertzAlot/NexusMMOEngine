#!/usr/bin/env node
/**
 * npm run valgrind:tsan [-- addon ...] [--rebuild]
 *
 * Runs every native addon's test suite under ThreadSanitizer and fails on data
 * races, deadlocks and lock-order violations in OUR code. Who owns a report is
 * decided in tsan-report.mjs: the addon's own sources are ours, a third_party
 * folder (Jolt, in physics) is vendored, and Node's and V8's own reports are
 * node. Neither vendored nor node reports fail the run. Test failures are
 * reported but don't fail it either, as in helgrind.mjs.
 *
 * ThreadSanitizer needs no valgrind, only gcc's libtsan (apt install libtsan2 on
 * Debian and Ubuntu). The addon is built with -fsanitize=thread in a copy under
 * valgrind-out/tsan/<addon>/, so packages/addons keeps its normal build. The
 * tests run in the Node process with libtsan preloaded, and every process,
 * child processes included, writes its own report file under
 * valgrind-out/tsan/reports/<addon>/. --rebuild starts the TSan build again;
 * otherwise an incremental build picks up source changes.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTsan, parseTsanReports } from "./tsan-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "valgrind-out", "tsan");
const argv = process.argv.slice(2);
const rebuild = argv.includes("--rebuild");
const only = argv.filter((a) => !a.startsWith("--"));
const FLAGS = "-g -O1 -fsanitize=thread -fno-omit-frame-pointer";

/** gcc's ThreadSanitizer runtime, which is preloaded into node: it must be loaded before the addon. */
function libtsan() {
  const r = spawnSync("gcc", ["-print-file-name=libtsan.so"], { encoding: "utf8" });
  const path = r.stdout.trim();
  return r.status === 0 && path.startsWith("/") && existsSync(path) ? path : null;
}

/** The addons with a binding.gyp and tests: packages/addons/<name>. */
function addons() {
  const dir = join(root, "packages", "addons");
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "binding.gyp")))
    .map((name) => {
      const at = join(dir, name);
      const tests = existsSync(join(at, "test"))
        ? readdirSync(join(at, "test")).filter((f) => /\.test\.(m?js)$/.test(f)).map((f) => join("test", f))
        : [];
      return { name, at, tests };
    })
    .filter((a) => a.tests.length > 0 && (only.length === 0 || only.includes(a.name)));
}

/** A copy of the addon's sources, without its normal build or installed packages; the copy's own build stays. */
function refresh(a, copy) {
  cpSync(a.at, copy, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => src !== join(a.at, "build") && src !== join(a.at, "node_modules"),
  });
}

/** Builds the copy with ThreadSanitizer. Returns null, or the failure's log tail. */
function build(copy, logFile) {
  const verb = rebuild || !existsSync(join(copy, "build", "Makefile")) ? "rebuild" : "build";
  const env = { ...process.env, CFLAGS: FLAGS, CXXFLAGS: FLAGS, LDFLAGS: "-fsanitize=thread" };
  const r = spawnSync("npx", ["node-gyp", verb], {
    cwd: copy,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(logFile, log);
  return r.status === 0 ? null : log.slice(-1500);
}

/** The built binaries in the copy. */
function binariesIn(copy) {
  const release = join(copy, "build", "Release");
  return existsSync(release) ? readdirSync(release).filter((f) => f.endsWith(".node")).map((f) => join(release, f)) : [];
}

/** Runs the addon's tests in this process, with libtsan preloaded and the report files in `dir`. */
function runTests(copy, tests, lib, dir) {
  const opts = {
    cwd: copy,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: {
      ...process.env,
      LD_PRELOAD: lib,
      TSAN_OPTIONS: `log_path=${join(dir, "tsan")} halt_on_error=0 second_deadlock_stack=1 history_size=7`,
    },
  };
  const args = ["--experimental-test-isolation=none", "--test", ...tests];
  let r = spawnSync(process.execPath, args, opts);
  // Some kernels map memory where TSan wants none; with ASLR off for the run, it starts.
  if (r.status !== 0 && /unexpected memory mapping/.test(r.stderr ?? "")) {
    r = spawnSync("setarch", ["x86_64", "-R", process.execPath, ...args], opts);
  }
  return r;
}

/** One frame for the report: its function, and where it is, relative to the repo when it has a file. */
function frameText(f, addon) {
  const where = f.file ? `${relative(root, isAbsolute(f.file) ? f.file : resolve(addon.at, f.file))}:${f.line}` : f.module || "?";
  return `${f.fn || "???"}  (${where})`;
}

/** A report for the console: its kind, then the access stack's frames. */
function describe(report, addon) {
  const lines = [`  ${report.kind}`];
  for (const f of (report.stacks[0] ?? []).slice(0, 14)) lines.push(`    ${frameText(f, addon)}`);
  return lines.join("\n");
}

const lib = libtsan();
if (!lib) {
  console.error("[tsan] gcc's libtsan.so isn't found: install it (apt install libtsan2 on Debian or Ubuntu).");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const list = addons();
if (list.length === 0) {
  console.error(`[tsan] no addons with tests${only.length ? ` among: ${only.join(", ")}` : ""}`);
  process.exit(2);
}

let failed = 0;
const rows = [];
for (const a of list) {
  const copy = join(outDir, a.name);
  refresh(a, copy);
  const buildFailure = build(copy, join(outDir, `build-${a.name}.log`));
  const binaries = binariesIn(copy);
  if (buildFailure !== null || binaries.length === 0) {
    failed++;
    console.error(`[tsan] ${a.name}: the TSan build failed (log: ${relative(root, join(outDir, `build-${a.name}.log`))})\n${buildFailure ?? ""}`);
    continue;
  }

  const dir = join(outDir, "reports", a.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const r = runTests(copy, a.tests, lib, dir);
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);

  const reports = [
    ...readdirSync(dir).filter((f) => f.startsWith("tsan")).flatMap((f) => parseTsanReports(readFileSync(join(dir, f), "utf8"))),
    ...parseTsanReports(r.stderr ?? ""),
  ];
  const addon = { at: copy, binaries };
  const kinds = reports.map((report) => classifyTsan(report, addon, root));
  const ours = reports.filter((_, i) => kinds[i] === "ours");
  const tapCount = (name) => new RegExp(`^# ${name} (\\d+)$`, "m").exec(r.stdout ?? "")?.[1] ?? "?";
  const testsFailed = tapCount("fail");
  const testsPassed = tapCount("pass");
  const testsTotal = tapCount("tests");
  rows.push({
    addon: a.name,
    seconds,
    reports: reports.length,
    ours: ours.length,
    vendored: kinds.filter((k) => k === "vendored").length,
    testsFailed,
    tests: testsTotal === "?" ? "?" : `${testsPassed} of ${testsTotal}`,
  });
  if (testsFailed === "?") {
    console.log(`[tsan] ${a.name}: the test run printed no TAP summary; its stderr ends:\n${(r.stderr ?? "").slice(-800)}`);
  }
  if (ours.length > 0) {
    failed++;
    console.log(`\n[tsan] ${a.name}: ${ours.length} race or deadlock report(s) in our code`);
    for (const report of ours) console.log(describe(report, addon));
  }
}

console.log("\n  addon          time    ours  vendored  reports  tests passing  failing");
for (const r of rows) {
  console.log(
    `  ${r.addon.padEnd(14)} ${String(r.seconds).padStart(4)} s  ${String(r.ours).padStart(4)}  ${String(r.vendored).padStart(8)}  ${String(r.reports).padStart(7)}  ${r.tests.padStart(13)}  ${r.testsFailed.padStart(7)}`,
  );
}
console.log(`\n[tsan] ${failed === 0 ? "clean" : `${failed} addon(s) with reports in our code or a failed build`}; reports in ${relative(root, join(outDir, "reports"))}/`);
process.exit(failed === 0 ? 0 : 1);
