/**
 * Balancing backwards from top gear (docs/DUNGEONS-AND-LOOT.md §7):
 *
 * 1. Top gear first: compose every item type at the top rank and read its
 *    recipe: which materials does the best gear need?
 * 2. Materials: every one needs a source a player can reach (a world biome,
 *    a dungeon vein that exists, a creature kind that exists), and every
 *    dungeon vein should feed some recipe.
 * 3. Supply: gathering hours per recipe from a gather rate per tier; each
 *    rank should cost more than the one below.
 * 4. The pool: the loot pool's items, crafted, as a report by rank.
 */

import { BUILTIN_CATALOG, composeItem, DEFAULT_LADDER, type Catalog, type Ladder, type PoolItem } from "@mmo-engine/compose/browser";
import { BUILTIN_MATERIALS, isTradable, type Material } from "./materials.js";
import { recipeFor, type Recipe } from "./recipes.js";

/** Units a player gathers in an hour, by material tier (tune these). */
export const DEFAULT_GATHER_PER_HOUR: Record<number, number> = { 1: 40, 2: 20, 3: 8, 4: 3, 5: 1 };

export function gatherHours(r: Recipe, materials: Record<string, Material> = BUILTIN_MATERIALS, perHour = DEFAULT_GATHER_PER_HOUR): number {
  let h = 0;
  for (const [raw, n] of Object.entries(r.inputs)) h += n / (perHour[materials[raw].tier] ?? 1);
  return Math.round(h * 100) / 100;
}

export interface World {
  /** Dungeon vein ids that exist (the dungeon dressing's). */
  veins: readonly string[];
  /** Creature kinds that exist (species kinds, plus any boss-only ones). */
  creatureKinds: readonly string[];
  /** World biome ids. */
  biomes: readonly string[];
}

/** Every problem with the materials against the world: unreachable materials, veins that feed nothing. */
export function materialProblems(world: World, materials: Record<string, Material> = BUILTIN_MATERIALS, used?: ReadonlySet<string>): string[] {
  const p: string[] = [];
  for (const [id, m] of Object.entries(materials)) {
    const reachable = m.sources.some((s) =>
      s.kind === "world" ? s.biomes.some((b) => world.biomes.includes(b)) : s.kind === "vein" ? world.veins.includes(s.vein) : s.from.some((k) => world.creatureKinds.includes(k)),
    );
    if (!reachable) p.push(`${id}: no reachable source (${m.sources.map((s) => (s.kind === "world" ? `biomes ${s.biomes}` : s.kind === "vein" ? `vein ${s.vein}` : `drops from ${s.from}`)).join("; ")})`);
    if (used && !used.has(id)) p.push(`${id}: no recipe uses it`);
  }
  for (const v of world.veins) {
    if (!Object.values(materials).some((m) => m.sources.some((s) => s.kind === "vein" && s.vein === v))) p.push(`vein ${v}: yields no material`);
  }
  return p;
}

export interface TopGear {
  /** Raw material → average quantity per top-rank item. */
  needs: Record<string, number>;
  recipes: Recipe[];
}

/** What top-rank gear needs: every item type composed at the top rank, `seeds` times each. */
export function topGearNeeds(o: { catalog?: Catalog; ladder?: Ladder; seeds?: number; materials?: Record<string, Material> } = {}): TopGear {
  const catalog = o.catalog ?? BUILTIN_CATALOG;
  const ladder = o.ladder ?? DEFAULT_LADDER;
  const top = ladder.ranks[ladder.ranks.length - 1].id;
  const recipes: Recipe[] = [];
  for (const item of Object.keys(catalog.items)) {
    for (let seed = 1; seed <= (o.seeds ?? 6); seed++) recipes.push(recipeFor(composeItem(item, top, { catalog, ladder, seed }).bundle, { catalog, ladder, materials: o.materials }));
  }
  const needs: Record<string, number> = {};
  for (const r of recipes) for (const [raw, n] of Object.entries(r.inputs)) needs[raw] = (needs[raw] ?? 0) + n / recipes.length;
  for (const k of Object.keys(needs)) needs[k] = Math.round(needs[k] * 100) / 100;
  return { needs, recipes };
}

export interface CraftReport {
  byRank: Record<string, { items: number; meanHours: number; maxTier: number; skills: Record<string, number>; inputs: Record<string, number>; tradableShare: number }>;
  /** Ranks that don't cost more than the rank below. */
  problems: string[];
}

/** The pool's items as recipes, summarised by rank. */
export function craftReport(items: readonly PoolItem[], o: { catalog?: Catalog; ladder?: Ladder; materials?: Record<string, Material>; perHour?: Record<number, number> } = {}): CraftReport {
  const ladder = o.ladder ?? DEFAULT_LADDER;
  const materials = o.materials ?? BUILTIN_MATERIALS;
  const byRank: CraftReport["byRank"] = {};
  for (const r of ladder.ranks) byRank[r.id] = { items: 0, meanHours: 0, maxTier: 0, skills: {}, inputs: {}, tradableShare: 0 };
  const tradable = new Map<string, number>();
  for (const it of items) {
    const recipe = recipeFor(it.bundle, { catalog: o.catalog, ladder, materials });
    const b = byRank[it.rank];
    b.items++;
    b.meanHours += gatherHours(recipe, materials, o.perHour);
    b.maxTier = Math.max(b.maxTier, recipe.tier);
    b.skills[recipe.skill] = (b.skills[recipe.skill] ?? 0) + 1;
    for (const [raw, n] of Object.entries(recipe.inputs)) b.inputs[raw] = (b.inputs[raw] ?? 0) + n;
    if (Object.keys(recipe.inputs).every((raw) => isTradable(materials[raw]))) tradable.set(it.rank, (tradable.get(it.rank) ?? 0) + 1);
  }
  const problems: string[] = [];
  let prev: { id: string; hours: number } | null = null;
  for (const r of ladder.ranks) {
    const b = byRank[r.id];
    if (b.items) {
      b.meanHours = Math.round((b.meanHours / b.items) * 100) / 100;
      b.tradableShare = Math.round(((tradable.get(r.id) ?? 0) / b.items) * 100) / 100;
      if (prev && b.meanHours <= prev.hours) problems.push(`${r.id}: ${b.meanHours} h to gather, not more than ${prev.id}'s ${prev.hours} h`);
      prev = { id: r.id, hours: b.meanHours };
    }
  }
  return { byRank, problems };
}

export function craftReportMarkdown(r: CraftReport, top: TopGear, problems: string[], ladder: Ladder = DEFAULT_LADDER): string {
  const lines = [
    "# Crafting balance",
    "",
    "## Top gear needs (per top-rank item, averaged over every item type)",
    "",
    ...Object.entries(top.needs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## By rank (the loot pool's items, crafted)",
    "",
    "| Rank | Items | Mean gather hours | Highest material tier | All inputs tradable | Skills |",
    "|---|---|---|---|---|---|",
  ];
  for (const rank of ladder.ranks) {
    const b = r.byRank[rank.id];
    if (!b?.items) continue;
    lines.push(`| ${rank.name} | ${b.items} | ${b.meanHours} | ${b.maxTier} | ${Math.round(b.tradableShare * 100)}% | ${Object.entries(b.skills).map(([s, n]) => `${s} ${n}`).join(", ")} |`);
  }
  const all = [...problems, ...r.problems];
  lines.push("", "## Problems", "", ...(all.length ? all.map((p) => `- ${p}`) : ["None."]));
  return lines.join("\n") + "\n";
}
