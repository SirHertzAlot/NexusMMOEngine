// Browser runner for the physics benchmark: the same scene and driver as
// bench-physics.mjs, run in Chromium so physx-js-webidl (web-only) can load.
// Started by physx-browser-run.mjs, which serves the repo and reads window.__physicsBench.
import { SCENE, rapierAdapter, joltAdapter, physxAdapter } from "./bench-scene.mjs";

// One library per page (?lib=rapier|jolt|physx), a smaller sweep, and a result
// published as soon as that library finishes.
const rigCounts = [0, 50, 100, 200];
const modes = [["sleeping", false], ["awake", true]];
const WARM = 60, STEPS = 300, REPEATS = 3;
const LIBS = { rapier: rapierAdapter, jolt: joltAdapter, physx: physxAdapter };

function summarise(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { medianMs: s[Math.floor(s.length / 2)], p99Ms: s[Math.min(s.length - 1, Math.floor(0.99 * s.length))] };
}

async function run() {
  const which = new URLSearchParams(location.search).get("lib") ?? "rapier";
  const libs = [await LIBS[which]()];
  const result = { env: "chromium", scene: SCENE, rigCounts, steps: STEPS, repeats: REPEATS, libs: {} };
  for (const lib of libs) {
    const rows = {};
    for (const [mode, awake] of modes) for (const rigs of rigCounts) {
      const runs = [];
      for (let rep = 0; rep < REPEATS; rep++) {
        const sim = lib.build(rigs, awake);
        for (let f = 0; f < WARM; f++) sim.step(f * SCENE.dt);
        const times = [];
        for (let f = WARM; f < WARM + STEPS; f++) {
          const t0 = performance.now();
          sim.step(f * SCENE.dt);
          times.push(performance.now() - t0);
        }
        runs.push({ ...summarise(times), stats: sim.stats() });
        sim.free?.();
      }
      const meds = runs.map((r) => r.medianMs).sort((a, b) => a - b);
      rows[`${mode}:${rigs}`] = { mode, rigs, medianMs: meds[1], runs };
    }
    result.libs[lib.name] = rows;
  }
  return result;
}

run().then((r) => { window.__physicsBench = r; })
  .catch((e) => { window.__physicsBench = { error: String(e?.stack ?? e) }; });
