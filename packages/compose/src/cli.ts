#!/usr/bin/env node
/**
 * npm run loot:bake -- --size 10000
 *
 * Bakes the loot pool (see loot.ts) into $MMO_DATA_DIR/loot, else
 * packages/engine-core/data/loot (git-ignored, next to the baked world):
 *
 *   pool.jsonl     one composed item a line (id, rank, source, item, seed, bundle)
 *   report.json    counts by rank and source, materials, hours to obtain
 *   report.md      the same as tables, to tune from
 *
 * Options:
 *   --size <n>          items in the pool (default 10000)
 *   --seed <u32>        base seed (default 1: the same pool every time)
 *   --ranks <file>      a rank ladder (names, or full ranks)
 *   --catalog <file>    add or replace item bases and components
 *   --held <file>       items players hold (JSON lines or an array of pool
 *                       items, e.g. the world server's record): kept as they are
 *   --out <dir>         where to write
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bakeLootPool, reportMarkdown, type PoolItem } from "./loot.js";
import { loadCatalog, loadLadder } from "./load.js";

const OPTIONS = ["size", "seed", "ranks", "catalog", "held", "out"] as const;
type Option = (typeof OPTIONS)[number];

export function readOptions(argv: string[], env: NodeJS.ProcessEnv): Partial<Record<Option, string>> {
  const out: Partial<Record<Option, string>> = {};
  for (const name of OPTIONS) {
    const v = env[`npm_config_${name}`];
    if (v !== undefined && v !== "" && v !== "true") out[name] = v;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      // `npm run loot:bake --size 500` reaches us as a lone 500.
      if (/^\d+$/.test(a) && out.size === undefined) {
        out.size = a;
        continue;
      }
      throw new Error(`unexpected argument "${a}"`);
    }
    const [key, inline] = a.slice(2).split("=", 2);
    if (!(OPTIONS as readonly string[]).includes(key)) throw new Error(`unknown option --${key} (have: ${OPTIONS.map((o) => `--${o}`).join(" ")})`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    out[key as Option] = value;
  }
  return out;
}

function readHeld(file: string): PoolItem[] {
  const text = readFileSync(file, "utf8").trim();
  if (!text) return [];
  return text.startsWith("[") ? (JSON.parse(text) as PoolItem[]) : text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PoolItem);
}

function main(): void {
  const o = readOptions(process.argv.slice(2), process.env);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = o.out ? resolve(o.out) : process.env.MMO_DATA_DIR ? join(resolve(process.env.MMO_DATA_DIR), "loot") : resolve(here, "../../../engine-core/data/loot");
  const size = Number(o.size ?? 10000);
  const seed = Number(o.seed ?? 1) >>> 0;
  const ladder = loadLadder(o.ranks);
  const t0 = performance.now();
  const pool = bakeLootPool({ size, seed, ladder, catalog: loadCatalog(o.catalog), held: o.held ? readHeld(o.held) : [] });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "pool.jsonl"), pool.items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  writeFileSync(join(out, "report.json"), JSON.stringify(pool.report, null, 2) + "\n");
  writeFileSync(join(out, "report.md"), reportMarkdown(pool.report, ladder));
  const counts = ladder.ranks.map((r) => `${r.id} ${pool.report.byRank[r.id].count}`).join(", ");
  console.log(`[loot:bake] ${pool.items.length} items in ${((performance.now() - t0) / 1000).toFixed(1)} s (${counts}) -> ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[loot:bake] ${(e as Error).message}`);
    process.exit(1);
  }
}
