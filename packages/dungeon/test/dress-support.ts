/**
 * Shared by the dressing suites: the dungeons they dress and the dressings they compare against.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { BUILTIN_DRESSING, type Dressing, BUILTIN_THEMES, dressDungeon, generateDungeon, type Dungeon, type DungeonDressing } from "../src/index.js";

export const make = (seed: number, theme: string, rooms = 34): Dungeon =>
  generateDungeon({ seed, rooms, loopChance: 0.2, decorDensity: 0.5, theme }, BUILTIN_THEMES[theme]);

export const cases: [number, string, number][] = [];
for (const theme of Object.keys(BUILTIN_THEMES)) for (const rank of [1, 3, 5]) cases.push([rank * 101 + theme.length, theme, rank]);

/** The dressing with every line scattered: what dressing did before arrangements. */
export const scatterOnly = (d: Dressing): Dressing => ({
  ...d,
  archetypes: Object.fromEntries(Object.entries(d.archetypes).map(([id, a]) => [id, { ...a, contents: a.contents.map((k) => ({ ...k, arrange: "scatter" as const })) }])),
});
/** The built-in dressing as part A shipped it, every line scattered (a frozen fixture: the pinned hashes below are of its output). */
export const PART_A_DRESSING = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/dressing-part-a.json", import.meta.url)), "utf8")) as Dressing;
export const digest = (x: DungeonDressing): string => createHash("sha256").update(JSON.stringify(x.props)).digest("hex").slice(0, 16);

export const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
export const dressed = (theme: string, rank: number, dressing: Dressing = BUILTIN_DRESSING) => seeds.map((seed) => {
  const d = make(seed, theme);
  return { d, x: dressDungeon(d, dressing, rank) };
});
