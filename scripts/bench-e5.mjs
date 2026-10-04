#!/usr/bin/env node
/**
 * `npm run bench:e5`: the edge/core split benchmarks (docs/EDGE-CORE-SPLIT.md
 * slice E5), in order. Each prints a JSON summary and appends its section to
 * docs/EDGE-SPLIT-RESULTS.md. Takes about 15 minutes (B2 runs 3 × 30 s, B6
 * soaks for 10 minutes; E5_B2_SECONDS and E5_B6_SECONDS shorten them).
 *
 *   npm run bench:e5 -- B1 B4     # just those
 */
import { execSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCHES = {
  B1: "apps/edge/test/bench/b1-hop-latency.mjs",
  B2: "packages/channel/test/bench/b2-throughput.mjs",
  B3: "packages/engine-core/test/bench/b3-push-overhead.mjs",
  B4: "packages/engine-core/test/bench/b4-delta-bandwidth.mjs",
  B5: "apps/edge/test/bench/b5-failure-drill.mjs",
  B6: "apps/edge/test/bench/b6-soak.mjs",
};
const pick = process.argv.slice(2).map((s) => s.toUpperCase());
const run = pick.length ? pick : Object.keys(BENCHES);
for (const id of run) if (!BENCHES[id]) { console.error(`unknown bench ${id} (have ${Object.keys(BENCHES).join(", ")})`); process.exit(2); }

for (const ws of ["@mmo-engine/channel", "@mmo-engine/engine-core", "@mmo-engine/edge"]) {
  execSync(`npm run build --workspace=${ws}`, { cwd: ROOT, stdio: "inherit" });
}
// engine-core's dist/test holds the headless game client the benches use.
let failed = 0;
for (const id of run) {
  console.error(`\n=== ${id} ===`);
  const r = spawnSync(process.execPath, [path.join(ROOT, BENCHES[id])], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { failed++; console.error(`${id} exited ${r.status}`); }
}
process.exit(failed ? 1 : 0);
