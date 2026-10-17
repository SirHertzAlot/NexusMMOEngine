#!/usr/bin/env node
/**
 * npm run settlement:bake -- --population 600 --seed 1234 --id 0182
 *
 * Bakes one settlement into <out>/<id>.settlement.json (default
 * content/settlements). Options:
 *
 *   --population <n>   people to settle (default 600)
 *   --seed <u32>       world seed (default 1)
 *   --id <name>        the settlement's id (default 0001)
 *   --rules <file>     replace the built-in rules (same shape as BUILTIN_RULES)
 *   --out <dir>        output folder
 *   --scene            also write content/scenes/settlement-<id>.scene.json, which
 *                      the server spawns with MMO_SCENE=settlement-<id>
 *   --origin <x,z>     where the town's centre goes in the world, metres (default 0,0)
 *   --world <file>     a world spec (engine-core/worlds/default.world.json): survey it
 *                      and place the town at its best site (the engine must be built;
 *                      the survey takes several seconds)
 *   --site <rank>      with --world, which site, best first (default 1)
 *   --access <a>       how the town is reached: port | river | road | remote (caps its size and sets its
 *                      density; with --world, read off the site unless given)
 *   --catalog <file>   with --scene, an art catalog (assets/catalog.json): each structure
 *                      names a matching model; the scene stays a box where none matches.
 *                      The names go into the scene file, so keep it out of git (the
 *                      default scenes folder holds only what you commit)
 *   --scale <file>     a scale doc (content/scale.json): parcels and streets are baked at its building factor
 *   --verbosity <v>   silent | summary | normal | verbose | debug (default summary)
 */

import { dirname, resolve } from "node:path";
import { fromUser, settlementPaths } from "./paths.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildArtMap, DEFAULT_ART_PATTERNS, DEFAULT_PROP_PATTERNS, type CatalogModel } from "./art.js";
import { bakeSettlement } from "./bake.js";
import { VERBOSITY, type Verbosity } from "./events.js";
import { ACCESS, BUILTIN_RULES, loadRules, type Access, type SettlementRules } from "./rules.js";
import { siteAccess } from "./setting.js";
import type { Land } from "./industry.js";
import { townHalfExtentM } from "./layout.js";
import { resolveScale, validateScale, type ScaleDoc } from "@mmo-engine/scene";
import { selectSites, type Site, type TerrainFields } from "./sites.js";

async function main(): Promise<void> {
  const { values: o } = parseArgs({
    options: { population: { type: "string" }, seed: { type: "string" }, id: { type: "string" }, rules: { type: "string" }, out: { type: "string" }, scenes: { type: "string" }, verbosity: { type: "string" }, scene: { type: "boolean" }, origin: { type: "string" }, world: { type: "string" }, site: { type: "string" }, catalog: { type: "string" }, scale: { type: "string" }, access: { type: "string" } },
  });
  const verbosity = (o.verbosity ?? "summary") as Verbosity;
  if (!VERBOSITY.includes(verbosity)) throw new Error(`--verbosity must be one of ${VERBOSITY.join(", ")}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const paths = settlementPaths();
  const out = o.out ? fromUser(o.out) : paths.settlements;
  let origin = (o.origin ?? "0,0").split(",").map(Number);
  if (o.access && !ACCESS.includes(o.access as Access)) throw new Error(`--access must be one of ${ACCESS.join(", ")}`);
  let access = o.access as Access | undefined;
  /** The world's dryness test at a point (with --world): parcels that are not dry are dropped from the town. */
  let dry: ((x: number, z: number) => boolean) | undefined;
  /** The land around the site (with --world): the town's industry reads it. */
  let land: Land | undefined;
  if (o.world) {
    const rules = o.rules ? loadRules(fromUser(o.rules)) : BUILTIN_RULES;
    const households = Math.round((Number(o.population ?? 600) * 10) / rules.demographics.householdSizeX10);
    const buildingScale = o.scale ? resolveScale(JSON.parse(readFileSync(fromUser(o.scale), "utf8")) as ScaleDoc, "building") : 1;
    const extent = townHalfExtentM(households, rules, buildingScale);
    const found = await findSites(fromUser(o.world), here, rules, extent);
    dry = found.dry;
    const site = found.sites[Number(o.site ?? 1) - 1];
    if (!site) throw new Error(`--site ${o.site ?? 1}: the world has fewer sites`);
    origin = [site.x, site.z];
    access ??= siteAccess(site, rules);
    land = { biomes: site.biomes, waterKind: site.waterKind, shoreM: site.shoreM };
    console.log(`  [site] ${o.site ?? 1}: (${Math.round(site.x)}, ${Math.round(site.z)}) ${access}, pressure ${site.pressurePermille}, ${site.waterKind} ${site.waterDistanceM} m, walk ${site.walkM} m, elevation ${site.elevationM} m, relief ${site.reliefM} m over a ${Math.round(2 * extent)} m town, ${site.biome}; land ${Object.entries(site.biomes).map(([b, n]) => `${b} ${n}`).join(", ")}`);
  }
  if (origin.length !== 2 || origin.some((n) => !Number.isFinite(n))) throw new Error("--origin must be x,z in metres (for example 120,-300)");
  let art: Record<string, string[]> | undefined;
  if (o.catalog) {
    const models = (JSON.parse(readFileSync(fromUser(o.catalog), "utf8")) as { models: CatalogModel[] }).models;
    art = { ...buildArtMap(models, DEFAULT_ART_PATTERNS), ...buildArtMap(models, DEFAULT_PROP_PATTERNS, "i") };
    console.log(`  [art] ${Object.keys(art).length} of ${Object.keys(DEFAULT_ART_PATTERNS).length + Object.keys(DEFAULT_PROP_PATTERNS).length} kinds have models: ${Object.entries(art).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
  }
  let scale = 1;
  if (o.scale) {
    const doc = JSON.parse(readFileSync(fromUser(o.scale), "utf8")) as unknown;
    const issues = validateScale(doc);
    if (issues.length) throw new Error(`--scale: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
    scale = resolveScale(doc as ScaleDoc, "building");
    console.log(`  [scale] building factor ${scale}`);
  }
  const r = bakeSettlement(
    { settlementId: o.id ?? "0001", seed: Number(o.seed ?? 1) >>> 0, population: Number(o.population ?? 600), ...(access ? { access } : {}), ...(land ? { land } : {}), rules: o.rules ? loadRules(fromUser(o.rules)) : BUILTIN_RULES, scale, verbosity, ...(dry ? { site: { origin: [origin[0]!, origin[1]!] as [number, number], dry } } : {}) },
    out,
    o.scene ? { scene: { dir: o.scenes ? fromUser(o.scenes) : paths.scenes, origin: [origin[0]!, origin[1]!], ...(art ? { art } : {}) } } : {},
  );
  for (const e of r.events) console.log(`  [${e.stage}] ${e.event} ${JSON.stringify(e.data)}`);
  if (!r.ok) throw new Error(`${r.error.stage}: ${r.error.message}`);
  const m = r.manifest;
  console.log(`[settlement:bake] ${m.settlementId}: ${m.demographics.population} people, ${m.parcels.length} parcels, ${m.structures.length} structures, hash ${m.hash.slice(0, 12)} -> ${r.file}`);
}

/** The world's sites, best first (the survey from the built engine-core, read by selectSites), and its dryness test: a point is dry when its survey cell is land the safe floor (structure margin plus detail noise) above the sea, and no lake or river. */
export async function findSites(worldFile: string, here: string, rules: SettlementRules, extentM: number): Promise<{ sites: Site[]; dry: (x: number, z: number) => boolean }> {
  const terrain = pathToFileURL(resolve(here, "../../../engine-core/dist/src/terrain")).href;
  const { surveyWorld } = (await import(`${terrain}/survey.js`)) as { surveyWorld(spec: unknown): TerrainFields & { spec: { biomes: { id: string }[] } } };
  const { loadWorldSpec } = (await import(`${terrain}/world-spec.js`)) as { loadWorldSpec(file: string): { biomes: { id: string }[] } };
  const spec = loadWorldSpec(worldFile);
  const survey = surveyWorld(spec);
  const { spawnPoint } = (await import(`${terrain}/world-bake.js`)) as { spawnPoint(spec: unknown, survey: unknown): { x: number; z: number } };
  // Sites must be walkable from where players spawn.
  const { STRUCTURE_MARGIN_M } = (await import(pathToFileURL(resolve(here, "../../../engine-core/dist/src/procgen/habitat.js")).href)) as { STRUCTURE_MARGIN_M: number };
  // The stored tiles are the survey plus detail noise of at most `detailAmplitude` metres (world-heights.ts); the spawner wants
  // STRUCTURE_MARGIN_M of dry footing under every footprint sample, so the survey must show that much plus the noise.
  const safeFloorM = STRUCTURE_MARGIN_M + (spec as unknown as { detailAmplitude: number }).detailAmplitude;
  const fields = { ...survey, biomeIds: spec.biomes.map((b) => b.id), spawn: spawnPoint(spec, survey), safeFloorM };
  const g = survey.grid;
  const sea = survey.seaLevel ?? 0;
  const dry = (x: number, z: number): boolean => {
    const u = Math.round((x - g.originX) / g.cell);
    const v = Math.round((z - g.originZ) / g.cell);
    if (u < 0 || v < 0 || u >= g.width || v >= g.depth) return false;
    const i = v * g.width + u;
    return !survey.water[i] && !survey.river[i] && survey.height[i]! >= sea + safeFloorM;
  };
  return { sites: selectSites(fields, rules.sites, 20, extentM), dry };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: Error) => {
    console.error(`[settlement:bake] ${e.message}`);
    process.exit(1);
  });
}
