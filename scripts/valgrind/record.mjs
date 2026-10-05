#!/usr/bin/env node
/**
 * npm run valgrind:record [-- --promote]
 *
 * Snapshots the current valgrind-out results (memcheck error counts, callgrind
 * instructions per operation) into valgrind-out/history/ (local, gitignored).
 * With --promote the snapshot is also appended to perf/history.json, the
 * committed history that shows up in PRs.
 */
import { localSnapshots, promote, saveLocal, snapshot } from "./lib.mjs";

const entry = snapshot();
if (entry.memcheck.reports === 0 && Object.keys(entry.callgrind).length === 0) {
  console.error("No results in valgrind-out/. Run `npm run valgrind:memcheck` and/or `npm run valgrind:perf` first.");
  process.exit(1);
}
console.log(`recorded ${saveLocal(entry)}`);
if (process.argv.includes("--promote")) {
  console.log(promote(entry) ? "appended to perf/history.json" : "already in perf/history.json");
}
console.log(`${localSnapshots().length} local snapshot(s)`);
