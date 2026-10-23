/**
 * Demo: run the fortify loop on all three terrain profiles and print the
 * before/after maps and the build log — the settlement's architectural
 * history, as computed by the attack sim.
 *
 *   npm run demo --workspace=@mmo-engine/fortify
 */

import { analyze, fortify, generatePondVillage, renderAscii, type TerrainProfile } from "../src/index.js";

for (const profile of ["pond", "dry", "riverside"] as TerrainProfile[]) {
  const s = generatePondVillage(profile);
  const before = analyze(s);
  console.log(`\n=== ${s.name} ===`);
  console.log(renderAscii(s));
  console.log(
    `before: total=${before.total.toFixed(2)} charge=${before.exposures.charge.toFixed(2)} ` +
      `ladders=${before.exposures.ladders.toFixed(2)} mining=${before.exposures.mining.toFixed(2)}`,
  );
  for (const w of before.weaknesses) console.log(`  weakness [${w.kind}] ${w.detail}`);

  const r = fortify(s, { budget: 40, seed: 7 });
  console.log(`\nfortify: spent=${r.spent} stop=${r.stopReason}`);
  for (const step of r.log) {
    console.log(
      `  ${step.step}. ${step.counter} (cost ${step.cost}) ← ${step.weaknessDetail} ` +
        `[exposure ${step.totalBefore.toFixed(2)} → ${step.totalAfter.toFixed(2)}]`,
    );
  }
  console.log(renderAscii(r.settlement));
  console.log(
    `after: total=${r.analysis.total.toFixed(2)} charge=${r.analysis.exposures.charge.toFixed(2)} ` +
      `ladders=${r.analysis.exposures.ladders.toFixed(2)} mining=${r.analysis.exposures.mining.toFixed(2)}`,
  );
  for (const w of r.analysis.weaknesses) console.log(`  residual [${w.kind}] ${w.detail}`);
}
