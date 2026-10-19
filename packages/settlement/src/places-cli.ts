#!/usr/bin/env node
/**
 * npm run settlement:places -- --world <spec> [--scenes <dir>] [--out <file>] [--seed <n>] [--homesteads <per town>] [--rules <file>]
 *
 * Plans the routes between the baked towns and the places along them and between them (guard outposts, inns beside
 * the outposts, shacks, camp sites, homesteads), roadmap SG7/SG8. The towns are read from the root node of each
 * `settlement-*.scene.json` in the scenes folder. Writes `places.json` beside the settlement manifests
 * (MMO_SETTLEMENT_OUT) unless --out says otherwise, and `places.scene.json` into the scenes folder (MMO_SCENE=places). The spacings and counts are the `places` section of the settlement
 * rules file (content/settlements/rules.json, or --rules), the same file the towns read; --homesteads overrides the per-town count. The engine must be built; the survey takes several seconds.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fromUser, settlementPaths } from "./paths.js";
import { DEFAULT_PLACE_RULES, planPlaces, type PlaceTown } from "./places.js";
import { placesScene } from "./places-scene.js";
import { defaultRules, loadRules } from "./rules.js";
import type { TerrainFields } from "./sites.js";

/** The towns whose scenes are in `dir`, by the root node's position. */
export function readTowns(dir: string): PlaceTown[] {
  const towns: PlaceTown[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^settlement-(.+)\.scene\.json$/.exec(f);
    if (!m) continue;
    const p = (JSON.parse(readFileSync(join(dir, f), "utf8")) as { nodes?: { transform?: { position?: number[] } }[] }).nodes?.[0]?.transform?.position;
    if (Array.isArray(p) && p.length >= 3) towns.push({ id: m[1]!, x: p[0]!, z: p[2]! });
  }
  return towns;
}

async function main(): Promise<void> {
  const { values: o } = parseArgs({ options: { world: { type: "string" }, scenes: { type: "string" }, out: { type: "string" }, seed: { type: "string" }, homesteads: { type: "string" }, rules: { type: "string" } } });
  if (!o.world) throw new Error("--world <file> is required");
  const paths = settlementPaths();
  const scenes = o.scenes ? fromUser(o.scenes) : paths.scenes;
  const towns = readTowns(scenes);
  if (!towns.length) throw new Error(`no settlement-*.scene.json in ${scenes}: bake the towns first`);
  const here = dirname(fileURLToPath(import.meta.url));
  const terrain = pathToFileURL(resolve(here, "../../../engine-core/dist/src/terrain")).href;
  const { surveyWorld } = (await import(`${terrain}/survey.js`)) as { surveyWorld(spec: unknown): TerrainFields };
  const { loadWorldSpec } = (await import(`${terrain}/world-spec.js`)) as { loadWorldSpec(file: string): { seed: number; biomes: { id: string }[] } };
  const spec = loadWorldSpec(fromUser(o.world));
  const survey = surveyWorld(spec);
  // The places rules are the `places` section of the settlement rules file (the one the towns read), else the defaults.
  const town = o.rules ? loadRules(fromUser(o.rules)) : defaultRules(paths.rules);
  const base = town.places ?? DEFAULT_PLACE_RULES;
  const perTown = o.homesteads === undefined ? base.homesteads.perTown : Number(o.homesteads);
  if (!Number.isInteger(perTown) || perTown < 0) throw new Error("--homesteads must be a whole number (0 for none)");
  const rules = { ...base, homesteads: { ...base.homesteads, perTown } };
  const seed = (o.seed === undefined ? spec.seed : Number(o.seed)) >>> 0;
  const plan = planPlaces({ towns, terrain: { ...survey, biomeIds: spec.biomes.map((b) => b.id) }, seed, rules, rulesVersion: town.version });
  const out = o.out ? fromUser(o.out) : resolve(paths.settlements, "places.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  // The scene the server spawns them from (MMO_SCENE=places), beside the towns' scenes.
  const sceneFile = resolve(scenes, "places.scene.json");
  writeFileSync(sceneFile, `${JSON.stringify(placesScene(plan), null, 2)}\n`);
  const c = plan.counts;
  console.log(`[settlement:places] ${towns.length} towns, ${plan.routes.length} routes (${Math.round(plan.routes.reduce((n, r) => n + r.lengthM, 0) / 1000)} km): ${c.guard_outpost} guard outposts, ${c.inn} inns, ${c.shack} shacks, ${c.camp_site} camp sites, ${c.homestead} homesteads -> ${out}, scene ${sceneFile}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: Error) => {
    console.error(`[settlement:places] ${e.message}`);
    process.exit(1);
  });
}
