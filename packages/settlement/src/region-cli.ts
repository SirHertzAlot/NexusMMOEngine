#!/usr/bin/env node
/**
 * npm run settlement:region -- --world packages/engine-core/worlds/default.world.json --years 100
 *
 * Plans the world's towns as a region: each site's access, industry and size, what the towns trade with each other,
 * and how they change as they work their land over the years. Writes the snapshots and what happened to <out>
 * (default content/settlements/region.json). Options:
 *
 *   --world <file>   a world spec (the engine must be built; the survey takes several seconds)
 *   --years <n>      how many years to run it on (default 100)
 *   --every <n>      a snapshot every this many years (default 25)
 *   --population <n> the town size the sites must have room for (default 600; bigger towns need fewer, roomier sites)
 *   --rules <file>   replace the built-in rules
 *   --out <file>     where to write the region
 *
 * Bake one of its towns as it stands with `settlement:bake -- --world <file> --site <rank>` (year 0), or from code
 * with `regionTownRequest(snapshot, townId)` passed to generateSettlement.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findSites } from "./cli.js";
import { townHalfExtentM } from "./layout.js";
import { fromUser, settlementPaths } from "./paths.js";
import { evolveRegion, planRegion } from "./region.js";
import { defaultRules, loadRules } from "./rules.js";

async function main(): Promise<void> {
  const { values: o } = parseArgs({ options: { world: { type: "string" }, years: { type: "string" }, every: { type: "string" }, population: { type: "string" }, rules: { type: "string" }, out: { type: "string" } } });
  if (!o.world) throw new Error("--world <file> is required");
  const rules = o.rules ? loadRules(fromUser(o.rules)) : defaultRules(settlementPaths().rules);
  const years = Number(o.years ?? 100);
  const every = Number(o.every ?? 25);
  if (!Number.isInteger(years) || years < 0 || !Number.isInteger(every) || every < 1) throw new Error("--years and --every must be whole numbers (every at least 1)");
  const here = dirname(fileURLToPath(import.meta.url));
  const extent = townHalfExtentM(Math.round((Number(o.population ?? 600) * 10) / rules.demographics.householdSizeX10), rules, 1);
  const { sites } = await findSites(fromUser(o.world), here, rules, extent);
  const start = planRegion(sites, rules);
  const { snapshots, events } = evolveRegion(start, years, rules, every);
  for (const t of start.towns) console.log(`  [town] ${t.id} (${t.x}, ${t.z}) ${t.access}, ${t.industry?.primary ?? "no industry"}${t.industry?.product ? `, known for ${t.industry.product.export}` : ""}: ${t.population} people`);
  for (const r of start.trade.routes) console.log(`  [trade] ${r.loads} loads of ${r.product} (${r.good}) ${r.from} -> ${r.to}, ${r.km} km by ${r.by}, ${r.price} copper a load`);
  for (const e of events) console.log(`  [year ${e.year}] ${e.town} ${e.what}`);
  const last = snapshots[snapshots.length - 1]!;
  console.log(`  [year ${last.year}] ${last.towns.map((t) => `${t.id} ${t.industry?.primary ?? "-"} ${t.population} ${t.trend}`).join("; ")}`);
  const out = o.out ? fromUser(o.out) : resolve(settlementPaths().settlements, "region.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ rulesVersion: rules.version, years, every, snapshots, events }, null, 2)}\n`);
  console.log(`[settlement:region] ${start.towns.length} towns, ${start.trade.routes.length} trade routes, ${events.length} events over ${years} years -> ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: Error) => {
    console.error(`[settlement:region] ${e.message}`);
    process.exit(1);
  });
}
