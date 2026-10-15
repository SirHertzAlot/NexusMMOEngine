/**
 * The biome registry (open-world plan, Phase 5): what each biome holds.
 *
 * The world spec decides where biomes are (climate, water, height: the
 * survey's ordered rules) and how their ground looks (surface character,
 * roughness). The registry says what lives there:
 *
 *  - `scatter`: the ecology plan's group multipliers for the biome (trees,
 *    rocks, flowers, reeds, …): a forest's trees thin out onto the plains,
 *    the volcano grows nothing but rock. A group the biome leaves out takes
 *    the plan's `default` row;
 *  - `creatures`: how many packs a square kilometre holds and which kinds,
 *    by weight. Kinds are creature rules ids (content/rules/creatures.json)
 *    or species ids (@mmo-engine/species); only kinds with creature rules
 *    spawn, the rest wait for theirs.
 *
 * Packs are planned per chunk as a pure function of (world seed, chunk,
 * biome lookup, registry), so a chunk always holds the same packs: see
 * `planChunkPacks`. WildCreatures (wild-creatures.ts) spawns them as chunks
 * load and removes them as chunks unload.
 *
 * Default file: content/biomes.json beside the ecology plans; MMO_BIOMES
 * names another.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EcologyPlan } from "./ecology.js";
import { hash } from "./ecology.js";

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)");

const CreatureEntrySchema = z.strictObject({
  /** A creature rules id or a species id. */
  kind: id,
  weight: z.number().positive(),
  /** Pack size here, overriding the creature's own `pack`. */
  pack: z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine(([a, b]) => a <= b, "pack: min above max").optional(),
});

const BiomeEntrySchema = z.strictObject({
  /** Display name (the world map, the editor). */
  name: z.string().min(1),
  /** Ecology group → multiplier (0 removes the group from the biome). */
  scatter: z.record(z.string(), z.number().min(0)).default({}),
  creatures: z
    .strictObject({
      /** Packs per square kilometre (0: nothing roams here). */
      packsPerKm2: z.number().min(0).max(10_000),
      table: z.array(CreatureEntrySchema).default([]),
    })
    .default({ packsPerKm2: 0, table: [] }),
});

export const BiomeRegistrySchema = z.strictObject({
  version: z.literal(1),
  biomes: z.record(id, BiomeEntrySchema),
});

export type BiomeRegistry = z.infer<typeof BiomeRegistrySchema>;
export type BiomeEntry = BiomeRegistry["biomes"][string];
export type BiomeCreatureEntry = BiomeEntry["creatures"]["table"][number];

export const DEFAULT_BIOME_REGISTRY = fileURLToPath(new URL("../../../content/biomes.json", import.meta.url));

export class BiomeRegistryError extends Error {
  constructor(readonly problems: string[]) {
    super(`biome registry: ${problems.join("; ")}`);
    this.name = "BiomeRegistryError";
  }
}

/** Parse a registry (shape only; `checkBiomeRegistry` checks it against a world and content). */
export function parseBiomeRegistry(json: unknown): BiomeRegistry {
  const parsed = BiomeRegistrySchema.safeParse(json);
  if (!parsed.success) {
    throw new BiomeRegistryError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return parsed.data;
}

export function loadBiomeRegistry(file: string = DEFAULT_BIOME_REGISTRY): { registry: BiomeRegistry; hash: string } {
  const text = readFileSync(file, "utf8");
  return { registry: parseBiomeRegistry(JSON.parse(text)), hash: createHash("sha256").update(text).digest("hex") };
}

/** What a registry is checked against. Every list is optional: leave one out to skip that check. */
export interface BiomeRegistryContext {
  /** The world spec's biome ids: each needs a registry entry, and nothing else may have one. */
  worldBiomes?: readonly string[];
  /** The ecology groups the plan's layers read (`layer.biome`). */
  scatterGroups?: readonly string[];
  /** Creature rules ids and species ids a table may name. */
  kinds?: readonly string[];
}

/** Every problem with a registry against its world and content (empty: fine). */
export function checkBiomeRegistry(registry: BiomeRegistry, ctx: BiomeRegistryContext): string[] {
  const problems: string[] = [];
  const ids = Object.keys(registry.biomes);
  if (ctx.worldBiomes) {
    const world = new Set(ctx.worldBiomes);
    for (const b of ctx.worldBiomes) if (!(b in registry.biomes)) problems.push(`world biome "${b}" has no entry`);
    for (const b of ids) if (!world.has(b)) problems.push(`"${b}" is not a biome of this world`);
  }
  const groups = ctx.scatterGroups ? new Set(ctx.scatterGroups) : null;
  const kinds = ctx.kinds ? new Set(ctx.kinds) : null;
  for (const [b, entry] of Object.entries(registry.biomes)) {
    if (groups) {
      for (const g of Object.keys(entry.scatter)) if (!groups.has(g)) problems.push(`${b}.scatter: no ecology layer reads group "${g}"`);
    }
    const seen = new Set<string>();
    for (const c of entry.creatures.table) {
      if (seen.has(c.kind)) problems.push(`${b}.creatures: "${c.kind}" listed twice`);
      seen.add(c.kind);
      if (kinds && !kinds.has(c.kind)) problems.push(`${b}.creatures: unknown kind "${c.kind}"`);
    }
    if (entry.creatures.packsPerKm2 > 0 && entry.creatures.table.length === 0) {
      problems.push(`${b}.creatures: ${entry.creatures.packsPerKm2} packs per km² but an empty table`);
    }
  }
  return problems;
}

/** The ecology groups a plan's layers read. */
export function ecologyGroups(plan: EcologyPlan): string[] {
  return [...new Set(plan.layers.flatMap((l) => (l.biome ? [l.biome] : [])))];
}

/**
 * The plan with the registry's scatter multipliers in place of its own biome
 * rows: each biome's row is the plan's `default` row overlaid with the
 * registry's `scatter`. Biomes the registry doesn't list keep the plan's row.
 * The hash covers both, so formation tiles solved under other multipliers
 * are solved again.
 */
export function applyBiomeScatter(
  plan: EcologyPlan,
  planHash: string,
  registry: BiomeRegistry,
): { plan: EcologyPlan; hash: string } {
  const base = plan.biomes?.default ?? {};
  const biomes: Record<string, Record<string, number>> = { ...(plan.biomes ?? {}) };
  for (const [b, entry] of Object.entries(registry.biomes)) biomes[b] = { ...base, ...entry.scatter };
  const scatter = Object.keys(registry.biomes)
    .sort()
    .map((b) => [b, Object.entries(registry.biomes[b].scatter).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))]);
  const h = createHash("sha256").update(planHash).update("\0biomes\0").update(JSON.stringify(scatter)).digest("hex");
  return { plan: { ...plan, biomes }, hash: h };
}

// --------------------------------------------------------------- packs

/** One pack a chunk holds: its kind, where it lives, and its size when the biome sets one. */
export interface PlannedPack {
  kind: string;
  biome: string;
  x: number;
  z: number;
  pack?: [number, number];
  /** Lives in the water (the wildlife table's water habitat): spawns where it is deep, not where it is dry. */
  aquatic?: boolean;
}

export interface PackPlanContext {
  /** 32-bit world seed (see ecologySeed32). */
  seed: number;
  cx: number;
  cz: number;
  chunkWorldSize: number;
  /** Biome at world (x, z); null: none (nothing spawns). */
  biomeAt: (x: number, z: number) => string | null;
  /** Kinds that may spawn (with creature rules); others are planned out. Default: all. */
  spawnable?: (kind: string) => boolean;
}

const unit = (h: number): number => h / 4294967296;
const SALT = 0xb10e;

/**
 * The packs one chunk holds: at most one per chunk, kept with the biome's
 * density × the chunk's area (a forest at 40 packs per km² gives a 16 m chunk
 * a 1% chance), at a point drawn inside the chunk, of a kind drawn by weight
 * from the biome at that point. Pure: the same inputs give the same packs.
 */
export function planChunkPacks(registry: BiomeRegistry, ctx: PackPlanContext): PlannedPack[] {
  const s = ctx.chunkWorldSize;
  const x = (ctx.cx + unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 1))) * s;
  const z = (ctx.cz + unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 2))) * s;
  const biome = ctx.biomeAt(x, z);
  if (biome === null) return [];
  const entry = registry.biomes[biome];
  if (!entry || entry.creatures.packsPerKm2 <= 0) return [];
  const chance = Math.min(1, (entry.creatures.packsPerKm2 * s * s) / 1e6);
  if (unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 3)) >= chance) return [];
  const table = ctx.spawnable ? entry.creatures.table.filter((c) => ctx.spawnable!(c.kind)) : entry.creatures.table;
  // Unspawnable kinds keep their share of the roll: a forest whose wolves
  // have no rules yet holds fewer packs, not more goblins.
  let total = 0;
  for (const c of entry.creatures.table) total += c.weight;
  let r = unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 4)) * total;
  for (const c of entry.creatures.table) {
    r -= c.weight;
    if (r < 0) {
      if (!table.includes(c)) return [];
      return [{ kind: c.kind, biome, x, z, ...(c.pack ? { pack: [c.pack[0], c.pack[1]] as [number, number] } : {}) }];
    }
  }
  return [];
}
