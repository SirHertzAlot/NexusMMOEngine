/**
 * Baking a pool of unique dungeons: N layouts from one base seed, each
 * written as <id>.dungeon.json with an index.json listing the pool. A bake
 * adds to the pool already in the folder; a layout already in it (same
 * content hash) is skipped and another seed tried, so every dungeon in the
 * pool is unique. The same options on an empty folder always bake the
 * same pool. Each dungeon can be dressed (dress.ts) and populated
 * (populate.ts) as it is baked, at a rank picked per dungeon.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { encodeDungeon, layoutHash } from "./format.js";
import { generateDungeon } from "./generate.js";
import { deriveSeed } from "./rng.js";
import { autoTheme, type Themes } from "./themes.js";
import { dressDungeon } from "./dress.js";
import type { Dressing } from "./dressing.js";
import { populateDungeon } from "./populate.js";
import type { Roster } from "@mmo-engine/species";

export const INDEX_FORMAT = "mmo-dungeon-index/1";

export interface BakeOptions {
  /** How many new dungeons to add. */
  count: number;
  /** Base seed: each dungeon's seed is derived from it. */
  seed: number;
  /** A theme id, or "auto" (picked per dungeon from its seed). */
  theme: string;
  /** Room count range, inclusive. */
  rooms: [number, number];
  loopChance: number;
  decorDensity: number;
  themes: Themes;
  out: string;
  /** Remove the pool already in `out` first. */
  fresh?: boolean;
  /** Dress each dungeon (room archetypes, contents, resource veins) at a rank in this range; omit to leave them bare. */
  dress?: { dressing: Dressing; rank: [number, number] };
  /** Populate each dungeon from a roster (which species holds each room), at the dressing's rank, else one in `rank` (default 1). */
  populate?: { roster: Roster; rank?: [number, number] };
}

export interface IndexEntry {
  id: string;
  file: string;
  hash: string;
  name: string;
  theme: string;
  seed: number;
  rooms: number;
  /** The dressing's rank (absent: not dressed). */
  rank?: number;
  /** Resource veins in its walls. */
  veins?: number;
  /** The species leading the boss room (absent: not populated). */
  boss?: string;
  /** Spawn points given a species. */
  dwellers?: number;
  floorTiles: number;
  width: number;
  height: number;
}

export interface DungeonIndex {
  format: typeof INDEX_FORMAT;
  dungeons: IndexEntry[];
}

export function readIndex(out: string): DungeonIndex {
  const file = join(out, "index.json");
  if (!existsSync(file)) return { format: INDEX_FORMAT, dungeons: [] };
  const index = JSON.parse(readFileSync(file, "utf8")) as DungeonIndex;
  if (index.format !== INDEX_FORMAT) throw new Error(`${file}: not a ${INDEX_FORMAT} index`);
  return index;
}

export interface BakeResult {
  added: IndexEntry[];
  /** Seeds tried that gave a layout already in the pool. */
  duplicates: number;
  /** Seeds that couldn't make a connected dungeon. */
  failed: number;
  index: DungeonIndex;
}

export function bakeDungeons(o: BakeOptions): BakeResult {
  if (o.theme !== "auto" && !o.themes[o.theme]) throw new Error(`no theme "${o.theme}" (have: auto, ${Object.keys(o.themes).join(", ")})`);
  if (o.fresh && existsSync(o.out)) {
    for (const f of readdirSync(o.out)) if (f.endsWith(".dungeon.json") || f.endsWith(".png") || f === "index.json") rmSync(join(o.out, f));
  }
  mkdirSync(o.out, { recursive: true });
  const index = readIndex(o.out);
  const known = new Set(index.dungeons.map((d) => d.hash));
  const added: IndexEntry[] = [];
  let duplicates = 0, failed = 0;
  const [minRooms, maxRooms] = o.rooms;
  // Pick up where earlier bakes from this base seed left off.
  let k = index.dungeons.length;
  const limit = k + o.count * 20;
  while (added.length < o.count && k < limit) {
    const seed = deriveSeed(o.seed, k++);
    const rooms = minRooms + (deriveSeed(seed, 0x524f4f4d) % (maxRooms - minRooms + 1));
    const theme = o.theme === "auto" ? autoTheme(seed, o.themes) : o.theme;
    const d = generateDungeon({ seed, rooms, loopChance: o.loopChance, decorDensity: o.decorDensity, theme }, o.themes[theme]);
    if (!d.valid) { failed++; continue; }
    const hash = layoutHash(d);
    if (known.has(hash)) { duplicates++; continue; }
    known.add(hash);
    const [r0, r1] = o.dress?.rank ?? o.populate?.rank ?? [1, 1];
    const rank = r0 + (deriveSeed(seed, 0x52414e4b) % (r1 - r0 + 1));
    const dressing = o.dress ? dressDungeon(d, o.dress.dressing, rank, deriveSeed(seed, 0x44524553)) : undefined;
    const population = o.populate ? populateDungeon(d, o.populate.roster, rank, dressing?.archetypes ?? null, deriveSeed(seed, 0x504f5055)) : undefined;
    const f = encodeDungeon(d, dressing, population);
    const file = `${f.id}.dungeon.json`;
    writeFileSync(join(o.out, file), JSON.stringify(f));
    const entry: IndexEntry = {
      id: f.id, file, hash, name: d.name, theme, seed: d.seed, rooms,
      ...(dressing || population ? { rank } : {}),
      ...(dressing ? { veins: dressing.resources.length } : {}),
      ...(population ? { boss: population.rooms[d.boss] || undefined, dwellers: population.spawns.length } : {}),
      floorTiles: d.stats.floorTiles, width: d.width, height: d.height,
    };
    index.dungeons.push(entry);
    added.push(entry);
  }
  writeFileSync(join(o.out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  if (added.length < o.count) throw new Error(`baked only ${added.length} of ${o.count} unique dungeons (${duplicates} duplicates, ${failed} unconnected)`);
  return { added, duplicates, failed, index };
}
