#!/usr/bin/env node
/**
 * npm run dungeon:bake -- --n 10
 *
 * Bakes N unique dungeons into the dungeon pool (default
 * $MMO_DATA_DIR/dungeons, else packages/engine-core/data/dungeons, next to
 * the baked world). `npm run dungeon:bake --n 10` works too: npm keeps
 * `--n` for itself and passes the 10 on, and a lone number is the count.
 * Options:
 *
 *   --n <count>            new dungeons to add (default 10)
 *   --seed <u32|random>    base seed (default 1: the same pool every time)
 *   --theme <id|auto>      auto picks per dungeon (default auto)
 *   --rooms <n|min-max>    rooms per dungeon (default 20-48)
 *   --loops <0..1>         share of extra links beyond the spanning tree (default 0.15)
 *   --decor <0..1>         dressing density (default 0.6)
 *   --themes <file.json>   add or replace themes
 *   --out <dir>            the pool folder
 *   --fresh                remove the existing pool first
 *   --png                  also write a top-down map (<id>.png) of each new dungeon
 *   --rank <n|min-max>     dress each dungeon at a rank (default 1-5: room
 *                          archetypes, their contents, resource veins)
 *   --dressing <file.json> add or replace archetypes and veins
 *   --bare                 don't dress (layouts only)
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { bakeDungeons } from "./bake.js";
import { decodeDungeon, type DungeonFile } from "./format.js";
import { dungeonPng } from "./preview.js";
import { loadThemes } from "./themes.js";
import { loadDressing } from "./dressing.js";

const OPTIONS = ["n", "seed", "theme", "rooms", "loops", "decor", "themes", "out", "fresh", "png", "rank", "dressing", "bare"] as const;
const FLAGS: readonly string[] = ["fresh", "png", "bare"];
type Option = (typeof OPTIONS)[number];

/**
 * Options from argv (`--n 10`, `--n=10`, or a lone count: `npm run
 * dungeon:bake --n 10` reaches us as `10`, npm having taken `--n`), and
 * from npm config for options npm took with their value (npm_config_seed=7).
 */
export function readOptions(argv: string[], env: NodeJS.ProcessEnv): Partial<Record<Option, string>> {
  const out: Partial<Record<Option, string>> = {};
  for (const name of OPTIONS) {
    const npm = env[`npm_config_${name}`];
    // "true" is npm reading `--n 10` as a bare flag; the 10 arrives in argv.
    if (npm !== undefined && npm !== "" && (npm !== "true" || FLAGS.includes(name))) out[name] = npm;
  }
  let lone = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (lone || !/^\d+$/.test(a)) throw new Error(`unexpected argument "${a}" (the count is --n <count>)`);
      out.n = a;
      lone = true;
      continue;
    }
    const [key, inline] = a.slice(2).split("=", 2);
    if (!(OPTIONS as readonly string[]).includes(key)) throw new Error(`unknown option --${key} (have: ${OPTIONS.map((o) => `--${o}`).join(" ")})`);
    if (FLAGS.includes(key)) { out[key as Option] = inline ?? "true"; continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    out[key as Option] = value;
  }
  return out;
}

function num(name: string, v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number in [${min}, ${max}] (got "${v}")`);
  return n;
}

function main(): void {
  const o = readOptions(process.argv.slice(2), process.env);
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultOut = process.env.MMO_DATA_DIR ? join(resolve(process.env.MMO_DATA_DIR), "dungeons") : resolve(here, "../../../engine-core/data/dungeons");
  const count = num("n", o.n, 10, 1, 100000);
  if (!Number.isInteger(count)) throw new Error(`--n must be a whole number (got "${o.n}")`);
  const seed = o.seed === "random" ? (Math.random() * 2 ** 32) >>> 0 : num("seed", o.seed, 1, 0, 2 ** 32 - 1) >>> 0;
  const roomsText = o.rooms ?? "20-48";
  const m = /^(\d+)(?:-(\d+))?$/.exec(roomsText);
  const rooms: [number, number] = m ? [Number(m[1]), Number(m[2] ?? m[1])] : [NaN, NaN];
  if (!(rooms[0] >= 3 && rooms[1] >= rooms[0] && rooms[1] <= 200)) throw new Error(`--rooms must be a count or min-max within 3-200 (got "${roomsText}")`);
  const out = o.out ? resolve(o.out) : defaultOut;
  const rankText = o.rank ?? "1-5";
  const rm = /^(\d+)(?:-(\d+))?$/.exec(rankText);
  const rank: [number, number] = rm ? [Number(rm[1]), Number(rm[2] ?? rm[1])] : [NaN, NaN];
  if (!(rank[0] >= 1 && rank[1] >= rank[0] && rank[1] <= 99)) throw new Error(`--rank must be a rank or min-max, from 1 (got "${rankText}")`);
  const bare = o.bare !== undefined && o.bare !== "false";
  const t0 = performance.now();
  const r = bakeDungeons({
    count, seed, rooms, out,
    theme: o.theme ?? "auto",
    loopChance: num("loops", o.loops, 0.15, 0, 1),
    decorDensity: num("decor", o.decor, 0.6, 0, 1),
    themes: loadThemes(o.themes),
    fresh: o.fresh !== undefined && o.fresh !== "false",
    ...(bare ? {} : { dress: { dressing: loadDressing(o.dressing), rank } }),
  });
  if (o.png !== undefined && o.png !== "false") {
    for (const d of r.added) {
      const file = JSON.parse(readFileSync(join(out, d.file), "utf8")) as DungeonFile;
      writeFileSync(join(out, `${d.id}.png`), dungeonPng(decodeDungeon(file), 4, file.dressing));
    }
  }
  for (const d of r.added) {
    const dressed = d.rank !== undefined ? `, rank ${d.rank}, ${d.veins} veins` : "";
    console.log(`  ${d.id}  ${d.name}  (${d.rooms} rooms${dressed}, ${d.floorTiles} tiles, ${d.width}x${d.height})`);
  }
  console.log(
    `[dungeon:bake] ${r.added.length} new dungeon(s) in ${((performance.now() - t0) / 1000).toFixed(1)} s; the pool holds ${r.index.dungeons.length} ` +
      `(${out})${r.duplicates ? `; ${r.duplicates} duplicate layout(s) skipped` : ""}${r.failed ? `; ${r.failed} unconnected seed(s) skipped` : ""}; base seed ${seed}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[dungeon:bake] ${(e as Error).message}`);
    process.exit(1);
  }
}
