#!/usr/bin/env node
/**
 * npm run valgrind:check [-- --threshold 3]
 *
 * A gate over the results already in valgrind-out/ (it runs nothing):
 *
 *   memcheck   fails on an error in OUR code (an addon's *.node) that isn't
 *              in the last committed entry of perf/history.json. Node's and
 *              V8's own errors are not hidden anywhere (no suppressions);
 *              they just don't gate, only our code does. Errors that pass
 *              through our code but fault in Node ("via") are listed as notes.
 *   callgrind  fails on a workload more than --threshold percent (default 3)
 *              over perf/callgrind-baseline.json. If the run used another Node
 *              than the baseline, counts aren't comparable: it says so and
 *              doesn't gate on them.
 *
 * Exit 0 pass, 1 fail, 2 no results to check.
 */
import { callgrind, history, memcheckReports, memcheckSummary } from "./lib.mjs";

const at = process.argv.indexOf("--threshold");
const threshold = at > 0 ? Number(process.argv[at + 1]) : 3;
const problems = [], notes = [];

const reports = memcheckReports();
const cg = callgrind();
const measured = cg.workloads.filter((w) => w.irPerOp !== null);
if (reports.length === 0 && measured.length === 0) {
  console.error("[check] no results in valgrind-out/. Run `npm run valgrind:memcheck` and `npm run valgrind:perf` first.");
  process.exit(2);
}

if (reports.length) {
  const now = memcheckSummary(reports);
  const ref = history().committed.at(-1);
  const known = new Set(ref?.memcheck?.engineKeys ?? []);
  const fresh = now.engineKeys.filter((k) => !known.has(k));
  const gone = [...known].filter((k) => !now.engineKeys.includes(k));
  console.log(`[check] memcheck: ${now.engineErrors} error(s) in our code (gated), ${now.viaErrors} passing through it but faulting in Node/V8 (not gated), ${now.errors - now.engineErrors - now.viaErrors} in Node/V8/libc only (not gated); reference: ${ref ? `${ref.commit} (${ref.time.slice(0, 10)})` : "none, so every error in our code is new"}`);
  for (const k of fresh) problems.push(`new error in our code: ${k.split("|").join("  ")}`);
  for (const k of now.viaKeys.filter((k) => !(ref?.memcheck?.viaKeys ?? []).includes(k))) notes.push(`through our code, fault in Node/V8: ${k.split("|").join("  ")}`);
  for (const k of gone) notes.push(`resolved since the reference: ${k.split("|").join("  ")}`);
}

if (measured.length) {
  if (cg.nodeMismatch) {
    notes.push(`callgrind not gated: baseline was measured on Node ${cg.baselineNode}, this run used ${cg.runNode}. Re-measure the baseline (\`npm run valgrind:perf -- --update\`) on one Node.`);
  } else {
    console.log(`[check] callgrind: ${measured.length} workload(s) against the baseline, threshold ${threshold}%`);
    for (const w of measured) if (w.deltaPct > threshold) problems.push(`${w.name} is ${w.deltaPct.toFixed(1)}% over its baseline`);
  }
  for (const w of cg.workloads.filter((x) => x.irPerOp === null)) notes.push(`${w.name}: no result in this run`);
}

for (const n of notes) console.log(`  note: ${n}`);
for (const p of problems) console.log(`  FAIL: ${p}`);
console.log(problems.length ? `[check] failed (${problems.length})` : "[check] ok");
process.exit(problems.length ? 1 : 0);
