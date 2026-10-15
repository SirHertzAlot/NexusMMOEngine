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
 *   --verbosity <v>    silent | summary | normal | verbose | debug (default summary)
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bakeSettlement } from "./bake.js";
import { VERBOSITY, type Verbosity } from "./events.js";
import { BUILTIN_RULES, loadRules } from "./rules.js";

function main(): void {
  const { values: o } = parseArgs({
    options: { population: { type: "string" }, seed: { type: "string" }, id: { type: "string" }, rules: { type: "string" }, out: { type: "string" }, verbosity: { type: "string" }, scene: { type: "boolean" }, origin: { type: "string" } },
  });
  const verbosity = (o.verbosity ?? "summary") as Verbosity;
  if (!VERBOSITY.includes(verbosity)) throw new Error(`--verbosity must be one of ${VERBOSITY.join(", ")}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = o.out ? resolve(o.out) : resolve(here, "../../../content/settlements");
  const origin = (o.origin ?? "0,0").split(",").map(Number);
  if (origin.length !== 2 || origin.some((n) => !Number.isFinite(n))) throw new Error("--origin must be x,z in metres (for example 120,-300)");
  const r = bakeSettlement(
    { settlementId: o.id ?? "0001", seed: Number(o.seed ?? 1) >>> 0, population: Number(o.population ?? 600), rules: o.rules ? loadRules(resolve(o.rules)) : BUILTIN_RULES, verbosity },
    out,
    o.scene ? { scene: { dir: resolve(here, "../../../content/scenes"), origin: [origin[0]!, origin[1]!] } } : {},
  );
  for (const e of r.events) console.log(`  [${e.stage}] ${e.event} ${JSON.stringify(e.data)}`);
  if (!r.ok) throw new Error(`${r.error.stage}: ${r.error.message}`);
  const m = r.manifest;
  console.log(`[settlement:bake] ${m.settlementId}: ${m.demographics.population} people, ${m.parcels.length} parcels, ${m.structures.length} structures, hash ${m.hash.slice(0, 12)} -> ${r.file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[settlement:bake] ${(e as Error).message}`);
    process.exit(1);
  }
}
