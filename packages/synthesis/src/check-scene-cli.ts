#!/usr/bin/env node
/**
 * node dist/src/check-scene-cli.js <scene.json> [--out <cleaned.json>] [--report <report.json>] [--min-parts <n>] [--keep-open]
 *
 * Runs the structure checks over a synthesized settlement scene: open-ground parcels lose the house parts they were
 * handed, detached and floating parts are pruned, and each building's closure is reported. Writes the cleaned scene
 * (to --out; without it nothing is written) and prints a summary. Run it between the village synthesis and the export.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { SceneDoc } from "@mmo-engine/scene";
import { checkSettlementScene } from "./scene-check.js";

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, report: { type: "string" }, "min-parts": { type: "string" }, "keep-open": { type: "boolean" } } });
const file = positionals[0];
if (!file) {
  console.error("usage: check-scene-cli <scene.json> [--out <file>] [--report <file>] [--min-parts <n>] [--keep-open]");
  process.exit(2);
}
const scene = JSON.parse(readFileSync(file, "utf8")) as SceneDoc;
const { scene: cleaned, report } = checkSettlementScene(scene, { ...(o["min-parts"] ? { minParts: Number(o["min-parts"]) } : {}), stripOpen: !o["keep-open"] });
const t = report.totals;
console.log(`[check] ${t.buildings} buildings: ${t.openWithParts} open-ground parcels were given parts, ${t.partsRemoved} parts removed; ${t.closed} buildings close, ${t.unclosed - 0} do not`);
for (const [what, n] of Object.entries(report.missingCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${n} missing a ${what}`);
if (o.out) writeFileSync(o.out, `${JSON.stringify(cleaned)}\n`);
if (o.report) writeFileSync(o.report, `${JSON.stringify(report, null, 2)}\n`);
