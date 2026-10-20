/**
 * Species: who lives in the world and where, as data (docs/DUNGEONS-AND-LOOT.md §4).
 *
 *  - kind: organic (the open world's living creatures), beast, undead and
 *    otherworldly (mostly dungeons), demon (manifests only in dungeons,
 *    where emotion and lifeforce are to be had);
 *  - habitat: which dungeon themes and depths it haunts (open-world
 *    placement is needs-driven now — see needs.ts — not biome tables);
 *  - needs: what the species requires, as rows in the need catalog
 *    (content/species/needs.json), scored by suitability();
 *  - what keeps it alive, how many come together, which spawn tiers it
 *    can fill (1 rank and file, 3 elite), the lowest dungeon rank it
 *    appears at, and room archetypes that draw it (a ritual chamber, for
 *    a demon).
 *
 * The engine ships no species rows in code. The sample pack lives in
 * content/species/ (marked as sample in its README); a game adds or
 * replaces species with a JSON file of the same shape (`loadSpecies`),
 * or points MMO_SPECIES_DIR at its own species directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SpeciesNeedsSchema, toNeedCatalog, type NeedCatalog, type NeedCatalogFile } from "./needs.js";

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
      /**
       * Legacy biome weights, kept for games that still author them. New
       * content uses `needs` + suitability() instead; the sample pack
       * carries no world table.
       */
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
  /** What the species requires, scored by suitability(). No habitat tables. */
  needs: SpeciesNeedsSchema,
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

/**
 * The species directory: MMO_SPECIES_DIR when set, else the repo's
 * content/species found by walking up from this module. Throws loudly
 * when there is no species data at all — the engine never invents a
 * roster.
 */
export function defaultSpeciesDir(): string {
  const env = process.env.MMO_SPECIES_DIR;
  if (env) {
    if (!existsSync(join(env, "species.json"))) throw new Error(`MMO_SPECIES_DIR: no species.json in ${env}`);
    return env;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "content", "species");
    if (existsSync(join(cand, "species.json"))) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("species: no content/species/species.json found above this module (set MMO_SPECIES_DIR to point at one)");
}

function readJsonFile(file: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  return raw;
}

function parseRosterFile(file: string): Roster {
  const parsed = RosterSchema.safeParse(readJsonFile(file));
  if (!parsed.success) throw new Error(`${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return parsed.data;
}

/** The need catalog (content/species/needs.json). Throws with every problem listed. */
export function loadNeedCatalog(dir: string = defaultSpeciesDir()): NeedCatalog {
  const file = join(dir, "needs.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  try {
    return toNeedCatalog(raw as NeedCatalogFile);
  } catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    if (issues) throw new Error(`${file}:\n${issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    throw e;
  }
}

function checkRoster(roster: Roster, catalog: NeedCatalog | undefined, label: string): void {
  const problems: string[] = [];
  for (const [id, sp] of Object.entries(roster)) {
    if (sp.needs.speciesId !== id) problems.push(`${id}.needs.speciesId: ${sp.needs.speciesId} does not match the roster key`);
    if (sp.pack[0] > sp.pack[1]) problems.push(`${id}.pack: min above max`);
    if (sp.tier[0] > sp.tier[1]) problems.push(`${id}.tier: min above max`);
    if (sp.kind === "demon" && Object.values(sp.habitat.world).some((w) => w > 0)) problems.push(`${id}: demons manifest only in dungeons (habitat.world must be empty)`);
    if (catalog) {
      for (const needId of Object.keys(sp.needs.needs)) {
        if (!catalog.byId.has(needId)) problems.push(`${id}.needs: unknown need id ${needId}`);
      }
    }
  }
  if (problems.length) throw new Error(`${label}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
}

/**
 * The sample pack's roster (content/species/species.json), or a game's file
 * merged over it (by id). Throws with every problem listed. Pass a catalog
 * to also validate that every referenced need id exists.
 */
export function loadSpecies(file?: string, catalog?: NeedCatalog): Roster {
  const base = parseRosterFile(join(defaultSpeciesDir(), "species.json"));
  if (!file) {
    checkRoster(base, catalog, "species.json");
    return base;
  }
  const overlay = parseRosterFile(file);
  const roster = { ...base, ...overlay };
  checkRoster(roster, catalog, file);
  return roster;
}

/**
 * The sample pack as one validated unit: roster + need catalog, with every
 * species' referenced need ids checked against the catalog. This is the
 * boot path for needs-driven placement.
 */
export function loadSpeciesPack(dir: string = defaultSpeciesDir()): { roster: Roster; catalog: NeedCatalog } {
  const catalog = loadNeedCatalog(dir);
  const roster = loadSpecies(undefined, catalog);
  return { roster, catalog };
}

/**
 * Legacy open-world spawn table for a biome: species that still carry
 * habitat.world weights. Superseded by suitability() for needs-driven
 * content; kept so games' existing world tables keep working.
 */
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
