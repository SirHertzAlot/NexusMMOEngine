#!/usr/bin/env node
/**
 * Client physics benchmark: Rapier (WASM) against Jolt (WASM, the same engine
 * as the server's physics addon), on the same scene:
 *
 * - terrain: one 128 m heightfield (129 x 129 samples, radially symmetric hills)
 * - props: 300 static boxes scattered on the terrain (scatter props)
 * - character: one kinematic capsule walking a 20 m circle at 4 m/s
 * - ragdolls: N rigs of 11 boxes joined by 10 ball joints, dropped on the terrain
 *
 * The tick matches the engine's: 60 Hz, two collision substeps. Each library
 * runs single-threaded. Output: JSON on stdout, or to `--out <file>`.
 *
 *   node scripts/bench-physics.mjs [--out file.json] [--quick]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE, terrainHeight, propLayout, RIG_PARTS, RIG_JOINTS, rigRoot, characterAt, physxAdapter, rapierAdapter, joltAdapter } from "./bench-scene.mjs";
export { SCENE, terrainHeight, propLayout, RIG_PARTS, RIG_JOINTS, rigRoot, characterAt, physxAdapter, rapierAdapter, joltAdapter };

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

// ---------------------------------------------------------------- driver

export function summarise(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    medianMs: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p99Ms: percentile(sorted, 0.99),
    meanMs: samplesMs.reduce((s, v) => s + v, 0) / samplesMs.length,
  };
}

export function gzipSize(path) {
  return gzipSync(readFileSync(path)).length;
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const rigCounts = quick ? [0, 50] : [0, 10, 50, 100, 200];
  // Two modes: rigs may fall asleep (the engine's default), or are kept awake (worst case).
  const modes = ["sleeping", "awake"];
  const warm = quick ? 30 : 60;
  const steps = quick ? 120 : 300;
  const repeats = quick ? 1 : 3;
  // PhysX is browser-only (physx-js-webidl refuses Node): see physx-browser-bench.html.
  const libs = [await rapierAdapter(), await joltAdapter()];
  const result = { scene: SCENE, rigCounts, modes, steps, repeats, libs: {} };
  for (const lib of libs) {
    const rows = {};
    for (const [mode, awake] of modes.map((m) => [m, m === "awake"])) for (const rigs of rigCounts) {
      const key = `${mode}:${rigs}`;
      const runs = [];
      for (let rep = 0; rep < repeats; rep++) {
        const sim = lib.build(rigs, awake);
        for (let f = 0; f < warm; f++) sim.step(f * SCENE.dt);
        const times = [];
        for (let f = warm; f < warm + steps; f++) {
          const t0 = performance.now();
          sim.step(f * SCENE.dt);
          times.push(performance.now() - t0);
        }
        runs.push({ ...summarise(times), stats: sim.stats() });
        sim.free?.();
      }
      const medians = runs.map((r) => r.medianMs).sort((a, b) => a - b);
      rows[key] = { mode, rigs, medianMs: medians[Math.floor(medians.length / 2)], runs };
      process.stderr.write(`${lib.name} ${key} median=${rows[key].medianMs.toFixed(3)} ms\n`);
    }
    result.libs[lib.name] = rows;
  }
  const json = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, json);
  else process.stdout.write(json + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(String(e?.stack ?? e) + "\n");
    process.exit(1);
  });
}
