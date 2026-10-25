/**
 * Frame export for the PNG/GIF test visuals: runs the fortify loop on
 * each terrain profile, snapshots the settlement at step 0 and after
 * every build step, and writes frames.json for render_frames.py.
 *
 *   npm run build && node dist/examples/frames.js <outdir>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, fortify, generatePondVillage, renderClasses, type Settlement, type TerrainProfile } from "../src/index.js";

const outdir = process.argv[2] ?? "frames";
mkdirSync(outdir, { recursive: true });

interface Frame {
  caption: string;
  grid: string[];
}

const profiles: Record<string, Frame[]> = {};
for (const profile of ["pond", "dry", "riverside"] as TerrainProfile[]) {
  const s = generatePondVillage(profile);
  const frames: Frame[] = [
    { caption: `${profile}: as generated (total exposure ${analyze(s).total.toFixed(2)})`, grid: renderClasses(s) },
  ];
  const r = fortify(s, {
    budget: 40,
    seed: 7,
    onStep: (snap: Settlement, step) => {
      frames.push({
        caption: `${profile} step ${step.step}: ${step.counter} (cost ${step.cost}) - exposure ${step.totalBefore.toFixed(2)} -> ${step.totalAfter.toFixed(2)}`,
        grid: renderClasses(snap),
      });
    },
  });
  frames.push({
    caption: `${profile}: final (stop: ${r.stopReason}, spent ${r.spent}, exposure ${r.analysis.total.toFixed(2)})`,
    grid: renderClasses(r.settlement),
  });
  profiles[profile] = frames;
}
writeFileSync(join(outdir, "frames.json"), JSON.stringify(profiles, null, 1));
console.log(`wrote ${Object.values(profiles).reduce((a, f) => a + f.length, 0)} frames to ${outdir}/frames.json`);
