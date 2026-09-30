#!/usr/bin/env node
/**
 * npm run craft:report [-- --loot <dir>]
 *
 * Balances crafting backwards from top gear against the world and the loot
 * pool (baked by `npm run loot:bake`), writing craft-report.md and
 * craft-report.json next to the pool. Exits 1 when there are problems
 * (unreachable materials, veins that feed nothing, ranks that don't cost
 * more than the rank below).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS } from "@mmo-engine/species";
import { BUILTIN_DRESSING } from "@mmo-engine/dungeon";
import type { PoolItem } from "@mmo-engine/compose";
import { craftReport, craftReportMarkdown, materialProblems, topGearNeeds } from "./balance.js";
import { recipeFor } from "./recipes.js";

/** The default world's biomes (packages/engine-core/worlds/default.world.json). */
const BIOMES = ["sea", "lake", "volcanic", "glacier", "snow", "mountains", "tundra", "beach", "swamp", "desert", "rainforest", "forest", "plains"];

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--loot");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = at >= 0 ? resolve(args[at + 1]) : process.env.MMO_DATA_DIR ? join(resolve(process.env.MMO_DATA_DIR), "loot") : resolve(here, "../../../engine-core/data/loot");
  const poolFile = join(dir, "pool.jsonl");
  const items: PoolItem[] = existsSync(poolFile)
    ? readFileSync(poolFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PoolItem)
    : [];
  const top = topGearNeeds();
  // Used anywhere: by top gear or by any item in the pool.
  const used = new Set([...top.recipes, ...items.map((i) => recipeFor(i.bundle))].flatMap((r) => Object.keys(r.inputs)));
  const world = { veins: Object.keys(BUILTIN_DRESSING.veins), creatureKinds: [...KINDS, "dragon"], biomes: BIOMES };
  const problems = materialProblems(world, undefined, used);
  const report = craftReport(items);
  writeFileSync(join(dir, "craft-report.json"), JSON.stringify({ top: top.needs, report, problems }, null, 2) + "\n");
  writeFileSync(join(dir, "craft-report.md"), craftReportMarkdown(report, top, problems));
  const all = [...problems, ...report.problems];
  console.log(`[craft:report] ${items.length} pool items${items.length ? "" : " (no pool: run npm run loot:bake first)"}, ${all.length} problem(s) -> ${join(dir, "craft-report.md")}`);
  for (const p of all) console.log(`  ${p}`);
  if (all.length) process.exit(1);
}

main();
