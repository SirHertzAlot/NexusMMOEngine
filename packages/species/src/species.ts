/**
 * Species: who lives in the world and where, as data (docs/DUNGEONS-AND-LOOT.md §4).
 *
 *  - kind: organic (goblins, orcs, trolls: living needs, the open world),
 *    beast, undead and otherworldly (mostly dungeons), demon (manifests
 *    only in dungeons, where emotion and lifeforce are to be had);
 *  - habitat: how well each open-world biome suits it, and which dungeon
 *    themes and depths it haunts;
 *  - what keeps it alive, how many come together, which spawn tiers it
 *    can fill (1 rank and file, 3 elite), the lowest dungeon rank it
 *    appears at, and room archetypes that draw it (a ritual chamber, for
 *    a demon).
 *
 * The engine ships our game's roster; a game adds or replaces species with
 * a JSON file of the same shape (`loadSpecies`).
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

export const KINDS = ["organic", "beast", "undead", "demon", "otherworldly"] as const;
export type Kind = (typeof KINDS)[number];

export const SUSTENANCE = ["food", "water", "rest", "emotion", "lifeforce", "necromancy", "none"] as const;

const weights = z.record(z.string(), z.number().min(0));

export const SpeciesSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(KINDS),
  tags: z.array(z.string()).default([]),
  habitat: z
    .strictObject({
      /** Biome id -> how well it suits (0 or absent: never there). */
      world: weights.default({}),
      /** Where it lives underground. */
      dungeon: z
        .strictObject({
          /** Dungeon theme id -> weight. */
          themes: weights,
          /** Room difficulty range it lives at (0 entrance … 1 boss). */
          depth: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0, 1]),
        })
        .optional(),
    })
    .prefault({}),
  /** What keeps it alive (drives behaviour and where it gathers). */
  sustenance: z.array(z.enum(SUSTENANCE)).min(1),
  /** How many come together, [min, max]. */
  pack: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([1, 1]),
  /** Spawn tiers it can fill, [min, max] of 1 (rank and file) … 3 (elite). */
  tier: z.tuple([z.number().int().min(1).max(3), z.number().int().min(1).max(3)]).default([1, 3]),
  /** Can lead a dungeon's boss room. */
  boss: z.boolean().default(false),
  /** Lowest dungeon rank it appears at. */
  minRank: z.number().int().min(1).default(1),
  /** Room archetype id -> how strongly it's drawn there (× weight). */
  drawnTo: weights.default({}),
  /** The body plan it uses (rules/body.json for humanoids; others later). */
  body: z.string().default("humanoid"),
});

export type Species = z.infer<typeof SpeciesSchema>;
export type Roster = Record<string, Species>;
export const RosterSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SpeciesSchema);

/** Kinds that never share a doorway: the living shun what feeds on them. */
export const HOSTILE_KINDS: readonly [Kind, Kind][] = [
  ["organic", "demon"],
  ["organic", "undead"],
  ["beast", "demon"],
];

export function kindsCoexist(a: Kind, b: Kind): boolean {
  return !HOSTILE_KINDS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

const s = (x: z.input<typeof SpeciesSchema>): Species => SpeciesSchema.parse(x);

/** Our game's roster. */
export const BUILTIN_SPECIES: Roster = {
  // Organics: the open world, by biome; living needs.
  goblin: s({
    name: "Goblin", kind: "organic", sustenance: ["food", "water", "rest"], pack: [3, 6], tier: [1, 3],
    habitat: { world: { forest: 2, swamp: 2, plains: 1, mountains: 1 }, dungeon: { themes: { verdant: 1, ancient: 0.5 }, depth: [0, 0.5] } },
    drawnTo: { storeroom: 2, barracks: 2 },
  }),
  orc: s({
    name: "Orc", kind: "organic", sustenance: ["food", "water", "rest"], pack: [2, 4], tier: [1, 3],
    habitat: { world: { plains: 2, mountains: 2, desert: 1, volcanic: 1 }, dungeon: { themes: { molten: 1, ancient: 0.5 }, depth: [0, 0.6] } },
    drawnTo: { armoury: 2, barracks: 2, forge: 1.5 },
  }),
  troll: s({
    name: "Troll", kind: "organic", sustenance: ["food", "rest"], pack: [1, 2], tier: [2, 3], boss: true, minRank: 2,
    habitat: { world: { mountains: 2, tundra: 2, swamp: 1, snow: 1 }, dungeon: { themes: { frost: 1, verdant: 0.5 }, depth: [0.3, 1] } },
    drawnTo: { grotto: 2, icehall: 2 },
  }),
  ogre: s({
    name: "Ogre", kind: "organic", sustenance: ["food", "rest"], pack: [1, 1], tier: [3, 3], boss: true,
    habitat: { world: { mountains: 1, swamp: 1 }, dungeon: { themes: { verdant: 2, molten: 1, frost: 1, ancient: 1 }, depth: [0.6, 1] } },
    drawnTo: { throne: 2, storeroom: 1.5 },
  }),
  // Beasts: the open world's wildlife.
  wolf: s({ name: "Wolf", kind: "beast", sustenance: ["food", "water"], pack: [3, 6], tier: [1, 2], habitat: { world: { forest: 2, tundra: 2, snow: 1, plains: 1 } } }),
  bear: s({ name: "Bear", kind: "beast", sustenance: ["food", "water", "rest"], pack: [1, 1], tier: [2, 3], habitat: { world: { forest: 2, mountains: 1, tundra: 1 } } }),
  boar: s({ name: "Boar", kind: "beast", sustenance: ["food", "water"], pack: [2, 4], tier: [1, 1], habitat: { world: { forest: 2, plains: 1, rainforest: 1 } } }),
  "giant-spider": s({
    name: "Giant spider", kind: "beast", sustenance: ["food"], pack: [2, 5], tier: [1, 2],
    habitat: { world: { rainforest: 2, swamp: 1 }, dungeon: { themes: { verdant: 2, grim: 1, ancient: 1 }, depth: [0, 0.7] } },
    drawnTo: { grotto: 2, storeroom: 1.5 },
  }),
  // Undead: dungeons, mostly grim and ancient; tireless.
  skeleton: s({
    name: "Skeleton", kind: "undead", sustenance: ["necromancy"], pack: [2, 6], tier: [1, 2],
    habitat: { dungeon: { themes: { grim: 3, ancient: 2, frost: 1 }, depth: [0, 0.8] } }, drawnTo: { crypt: 2, armoury: 1.5 },
  }),
  ghoul: s({
    name: "Ghoul", kind: "undead", sustenance: ["lifeforce"], pack: [2, 4], tier: [1, 3],
    habitat: { dungeon: { themes: { grim: 3, frost: 1 }, depth: [0.1, 0.9] } }, drawnTo: { crypt: 2, storeroom: 1.5 },
  }),
  wraith: s({
    name: "Wraith", kind: "undead", sustenance: ["lifeforce", "emotion"], pack: [1, 3], tier: [2, 3], minRank: 2,
    habitat: { dungeon: { themes: { grim: 2, ancient: 2, frost: 2 }, depth: [0.4, 1] } }, drawnTo: { chapel: 2, library: 2 },
  }),
  "bone-champion": s({
    name: "Bone champion", kind: "undead", sustenance: ["necromancy"], pack: [1, 1], tier: [3, 3], boss: true,
    habitat: { dungeon: { themes: { grim: 2, ancient: 2, frost: 2 }, depth: [0.6, 1] } }, drawnTo: { throne: 2, crypt: 2 },
  }),
  lich: s({
    name: "Lich", kind: "undead", sustenance: ["necromancy"], pack: [1, 1], tier: [3, 3], boss: true, minRank: 3,
    habitat: { dungeon: { themes: { grim: 3, ancient: 2, frost: 1 }, depth: [0.7, 1] } }, drawnTo: { throne: 3, library: 2, ritual: 2 },
  }),
  // Demons: manifest only in dungeons, feeding on emotion and lifeforce.
  imp: s({
    name: "Imp", kind: "demon", sustenance: ["emotion"], pack: [3, 6], tier: [1, 1],
    habitat: { dungeon: { themes: { molten: 3, grim: 1, ancient: 1 }, depth: [0, 0.7] } }, drawnTo: { ritual: 3, forge: 2 },
  }),
  fiend: s({
    name: "Fiend", kind: "demon", sustenance: ["emotion", "lifeforce"], pack: [1, 3], tier: [2, 3], minRank: 2,
    habitat: { dungeon: { themes: { molten: 3, grim: 2 }, depth: [0.3, 1] } }, drawnTo: { ritual: 3, chapel: 2 },
  }),
  "infernal-brute": s({
    name: "Infernal brute", kind: "demon", sustenance: ["lifeforce"], pack: [1, 1], tier: [3, 3], boss: true,
    habitat: { dungeon: { themes: { molten: 3, grim: 1 }, depth: [0.6, 1] } }, drawnTo: { throne: 2, forge: 2 },
  }),
  "pit-lord": s({
    name: "Pit lord", kind: "demon", sustenance: ["lifeforce"], pack: [1, 1], tier: [3, 3], boss: true, minRank: 4,
    habitat: { dungeon: { themes: { molten: 3, grim: 1 }, depth: [0.7, 1] } }, drawnTo: { throne: 3, ritual: 3 },
  }),
  // Otherworldly: the deep dwellers.
  "elemental-shard": s({
    name: "Elemental shard", kind: "otherworldly", sustenance: ["none"], pack: [1, 3], tier: [1, 3],
    habitat: { dungeon: { themes: { molten: 2, frost: 3, ancient: 1 }, depth: [0.2, 1] } }, drawnTo: { icehall: 2, forge: 2 },
  }),
  "void-watcher": s({
    name: "Void watcher", kind: "otherworldly", sustenance: ["emotion"], pack: [1, 1], tier: [3, 3], boss: true, minRank: 3,
    habitat: { dungeon: { themes: { ancient: 2, verdant: 1, frost: 1 }, depth: [0.8, 1] } }, drawnTo: { throne: 2, library: 2 },
  }),
};

/** Our roster with a game's file merged over it (by id). Throws with every problem listed. */
export function loadSpecies(file?: string): Roster {
  if (!file) return BUILTIN_SPECIES;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const parsed = RosterSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const roster = { ...BUILTIN_SPECIES, ...parsed.data };
  const problems: string[] = [];
  for (const [id, sp] of Object.entries(roster)) {
    if (sp.pack[0] > sp.pack[1]) problems.push(`${id}.pack: min above max`);
    if (sp.tier[0] > sp.tier[1]) problems.push(`${id}.tier: min above max`);
    if (sp.kind === "demon" && Object.values(sp.habitat.world).some((w) => w > 0)) problems.push(`${id}: demons manifest only in dungeons (habitat.world must be empty)`);
  }
  if (problems.length) throw new Error(`${file}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return roster;
}

/** The open world's spawn table for a biome: species that live there, by weight. */
export function worldSpawnTable(roster: Roster, biome: string): { id: string; weight: number }[] {
  return Object.entries(roster)
    .flatMap(([id, sp]) => {
      const w = sp.kind === "demon" ? 0 : (sp.habitat.world[biome] ?? 0);
      return w > 0 ? [{ id, weight: w }] : [];
    })
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/** A pack for a biome: a species drawn by weight and how many (null: nothing lives there). `r` is uniform [0, 1). */
export function pickWorldPack(roster: Roster, biome: string, r: () => number): { id: string; count: number } | null {
  const table = worldSpawnTable(roster, biome);
  const total = table.reduce((t, e) => t + e.weight, 0);
  if (total === 0) return null;
  let x = r() * total;
  const pick = table.find((e) => (x -= e.weight) < 0) ?? table[table.length - 1];
  const [lo, hi] = roster[pick.id].pack;
  return { id: pick.id, count: lo + Math.floor(r() * (hi - lo + 1)) };
}
