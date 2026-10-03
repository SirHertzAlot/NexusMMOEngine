#!/usr/bin/env node
/**
 * npm run valgrind:memcheck [-- addon ...]
 *
 * Runs every native addon's test suite under valgrind's memcheck and fails
 * on memory errors or definite leaks in OUR code: an error or leak counts
 * when the code at fault is in one of the addons' own binaries
 * (packages/addons/<name>/build/Release/*.node; see isOurs). Node and V8 report plenty
 * of their own (the garbage collector reads memory memcheck thinks is
 * uninitialised); those are left out instead of kept in a suppression list
 * that would rot with every Node release.
 *
 * The tests run in the valgrind process itself (--experimental-test-
 * isolation=none): `node --test` otherwise runs each file in a child that
 * valgrind doesn't follow. Everything runs 20 to 50 times slower, so a
 * test that fails on timing may fail here; that is reported but isn't a
 * memory error, and doesn't fail the run.
 *
 * Output: a summary per addon, the stacks of our errors and leaks, and
 * the raw XML reports in valgrind-out/memcheck/. For file and line numbers
 * in the stacks, rebuild the addon with debug info first:
 * `CXXFLAGS=-g npx node-gyp rebuild` in its folder (it runs the same).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "valgrind-out", "memcheck");
const only = process.argv.slice(2);

if (spawnSync("valgrind", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("[memcheck] valgrind isn't on PATH: install it (apt install valgrind; on Windows, run this from WSL).");
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

// ---- a small reader for valgrind's XML (the parts we need)

const text = (xml, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim() : "";
};
const all = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);

function readReport(file) {
  const xml = readFileSync(file, "utf8");
  return all(xml, "error").map((e) => {
    const stack = all(e, "stack")[0] ?? "";
    const frames = all(stack, "frame").map((f) => ({ obj: text(f, "obj"), fn: text(f, "fn"), file: text(f, "file"), line: text(f, "line") }));
    const what = text(e, "what") || text(all(e, "xwhat")[0] ?? "", "text");
    return { kind: text(e, "kind"), what, frames };
  });
}

/**
 * Ours when the code at fault is: the first frame that isn't the allocator
 * or a C/C++ runtime helper (malloc, memcpy, operator new, strlen...) is in
 * one of the addon's binaries. For a leak that's the code that allocated
 * the block; for a bad read or write, the code that made it. Node or V8
 * code merely running during an addon call (the garbage collector, say)
 * isn't ours even though an addon frame sits further down the stack.
 */
function isOurs(err, binaries) {
  const runtime = /vgpreload_|\/libc[.-]|\/libstdc\+\+|\/libm[.-]|\/libgcc|ld-linux/;
  const first = err.frames.find((f) => !runtime.test(f.obj));
  return first !== undefined && binaries.includes(first.obj);
}

function describe(err) {
  const lines = [`  ${err.kind}: ${err.what}`];
  for (const f of err.frames.slice(0, 14)) {
    const where = f.file ? `${f.file}:${f.line}` : relative(root, f.obj) || f.obj;
    lines.push(`    ${f.fn || "???"}  (${where})`);
  }
  return lines.join("\n");
}

mkdirSync(outDir, { recursive: true });
const list = addons();
if (list.length === 0) {
  console.error(`[memcheck] no built addons with tests${only.length ? ` among: ${only.join(", ")}` : ""}`);
  process.exit(2);
}

let failed = 0;
const rows = [];
for (const a of list) {
  const xmlFile = join(outDir, `${a.name}.xml`);
  const t0 = Date.now();
  const r = spawnSync(
    "valgrind",
    [
      "--tool=memcheck",
      "--leak-check=full",
      "--show-leak-kinds=definite",
      "--errors-for-leak-kinds=definite",
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
    console.error(`[memcheck] ${a.name}: valgrind wrote no report (${r.error?.message ?? r.stderr.slice(-500)})`);
    failed++;
    continue;
  }
  const errors = readReport(xmlFile);
  const ours = errors.filter((e) => isOurs(e, a.binaries));
  const testsFailed = /# fail (\d+)/.exec(r.stdout)?.[1] ?? "?";
  rows.push({ addon: a.name, seconds, errors: errors.length, ours: ours.length, testsFailed });
  if (ours.length > 0) {
    failed++;
    console.log(`\n[memcheck] ${a.name}: ${ours.length} error(s) or leak(s) in our code`);
    for (const e of ours) console.log(describe(e));
  }
}

console.log("\n  addon          time    ours   node/v8 (ignored)   tests failing under valgrind");
for (const r of rows) {
  console.log(`  ${r.addon.padEnd(14)} ${String(r.seconds).padStart(4)} s  ${String(r.ours).padStart(4)}   ${String(r.errors - r.ours).padStart(8)}            ${r.testsFailed}`);
}
console.log(`\n[memcheck] ${failed === 0 ? "clean" : `${failed} addon(s) with errors`}; reports in ${relative(root, outDir)}/`);
process.exit(failed === 0 ? 0 : 1);
