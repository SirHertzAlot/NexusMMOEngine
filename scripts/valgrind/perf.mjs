#!/usr/bin/env node
/**
 * npm run valgrind:perf [-- [--update] [--check] [--threshold 3] [workload ...]]
 *
 * Instruction counts for the engine's headless workloads
 * (scripts/valgrind/workloads.mjs), measured with callgrind: each workload
 * runs its operations between the perf probe's begin() and end(name), so a
 * count is exactly those instructions (JS, the JIT's code, native addons)
 * and nothing of Node's startup or the workload's setup. Instruction
 * counts, unlike wall time, barely move between runs of the same code,
 * which makes them a baseline to hold changes to: an architecture change,
 * a new system, an addon update.
 *
 *   (no flags)   measure and compare with perf/callgrind-baseline.json
 *   --update     measure and write the baseline
 *   --check      exit 1 if a workload is slower than the baseline by more
 *                than --threshold percent (default 3)
 *
 * Node runs with --single-threaded (no background compiler or GC threads),
 * so the counts don't depend on thread scheduling. The baseline records
 * the Node version it was measured with; counts from another Node (or
 * compiler) aren't comparable, and the comparison says so.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "valgrind-out", "callgrind");
const baselineFile = join(root, "perf", "callgrind-baseline.json");

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const thresholdAt = args.indexOf("--threshold");
const threshold = thresholdAt >= 0 ? Number(args[thresholdAt + 1]) : 3;
const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--threshold");

/** Run the workloads once under callgrind; returns { name: { ir, n, unit } } and the skipped ones. */
export function measure(list = names) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync(
    "valgrind",
    [
      "--tool=callgrind",
      "--collect-atstart=no",
      `--callgrind-out-file=${join(outDir, "cg.out")}`,
      process.execPath,
      "--single-threaded",
      join(root, "scripts", "valgrind", "workloads.mjs"),
      ...list,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, PERF_JSON: "1" }, maxBuffer: 64 * 1024 * 1024 },
  );
  const line = r.stdout.split("\n").find((l) => l.startsWith("PERF_RESULTS "));
  if (r.status !== 0 || !line) throw new Error(`workloads failed under callgrind (exit ${r.status}):\n${r.stderr.slice(-2000)}`);
  const results = JSON.parse(line.slice("PERF_RESULTS ".length));
  // One dump per end(name): "desc: Trigger: Client Request: <name>", then "totals: <Ir>".
  const irByName = new Map();
  for (const f of readdirSync(outDir)) {
    const text = readFileSync(join(outDir, f), "utf8");
    const trigger = /^desc: Trigger: Client Request: (.+)$/m.exec(text);
    const totals = /^totals: (\d+)/m.exec(text) ?? /^summary: (\d+)/m.exec(text);
    if (trigger && totals) irByName.set(trigger[1].trim(), Number(totals[1]));
  }
  const measured = {};
  const skipped = {};
  for (const w of results) {
    if (w.skipped) skipped[w.name] = w.skipped;
    else if (irByName.has(w.name)) measured[w.name] = { ir: irByName.get(w.name), n: w.n, unit: w.unit };
    else skipped[w.name] = "no callgrind dump for it";
  }
  return { measured, skipped };
}

const fmt = (x) => (x >= 1e9 ? `${(x / 1e9).toFixed(2)} G` : x >= 1e6 ? `${(x / 1e6).toFixed(2)} M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)} k` : `${Math.round(x)}`);

function main() {
  const t0 = Date.now();
  const { measured, skipped } = measure();
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
  const sameNode = baseline?.node === process.version;

  console.log(`\n  workload                instructions per op        baseline      change`);
  let regressions = 0;
  for (const [name, m] of Object.entries(measured)) {
    const perOp = m.ir / m.n;
    const base = baseline?.workloads?.[name]?.irPerOp;
    let change = "";
    if (base) {
      const pct = ((perOp - base) / base) * 100;
      change = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)} %`;
      if (sameNode && pct > threshold) {
        regressions++;
        change += "  ← slower";
      }
    }
    console.log(`  ${name.padEnd(22)} ${fmt(perOp).padStart(10)} per ${m.unit.padEnd(6)}  ${base ? fmt(base).padStart(10) : "         —"}   ${change}`);
  }
  for (const [name, why] of Object.entries(skipped)) console.log(`  ${name.padEnd(22)} skipped: ${why}`);
  if (baseline && !sameNode) console.log(`\n  (the baseline was measured on Node ${baseline.node}; this is ${process.version}: not comparable)`);

  if (flag("--update")) {
    const workloads = { ...(baseline?.workloads ?? {}) };
    for (const [name, m] of Object.entries(measured)) workloads[name] = { irPerOp: Math.round(m.ir / m.n), unit: m.unit, n: m.n };
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(
      baselineFile,
      JSON.stringify({ format: "mmo-callgrind-baseline/1", node: process.version, platform: `${process.platform}-${process.arch}`, workloads }, null, 2) + "\n",
    );
    console.log(`\n[perf] baseline written: ${relative(root, baselineFile)}`);
  }
  console.log(`\n[perf] ${Object.keys(measured).length} workload(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s; dumps in ${relative(root, outDir)}/ (open with callgrind_annotate or KCachegrind)`);
  if (flag("--check") && regressions > 0) {
    console.error(`[perf] ${regressions} workload(s) more than ${threshold} % slower than the baseline`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
