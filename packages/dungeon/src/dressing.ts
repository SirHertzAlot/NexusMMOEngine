/**
 * Dressing data: what a dungeon's rooms can be, what each kind of room
 * holds, and the resource veins in its walls. The engine ships our game's
 * set; a game adds or replaces archetypes and veins with a JSON file of the
 * same shape (`loadDressing`).
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

const ROLES = ["entrance", "combat", "elite", "treasure", "shrine", "boss"] as const;
const WHERE = ["floor", "centre", "wall", "corner"] as const;
/** How a content line's items are laid out in the room (dress.ts): scatter is each on its own, the rest are patterns (arrange.ts). */
export const ARRANGEMENTS = ["scatter", "row", "grid", "flank", "beside", "ring", "line", "before", "behind", "head", "over", "corners", "colonnade", "cluster"] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];
/** Patterns that stand round another line's item. */
const NEEDS_ANCHOR: readonly Arrangement[] = ["flank", "beside", "ring", "before", "behind", "over", "cluster"];

export const ContentSchema = z.strictObject({
  /** What it is (the renderer maps kinds to art). */
  kind: z.string().min(1),
  where: z.enum(WHERE),
  /** Footprint radius, cells. */
  radius: z.number().positive(),
  /** How many, [min, max]. */
  count: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  /** Hung on the wall surface (a banner, a vein) rather than standing against it. */
  mount: z.boolean().default(false),
  /** Only in dungeons of at least this rank. */
  minRank: z.number().int().min(1).default(1),
  /** Whether bodies are blocked by it: "solid" (a round collider of its radius) or "none" (walk-through). Default: solid, none when mounted. */
  collision: z.enum(["solid", "none"]).optional(),
  /** How the items are laid out: scatter (each on its own, the default), a row along a wall, a grid, flanking or beside the anchor's item, a ring round it. */
  arrange: z.enum(ARRANGEMENTS).default("scatter"),
  /** Which way the pattern's items face: toward the room's centre or the anchor ("room", "anchor"), or away ("out"). Default: the pattern's own. */
  faces: z.enum(["room", "anchor", "out"]).optional(),
  /** The `kind` of another line of the same archetype that flank, beside and ring stand round (and a grid may face). */
  anchor: z.string().min(1).optional(),
  /** Cells left between neighbours in a pattern. */
  gap: z.number().min(0).default(0.3),
  /** Half-length along the item's facing, cells (default: `radius`, a round item). `radius` is then its lateral half-width: a coffin is slim (`radius`) and long (`reach`). */
  reach: z.number().positive().optional(),
  /** For `line` / `colonnade`: cells off the centreline of the room's long axis (default 0 for line, 2.2 for colonnade). */
  at: z.number().optional(),
  /** For `grid`: the width, in cells, of an aisle kept free down the middle of the grid. */
  aisle: z.number().min(0).optional(),
});

export const ArchetypeSchema = z.strictObject({
  /** Room roles it can dress. */
  roles: z.array(z.enum(ROLES)).min(1),
  /** Themes it belongs to (default: all). */
  themes: z.array(z.string()).optional(),
  weight: z.number().positive().default(1),
  /** Smallest room side, cells. */
  minSize: z.number().int().min(0).default(0),
  /** At most this many per dungeon. */
  max: z.number().int().min(0).optional(),
  /** May sit beside another room of the same archetype. */
  repeatable: z.boolean().default(false),
  /** Never beside these archetypes. */
  avoid: z.array(z.string()).default([]),
  /** Needs at least one of these beside it (a storeroom by a barracks). */
  near: z.array(z.string()).default([]),
  contents: z.array(ContentSchema).default([]),
  /** The share of the room's floor the inventory may fill (default 0.6): dense rooms (a crypt, a library) raise it. */
  fill: z.number().min(0.1).max(0.9).optional(),
});

export const VeinSchema = z.strictObject({
  weight: z.number().positive().default(1),
  /** The resource tier it yields (1 common … 5 legendary). */
  tier: z.number().int().min(1).max(5),
  /** Only in dungeons of at least this rank. */
  minRank: z.number().int().min(1).default(1),
  /** Only from this far in (room difficulty, 0 at the entrance to 1 at the boss). */
  minDepth: z.number().min(0).max(1).default(0),
  /** Themes that favour it (weight × themeBoost there). */
  themes: z.array(z.string()).default([]),
  themeBoost: z.number().positive().default(3),
});

export const DressingSchema = z.strictObject({
  archetypes: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), ArchetypeSchema),
  veins: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), VeinSchema),
  /** Chance a (non-entrance) room carries a vein seam, at rank 1; rises with rank. */
  veinRooms: z.number().min(0).max(1).default(0.25),
  /** Extra seam chance per rank above 1. */
  veinRoomsPerRank: z.number().min(0).max(1).default(0.08),
  /** Veins in a seam, [min, max]; a larger room and a higher rank reach the max. */
  seam: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([2, 6]),
});

export type Content = z.infer<typeof ContentSchema>;
export type Archetype = z.infer<typeof ArchetypeSchema>;
export type Vein = z.infer<typeof VeinSchema>;
export type Dressing = z.infer<typeof DressingSchema>;

const c = (kind: string, where: (typeof WHERE)[number], radius: number, count: [number, number], extra: Partial<Content> = {}): Content => ({
  kind, where, radius, count, mount: false, minRank: 1, arrange: "scatter", gap: 0.3, ...extra, collision: extra.collision ?? (extra.mount ? "none" : "solid"),
});
const flat: Partial<Content> = { collision: "none" };
const a = (roles: Archetype["roles"], contents: Content[], extra: Partial<Archetype> = {}): Archetype => ({
  roles, weight: 1, minSize: 0, repeatable: false, avoid: [], near: [], contents, ...extra,
});

/** Our game's dressing: real-world architectural zoning with axial symmetry, paired furniture, flush wall stations, and balanced corner lighting. */
export const BUILTIN_DRESSING: Dressing = {
  archetypes: {
    gatehall: a(["entrance"], [
      c("carpet", "floor", 0.3, [2, 5], { ...flat, arrange: "line", reach: 0.9, gap: 0 }),
      c("statue", "wall", 0.4, [2, 4], { arrange: "colonnade", at: 2.0, gap: 1.4 }),
      c("brazier", "corner", 0.3, [2, 4], { arrange: "corners", gap: 0.6 }),
      c("sword-rack", "wall", 0.35, [0, 2], { reach: 0.15 }),
      c("banner", "wall", 0.4, [2, 4], { arrange: "row", mount: true, gap: 1 }),
    ]),
    throne: a(["boss"], [
      c("throne", "wall", 0.5, [1, 1], { arrange: "head" }),
      c("carpet", "floor", 0.3, [3, 6], { ...flat, arrange: "line", reach: 0.9, gap: 0 }),
      c("pillar", "floor", 0.3, [3, 6], { arrange: "line", at: 2.6, gap: 1.2 }),
      c("pillar", "floor", 0.3, [3, 6], { arrange: "line", at: -2.6, gap: 1.2 }),
      c("statue", "wall", 0.4, [2, 4], { arrange: "flank", anchor: "throne" }),
      c("brazier", "corner", 0.3, [2, 4], { arrange: "corners", gap: 0.6 }),
      c("banner", "wall", 0.4, [3, 8], { arrange: "row", mount: true, gap: 1.2 }),
    ]),
    vault: a(["treasure"], [
      c("carpet", "floor", 0.3, [2, 4], { ...flat, arrange: "line", reach: 0.9, gap: 0 }),
      c("chest", "wall", 0.23, [4, 12], { arrange: "row", reach: 0.14, gap: 0.08 }),
      c("coin-pile", "floor", 0.25, [0, 1], { ...flat, arrange: "before", anchor: "chest", gap: 0.1 }),
      c("gilded-chest", "wall", 0.23, [1, 3], { arrange: "row", reach: 0.14, gap: 0.08, minRank: 3 }),
      c("statue", "wall", 0.4, [1, 2], { arrange: "head" }),
      c("candle-stand", "corner", 0.15, [2, 4], { arrange: "corners", gap: 0.5 }),
    ], { repeatable: true, fill: 0.65 }),
    chapel: a(["shrine"], [
      c("statue-large", "wall", 0.5, [1, 1], { arrange: "head" }),
      c("altar", "floor", 0.5, [1, 1], { arrange: "before", anchor: "statue-large", reach: 0.25, gap: 0.15 }),
      c("candle-stand", "floor", 0.15, [2, 2], { arrange: "flank", anchor: "altar", gap: 0.1 }),
      c("carpet", "floor", 0.3, [2, 5], { ...flat, arrange: "line", reach: 0.9, gap: 0 }),
      c("pew", "floor", 0.45, [6, 20], { arrange: "grid", faces: "anchor", anchor: "altar", reach: 0.13, gap: 0.35, aisle: 1.6 }),
      c("painting", "wall", 0.35, [2, 6], { arrange: "row", mount: true, gap: 0.4 }),
      c("pulpit", "wall", 0.25, [0, 1]),
      c("reliquary", "wall", 0.3, [0, 1], { minRank: 2 }),
      c("candles", "corner", 0.2, [2, 4], { ...flat, arrange: "corners" }),
    ], { repeatable: true, fill: 0.65 }),
    crypt: a(["combat", "elite"], [
      // A catacomb: the walls are lined with coffins in niches, two tiers high, with symmetrical corner candle-stands and urns.
      c("wall-coffin", "wall", 0.3, [10, 22], { arrange: "row", mount: true, gap: 0.1 }),
      c("wall-coffin-high", "wall", 0.3, [10, 22], { arrange: "over", mount: true, anchor: "wall-coffin" }),
      c("candle-stand", "corner", 0.15, [2, 4], { arrange: "corners", gap: 0.5 }),
      c("urn", "corner", 0.2, [2, 4], { arrange: "corners", gap: 0.5 }),
      c("bone-pile", "corner", 0.3, [1, 3], flat),
    ], { themes: ["grim", "ancient", "frost"], minSize: 7, weight: 2, fill: 0.5 }),
    tomb: a(["combat", "elite"], [
      // A grand tomb: one great sarcophagus on its dais in the middle, ringed by candles and statues.
      c("grand-sarcophagus", "centre", 0.6, [1, 1], { reach: 0.9 }),
      c("candle-stand", "floor", 0.15, [4, 6], { arrange: "ring", anchor: "grand-sarcophagus", gap: 0.4 }),
      c("statue", "floor", 0.4, [6, 8], { arrange: "ring", anchor: "grand-sarcophagus", gap: 1.2 }),
      c("statue-large", "wall", 0.5, [0, 1], { arrange: "head" }),
      c("brazier", "corner", 0.3, [2, 4], { arrange: "corners", gap: 0.6 }),
      c("urn", "corner", 0.2, [2, 4], { arrange: "corners", gap: 0.5 }),
      c("banner", "wall", 0.4, [3, 6], { arrange: "row", mount: true, gap: 1 }),
    ], { themes: ["grim", "ancient", "frost"], minSize: 8, max: 1, weight: 1.2, fill: 0.6 }),
    armoury: a(["combat", "elite"], [
      c("sword-rack", "wall", 0.35, [2, 5], { arrange: "row", reach: 0.15, gap: 0.1 }),
      c("spear-rack", "wall", 0.35, [2, 4], { arrange: "row", reach: 0.15, gap: 0.1 }),
      c("bow-rack", "wall", 0.3, [1, 3], { arrange: "row", reach: 0.15, gap: 0.1 }),
      c("shield-rack", "wall", 0.3, [1, 3], { arrange: "row", reach: 0.25, gap: 0.1 }),
      c("armour-stand", "wall", 0.22, [3, 8], { arrange: "row", gap: 0.1 }),
      c("shield-wall", "wall", 0.4, [1, 4], { arrange: "row", mount: true, gap: 0.3 }),
      c("workbench", "wall", 0.4, [1, 1], { reach: 0.25 }),
      c("crate", "corner", 0.22, [1, 3], { arrange: "corners", gap: 0.3 }),
      c("barrel", "corner", 0.2, [1, 2], { arrange: "cluster", anchor: "crate", gap: 0.1 }),
    ], { max: 2, minSize: 6, fill: 0.7 }),
    barracks: a(["combat"], [
      c("bunk-bed", "wall", 0.25, [6, 16], { arrange: "row", reach: 0.5, gap: 0.1 }),
      c("footlocker", "floor", 0.2, [0, 1], { arrange: "before", anchor: "bunk-bed", reach: 0.13, gap: 0.1 }),
      c("gear-locker", "wall", 0.18, [3, 6], { arrange: "row", reach: 0.14, gap: 0.05 }),
      c("long-table", "centre", 0.8, [0, 1], { reach: 0.25 }),
      c("bench", "floor", 0.45, [0, 1], { arrange: "before", anchor: "long-table", reach: 0.1, gap: 0.1 }),
      c("bench", "floor", 0.45, [0, 1], { arrange: "behind", anchor: "long-table", reach: 0.1, gap: 0.1 }),
      c("sword-rack", "wall", 0.35, [1, 3], { reach: 0.15 }),
      c("armour-stand", "wall", 0.22, [1, 3]),
      c("barrel", "corner", 0.2, [1, 3], { arrange: "corners", gap: 0.4 }),
    ], { minSize: 7, repeatable: true, fill: 0.7 }),
    storeroom: a(["combat"], [
      c("crate", "wall", 0.22, [10, 24], { arrange: "row", reach: 0.22, gap: 0.05 }),
      c("barrel", "wall", 0.2, [6, 14], { arrange: "row", gap: 0.05 }),
      c("bookshelf", "wall", 0.3, [2, 6], { arrange: "row", reach: 0.12, gap: 0.05 }),
      c("sack", "floor", 0.2, [4, 10], { ...flat, arrange: "cluster", anchor: "barrel", gap: 0.08 }),
    ], { near: ["barracks", "armoury"], weight: 1.5, fill: 0.7 }),
    library: a(["combat", "elite"], [
      c("bookshelf-tall", "wall", 0.35, [6, 16], { arrange: "row", reach: 0.13, gap: 0.05 }),
      c("bookshelf", "wall", 0.3, [2, 6], { arrange: "row", reach: 0.12, gap: 0.05 }),
      c("reading-table", "floor", 0.45, [3, 9], { arrange: "grid", reach: 0.25, gap: 0.55 }),
      c("bench", "floor", 0.45, [0, 1], { arrange: "before", anchor: "reading-table", reach: 0.1, gap: 0.1 }),
      c("bench", "floor", 0.45, [0, 1], { arrange: "behind", anchor: "reading-table", reach: 0.1, gap: 0.1 }),
      c("lectern", "floor", 0.18, [1, 2], { arrange: "flank", anchor: "reading-table", gap: 0.35 }),
      c("scroll-rack", "wall", 0.3, [1, 3], { arrange: "row", reach: 0.13 }),
      c("painting", "wall", 0.35, [2, 6], { arrange: "row", mount: true, gap: 0.4 }),
      c("candle-stand", "corner", 0.15, [2, 4], { arrange: "corners", gap: 0.5 }),
    ], { themes: ["ancient", "verdant", "frost"], max: 1, minSize: 8, avoid: ["forge", "ritual"], fill: 0.7 }),
    ritual: a(["elite", "combat"], [
      c("ritual-circle", "centre", 1.4, [1, 1]),
      c("candles", "corner", 0.2, [4, 8], { ...flat, arrange: "ring", anchor: "ritual-circle" }),
      c("altar", "wall", 0.5, [1, 1], { arrange: "head", reach: 0.25 }),
      c("cauldron", "floor", 0.3, [1, 2], { arrange: "flank", anchor: "altar", gap: 0.4 }),
      c("lectern", "floor", 0.18, [1, 2], { arrange: "before", anchor: "altar", gap: 0.4 }),
      c("cage", "wall", 0.3, [2, 5], { arrange: "row", reach: 0.3 }),
      c("bone-pile", "corner", 0.3, [1, 3], flat),
      c("candle-stand", "corner", 0.15, [2, 4], { arrange: "corners", gap: 0.5 }),
    ], { themes: ["grim", "molten", "ancient"], max: 2, minSize: 8, avoid: ["library", "chapel"], fill: 0.6 }),
    forge: a(["combat", "elite"], [
      c("smelter", "wall", 0.45, [1, 1], { arrange: "head" }),
      c("anvil", "floor", 0.35, [1, 3], { arrange: "beside", anchor: "smelter" }),
      c("quench-trough", "wall", 0.35, [1, 2], { reach: 0.2 }),
      c("coal-bin", "corner", 0.3, [1, 3], { arrange: "corners", gap: 0.4 }),
      c("tool-rack", "wall", 0.35, [1, 3], { arrange: "row", reach: 0.1 }),
      c("workbench", "wall", 0.4, [1, 2], { reach: 0.25 }),
      c("crate", "corner", 0.22, [1, 2], { arrange: "cluster", anchor: "coal-bin", gap: 0.15 }),
    ], { themes: ["molten"], max: 2, minSize: 7, weight: 2, fill: 0.65 }),
    jail: a(["combat", "elite"], [
      c("jail-cell", "wall", 0.5, [6, 16], { arrange: "row", reach: 0.5, gap: 0.05 }),
      c("guard-desk", "wall", 0.45, [1, 1], { arrange: "head", reach: 0.23 }),
      c("key-rack", "wall", 0.3, [1, 1], { arrange: "row", mount: true }),
      c("stocks", "wall", 0.3, [0, 1], { reach: 0.2, minRank: 3 }),
      c("brazier", "corner", 0.3, [2, 4], { arrange: "corners", gap: 0.5 }),
      c("bone-pile", "corner", 0.3, [1, 3], flat),
      c("barrel", "corner", 0.2, [1, 2], { arrange: "corners", gap: 0.4 }),
    ], { minSize: 8, max: 2, weight: 1.2, fill: 0.7 }),
    messhall: a(["combat"], [
      c("hearth", "wall", 0.6, [1, 1], { arrange: "head", reach: 0.35 }),
      c("long-table", "floor", 0.8, [3, 8], { arrange: "grid", reach: 0.25, gap: 0.65 }),
      c("bench", "floor", 0.45, [0, 1], { arrange: "before", anchor: "long-table", reach: 0.1, gap: 0.1 }),
      c("bench", "floor", 0.45, [0, 1], { arrange: "behind", anchor: "long-table", reach: 0.1, gap: 0.1 }),
      c("serving-counter", "wall", 0.7, [1, 1], { reach: 0.25 }),
      c("barrel", "corner", 0.2, [2, 4], { arrange: "corners", gap: 0.4 }),
      c("sack", "floor", 0.2, [1, 3], { ...flat, arrange: "cluster", anchor: "barrel", gap: 0.1 }),
    ], { minSize: 8, max: 2, fill: 0.6 }),
    grotto: a(["combat"], [
      c("root-knot", "wall", 0.35, [2, 5]),
      c("mushrooms", "floor", 0.25, [5, 12], { ...flat, arrange: "cluster", anchor: "root-knot", gap: 0.2 }),
      c("pillar", "floor", 0.3, [2, 4], { arrange: "colonnade", at: 2.0, gap: 1.6 }),
      c("urn", "corner", 0.2, [1, 3], { arrange: "corners", gap: 0.5 }),
    ], { themes: ["verdant"], repeatable: true, weight: 2, fill: 0.55 }),
    icehall: a(["combat", "elite"], [
      c("ice-pillar", "floor", 0.3, [4, 8], { arrange: "colonnade", at: 2.1, gap: 1.4 }),
      c("brazier", "corner", 0.3, [2, 4], { arrange: "corners", gap: 0.6 }),
      c("statue", "wall", 0.4, [1, 2], { arrange: "head" }),
      c("frozen-body", "wall", 0.35, [1, 3], flat),
    ], { themes: ["frost"], repeatable: true, fill: 0.55 }),
    hall: a(["combat", "elite"], [
      c("carpet", "floor", 0.3, [2, 5], { ...flat, arrange: "line", reach: 0.9, gap: 0 }),
      c("pillar", "floor", 0.3, [4, 6], { arrange: "colonnade", at: 2.2, gap: 1.4 }),
      c("statue", "wall", 0.4, [1, 3], { arrange: "head" }),
      c("brazier", "corner", 0.3, [2, 4], { arrange: "corners", gap: 0.6 }),
      c("banner", "wall", 0.4, [2, 4], { arrange: "row", mount: true, gap: 1.2 }),
      c("rubble", "floor", 0.3, [2, 5], flat),
    ], { repeatable: true, weight: 0.4, fill: 0.55 }),
  },
  veins: {
    "iron-seam": { weight: 3, tier: 1, minRank: 1, minDepth: 0, themes: [], themeBoost: 3 },
    "gold-vein": { weight: 2, tier: 2, minRank: 2, minDepth: 0.2, themes: ["ancient"], themeBoost: 2 },
    "elemental-crystal": { weight: 2, tier: 3, minRank: 2, minDepth: 0.3, themes: ["molten", "frost"], themeBoost: 3 },
    "enchanted-ore": { weight: 1.5, tier: 3, minRank: 3, minDepth: 0.4, themes: ["verdant", "ancient"], themeBoost: 2 },
    "exotic-ore": { weight: 1, tier: 4, minRank: 4, minDepth: 0.55, themes: ["molten"], themeBoost: 2 },
    "rune-stone": { weight: 0.6, tier: 5, minRank: 5, minDepth: 0.7, themes: ["grim", "ancient"], themeBoost: 2 },
  },
  veinRooms: 0.25,
  veinRoomsPerRank: 0.08,
  seam: [2, 6],
};

/** Our dressing with a game's file merged over it (archetypes and veins by id). Throws with every problem listed. */
export function loadDressing(file?: string): Dressing {
  if (!file) return BUILTIN_DRESSING;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const parsed = DressingSchema.partial().safeParse(raw);
  if (!parsed.success) throw new Error(`${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const merged: Dressing = {
    ...BUILTIN_DRESSING,
    ...parsed.data,
    archetypes: { ...BUILTIN_DRESSING.archetypes, ...(parsed.data.archetypes ?? {}) },
    veins: { ...BUILTIN_DRESSING.veins, ...(parsed.data.veins ?? {}) },
  };
  const problems: string[] = [];
  for (const [id, arch] of Object.entries(merged.archetypes)) {
    for (const other of [...arch.avoid, ...arch.near]) if (!merged.archetypes[other]) problems.push(`archetypes.${id}: no archetype "${other}"`);
    arch.contents.forEach((k, i) => {
      if (k.count[0] > k.count[1]) problems.push(`archetypes.${id}.contents[${i}]: count min above max`);
      if (NEEDS_ANCHOR.includes(k.arrange) && !k.anchor) problems.push(`archetypes.${id}.contents[${i}]: arrange "${k.arrange}" needs an anchor`);
      if (k.mount && k.arrange !== "scatter" && k.arrange !== "row" && k.arrange !== "over") problems.push(`archetypes.${id}.contents[${i}]: a mounted line can only be a row or over (or scatter)`);
      if (k.anchor && !arch.contents.some((o, j) => j !== i && o.kind === k.anchor)) problems.push(`archetypes.${id}.contents[${i}]: anchor "${k.anchor}" is not another kind in ${id}`);
    });
  }
  if (problems.length) throw new Error(`${file}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return merged;
}
