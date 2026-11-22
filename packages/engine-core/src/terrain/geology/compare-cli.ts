/**
 * geology:compare — the bounded prototype's comparison harness.
 *
 * For each seed, surveys the same world twice with the same coast, climate,
 * erosion and biomes: (1) the baseline, the designer-guided ranges the
 * engine uses today; (2) the geology snapshot's provinces as the macro
 * relief. Both go through the identical downstream survey (erosion, water,
 * climate, biomes) and the identical opportunity pass, then a controllability
 * test edits each arm locally and measures how much of the land changed.
 *
 * Usage (from packages/engine-core, after `npm run build`):
 *   node dist/src/terrain/geology/compare-cli.js [--spec worlds/default.world.json]
 *        [--seeds 7,11,23] [--out geology-compare]
 *
 * Writes <out>/compare.json, <out>/compare.md and one PNG per arm and seed.
 * Volcanoes are switched off in both arms (they sit on the baseline's range
 * axis, which the geology arm does not have), so only the macro relief differs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LAND } from "../hydrology.js";
import { png } from "../png.js";
import { fieldSeed, noiseField, surveyWorld, coarseGrid, type Survey } from "../survey.js";
import { spawnPoint } from "../world-bake.js";
import { parseWorldSpec, worldBounds, type WorldSpec } from "../world-spec.js";
import { findOpportunities, VISIBLE_RESOURCE_TABLE, type OpportunityReport } from "./opportunities.js";
import { classifyGeology } from "./provinces.js";
import { drawGeologyMap } from "./render.js";
import { generateGeologySpec, type GeologySpec } from "./snapshot.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Share of in-world land cells whose final height moved by more than 1 m. */
function changedShare(a: Survey, b: Survey): number {
  let land = 0;
  let moved = 0;
  for (let i = 0; i < a.height.length; i++) {
    if (a.water[i] !== LAND && b.water[i] !== LAND) continue;
    land++;
    if (Math.abs(a.height[i] - b.height[i]) > 1 || a.water[i] !== b.water[i]) moved++;
  }
  return Math.round((moved / Math.max(1, land)) * 1000) / 1000;
}

interface ArmResult {
  arm: string;
  seed: number;
  surveyMs: number;
  opportunityMs: number;
  classifyMs?: number;
  provinces?: number;
  snapshotBytes?: number;
  provinceMapBytes?: number;
  geologyHash?: string;
  metrics: OpportunityReport["metrics"];
  visibleTableMetrics?: OpportunityReport["metrics"];
  bridge: OpportunityReport["bridge"];
  sites: OpportunityReport["sites"];
  routes: Array<{ cost: number; lengthM: number; maxGrade: number; overlapWithFirst: number }>;
  editChangedShare: number;
  editDescription: string;
}

function main(): void {
  const specFile = path.resolve(arg("spec", "worlds/default.world.json"));
  const seeds = arg("seeds", "7,11,23").split(",").map(Number);
  const out = path.resolve(arg("out", "geology-compare"));
  fs.mkdirSync(out, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(specFile, "utf8")) as Record<string, unknown> & { volcano?: Record<string, unknown> };
  raw.volcano = { ...(raw.volcano ?? {}), count: 0 };
  const baseSpec = parseWorldSpec(raw);
  const b = worldBounds(baseSpec);
  const results: ArmResult[] = [];

  const run = (spec: WorldSpec, arm: string, seed: number): { s: Survey; r: OpportunityReport; surveyMs: number; oppMs: number } => {
    const t0 = performance.now();
    const s = surveyWorld(spec);
    const t1 = performance.now();
    const r = findOpportunities(s, { seed, spawn: spawnPoint(spec, s) });
    const t2 = performance.now();
    const img = drawGeologyMap(s, r);
    fs.writeFileSync(path.join(out, `${arm}-${seed}.png`), png(img.width, img.height, img.rgb));
    return { s, r, surveyMs: Math.round(t1 - t0), oppMs: Math.round(t2 - t1) };
  };

  for (const seed of seeds) {
    // Same land, climate and erosion for both arms: only the macro relief differs.
    const spec = parseWorldSpec({ ...raw, seed });
    const base = run(spec, "baseline", seed);
    const moved = parseWorldSpec({
      ...raw,
      seed,
      ranges: { ...(raw.ranges as object), center: { x: (spec.ranges.center?.x ?? 0) + 250, z: spec.ranges.center?.z ?? 0 } },
    });
    const baseEdit = surveyWorld(moved);
    results.push({
      arm: "baseline",
      seed,
      surveyMs: base.surveyMs,
      opportunityMs: base.oppMs,
      metrics: base.r.metrics,
      bridge: base.r.bridge,
      sites: base.r.sites,
      routes: base.r.routes.map(({ points: _p, ...rest }) => rest),
      editChangedShare: changedShare(base.s, baseEdit),
      editDescription: "move the range centre 250 m east",
    });

    const geology = generateGeologySpec({ seed, min: b.min, max: b.max });
    const geoSpec = parseWorldSpec({ ...raw, seed, geology });
    const geo = run(geoSpec, "geology", seed);
    const grid = coarseGrid(geoSpec);
    const tc = performance.now();
    classifyGeology(geology, grid, (salt, scale) => noiseField(grid, fieldSeed(geology.seed, 900 + salt), scale));
    const classifyMs = Math.round(performance.now() - tc);
    const visibleT = findOpportunities(geo.s, { seed, spawn: spawnPoint(geoSpec, geo.s), table: VISIBLE_RESOURCE_TABLE });
    const imgH = drawGeologyMap(geo.s, visibleT);
    fs.writeFileSync(path.join(out, `geology-visible-table-${seed}.png`), png(imgH.width, imgH.height, imgH.rgb));
    // Local fix: retag the largest orogen province as platform (a designer
    // flattening one belt), applied as an override at its centroid.
    const largestOrogen = geo.s.geology!.provinces.filter((p) => p.kind === "orogen").sort((p, q) => q.cells - p.cells)[0];
    const edited: GeologySpec = largestOrogen
      ? { ...geology, overrides: [{ at: { x: largestOrogen.x, z: largestOrogen.z }, kind: "platform" }] }
      : geology;
    const geoEdit = surveyWorld(parseWorldSpec({ ...raw, seed, geology: edited }));
    const editImg = drawGeologyMap(geoEdit, null);
    fs.writeFileSync(path.join(out, `geology-edit-${seed}.png`), png(editImg.width, editImg.height, editImg.rgb));
    results.push({
      arm: "geology",
      seed,
      surveyMs: geo.surveyMs,
      opportunityMs: geo.oppMs,
      classifyMs,
      provinces: geo.s.geology!.provinces.length,
      snapshotBytes: Buffer.byteLength(JSON.stringify(geology)),
      provinceMapBytes: geo.s.geology!.province.byteLength,
      geologyHash: geo.s.geology!.hash,
      metrics: geo.r.metrics,
      visibleTableMetrics: visibleT.metrics,
      bridge: geo.r.bridge,
      sites: geo.r.sites,
      routes: geo.r.routes.map(({ points: _p, ...rest }) => rest),
      editChangedShare: changedShare(geo.s, geoEdit),
      editDescription: largestOrogen ? `retag province ${largestOrogen.id} (orogen, ${Math.round(largestOrogen.areaM2 / 1e4)} ha) as platform` : "none",
    });
    console.log(`[geology:compare] seed ${seed}: baseline ${base.surveyMs} ms, geology ${geo.surveyMs} ms`);
  }

  fs.writeFileSync(path.join(out, "compare.json"), JSON.stringify({ spec: path.basename(specFile), seeds, results }, null, 1));
  const rows: Array<[string, (r: ArmResult) => string]> = [
    ["survey ms", (r) => String(r.surveyMs)],
    ["geology classify ms / provinces", (r) => (r.classifyMs !== undefined ? `${r.classifyMs} / ${r.provinces}` : "n/a")],
    ["snapshot JSON bytes", (r) => (r.snapshotBytes !== undefined ? String(r.snapshotBytes) : "n/a")],
    ["opportunity pass ms", (r) => String(r.opportunityMs)],
    ["landform regions (≥0.5% land)", (r) => String(r.metrics.landformRegions)],
    ["land share in 6 largest regions", (r) => r.metrics.topSixLandShare.toFixed(2)],
    ["landmarks (peaks ≥40 m proud)", (r) => String(r.metrics.landmarks)],
    ["macro coherence (≥400 m variance share)", (r) => r.metrics.macroCoherence.toFixed(2)],
    ["viable settlement sites", (r) => String(r.metrics.viableSites)],
    ["viable routes between the pair", (r) => String(r.metrics.viableRoutes)],
    ["bridge saving", (r) => (r.bridge ? `${Math.round(r.bridge.saving * 100)}% (${r.bridge.spanM} m span)` : "none")],
    ["route exists without bridge", (r) => (r.metrics.routeWithoutBridge ? "yes" : "NO")],
    ["survey advantage (hidden-province table, default)", (r) => r.metrics.surveyAdvantage.toFixed(2)],
    ["survey advantage (visible-province table)", (r) => (r.visibleTableMetrics ? r.visibleTableMetrics.surveyAdvantage.toFixed(2) : "n/a")],
    ["max share of a resource in one region", (r) => r.metrics.maxProvinceShare.toFixed(2)],
    ["starter ore / fuel within 600 m of spawn", (r) => `${r.metrics.starterOre} / ${r.metrics.starterFuel}`],
    ["land changed by a local edit", (r) => `${Math.round(r.editChangedShare * 1000) / 10}%`],
  ];
  const header = `| signal | ${results.map((r) => `${r.arm} ${r.seed}`).join(" | ")} |\n|---|${results.map(() => "---").join("|")}|\n`;
  const body = rows.map(([name, f]) => `| ${name} | ${results.map(f).join(" | ")} |`).join("\n");
  fs.writeFileSync(path.join(out, "compare.md"), header + body + "\n");
  console.log(header + body);
}

main();
