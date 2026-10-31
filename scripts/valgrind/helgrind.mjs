#!/usr/bin/env node
/**
 * npm run valgrind:helgrind [-- addon ...]
 *
 * Runs every native addon's test suite under valgrind's helgrind and fails
 * on thread errors (data races, deadlocks, lock order violations) in OUR code:
 * an error counts when the code at fault is in the addon's own sources (the
 * rules are in helgrind-report.mjs). Code the addon builds in from a
 * third_party folder, such as Jolt in physics, is counted as vendored, and
 * Node's and V8's own reports as node; neither fails the run. Standard-library
 * and node-addon-api code is blamed on whoever called it.
 *
 * The tests run in the valgrind process itself (--experimental-test-
 * isolation=none): `node --test` otherwise runs each file in a child that
 * valgrind doesn't follow. Everything runs 20 to 50 times slower, so a
 * test that fails on timing may fail here; that is reported but isn't a
 * thread error, and doesn't fail the run.
 *
 * Output: a summary per addon, the stacks of our errors, and the raw XML
 * reports in valgrind-out/helgrind/. Telling our code from vendored code
 * needs file and line numbers, so rebuild the addon with debug info first:
 * `CXXFLAGS=-g npx node-gyp rebuild` in its folder. Without them every error
 * inside the addon's binary counts as ours, and the run says so.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, faultFrame, parseReport } from "./helgrind-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "valgrind-out", "helgrind");
const only = process.argv.slice(2);

if (spawnSync("valgrind", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("[helgrind] valgrind isn't on PATH: install it (apt install valgrind; on Windows, run this from WSL).");
  process.exit(2);
}

/** The addons with a built binary and tests: packages/addons/<name>. */
function addons() {
  const dir = join(root, "packages", "addons");
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "package.json")) && existsSync(join(dir, name, "build", "Release")))
    .map((name) => {
      const at = join(dir, name);
      const tests = existsSync(join(at, "test"))
        ? readdirSync(join(at, "test")).filter((f) => /\.test\.(m?js)$/.test(f)).map((f) => join("test", f))
        : [];
      const binaries = readdirSync(join(at, "build", "Release")).filter((f) => f.endsWith(".node")).map((f) => join(at, "build", "Release", f));
      return { name, at, tests, binaries };
    })
    .filter((a) => a.tests.length > 0 && a.binaries.length > 0 && (only.length === 0 || only.includes(a.name)));
}

/** One frame for the report: its function, and where it is. */
function frameText(f) {
  const where = f.file ? `${relative(root, f.file)}:${f.line}` : relative(root, f.obj) || f.obj;
  return `${f.fn || "???"}  (${where})`;
}

/** An error for the report: its kind and text, the faulting stack, then the top of each other stack. */
function describe(err) {
  const lines = [`  ${err.kind}: ${err.what}`];
  for (const f of (err.stacks[0] ?? []).slice(0, 14)) lines.push(`    ${frameText(f)}`);
  for (const stack of err.stacks.slice(1)) {
    lines.push("    other stack:");
    for (const f of stack.slice(0, 8)) lines.push(`      ${frameText(f)}`);
  }
  return lines.join("\n");
}

mkdirSync(outDir, { recursive: true });
const list = addons();
if (list.length === 0) {
  console.error(`[helgrind] no built addons with tests${only.length ? ` among: ${only.join(", ")}` : ""}`);
  process.exit(2);
}

let failed = 0;
const rows = [];
const notes = [];
for (const a of list) {
  const xmlFile = join(outDir, `${a.name}.xml`);
  const t0 = Date.now();
  const r = spawnSync(
    "valgrind",
    [
      "--tool=helgrind",
      "--history-level=full",
      "--track-lockorders=yes",
      "--num-callers=40",
      "--xml=yes",
      `--xml-file=${xmlFile}`,
      process.execPath,
      "--experimental-test-isolation=none",
      "--test",
      ...a.tests,
    ],
    { cwd: a.at, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  if (!existsSync(xmlFile)) {
    console.error(`[helgrind] ${a.name}: valgrind wrote no report (${r.error?.message ?? r.stderr.slice(-500)})`);
    failed++;
    continue;
  }
  const errors = parseReport(readFileSync(xmlFile, "utf8"));
  const kinds = errors.map((e) => classify(e, a, root));
  const ours = errors.filter((_, i) => kinds[i] === "ours");
  const unlocated = ours.filter((e) => faultFrame(e, root)?.file === "").length;
  const testsFailed = /# fail (\d+)/.exec(r.stdout)?.[1] ?? "?";
  rows.push({
    addon: a.name,
    seconds,
    errors: errors.length,
    ours: ours.length,
    vendored: kinds.filter((k) => k === "vendored").length,
    testsFailed,
  });
  if (unlocated > 0) {
    notes.push(
      `[helgrind] ${a.name}: ${unlocated} of the ours have no source location, so they count as ours. ` +
        `Rebuild with debug info (CXXFLAGS=-g npx node-gyp rebuild in packages/addons/${a.name}) to tell our code from vendored code.`,
    );
  }
  if (ours.length > 0) {
    failed++;
    console.log(`\n[helgrind] ${a.name}: ${ours.length} thread error(s) in our code`);
    for (const e of ours) console.log(describe(e));
  }
}

console.log("\n  addon          time    ours  vendored  node/v8   tests failing under valgrind");
for (const r of rows) {
  const nodeV8 = r.errors - r.ours - r.vendored;
  console.log(
    `  ${r.addon.padEnd(14)} ${String(r.seconds).padStart(4)} s  ${String(r.ours).padStart(4)}  ${String(r.vendored).padStart(8)}  ${String(nodeV8).padStart(8)}            ${r.testsFailed}`,
  );
}
for (const note of notes) console.log(note);
console.log(`\n[helgrind] ${failed === 0 ? "clean" : `${failed} addon(s) with thread errors`}; reports in ${relative(root, outDir)}/`);
process.exit(failed === 0 ? 0 : 1);
