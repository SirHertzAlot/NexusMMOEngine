/**
 * World spec — the checked-in description of a baked world: its size, the
 * coarse survey grid, relief, and the finite set of biome regions.
 *
 * Validated with zod so a typo fails the bake loudly instead of silently
 * producing a different world. Distances are metres; heights are metres
 * above the world's base level.
 */

import * as fs from "node:fs";
import { z } from "zod";

/** How a biome picks its regions from the coarse survey (elevation, moisture). */
export const BiomePick = z.enum([
  "highest", // mountains: highest continental elevation
  "lowest-wet", // swamp: low and wet
  "driest", // desert
  "wettest", // forest
  "rest", // plains: whatever is left
]);

/** Surface shape inside a biome. */
export const BiomeShape = z.enum(["rolling", "ridged", "dunes", "flat"]);

export const BiomeSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "biome id: lowercase letters, digits, dashes"),
  /** How many regions of this biome the world holds (finite by design). */
  count: z.number().int().min(0),
  pick: BiomePick,
  shape: BiomeShape,
  /** Base height of the biome, metres. */
  base: z.number(),
  /** Height of its landforms above the base, metres. */
  relief: z.number().min(0),
  /** Landform size (wavelength), metres. */
  scale: z.number().positive(),
  /** Fine detail strength, 0..1 (0 = smooth, 1 = rough ground). */
  roughness: z.number().min(0).max(1),
});

export const WorldSpecSchema = z
  .object({
    name: z.string().min(1),
    seed: z.number().int().min(0),
    /** World edge in chunks (square, centred on the origin). */
    sizeChunks: z.number().int().min(2).max(4096),
    chunkWorldSize: z.number().positive().default(16),
    /** Coarse survey grid cell, metres. */
    coarseCell: z.number().positive().default(8),
    /** Continental elevation swing (±metres) under every biome. */
    continentalRelief: z.number().min(0).default(20),
    /** Continental feature size, metres. */
    continentalScale: z.number().positive().default(1500),
    /** Biome border blend width, metres. */
    blendWidth: z.number().positive().default(120),
    /** Fine detail height at roughness 1, metres. */
    detailAmplitude: z.number().min(0).default(1.5),
    /** Fine detail feature size, metres. */
    detailScale: z.number().positive().default(14),
    /** Regions per side for server ownership (sizeChunks must divide evenly). */
    regionsPerSide: z.number().int().min(1).default(1),
    erosion: z
      .object({
        droplets: z.number().int().min(0).default(150_000),
        strength: z.number().min(0).max(1).default(0.35),
      })
      .default({ droplets: 150_000, strength: 0.35 }),
    rivers: z
      .object({
        /** Upstream area (m²) at which a flow line becomes a river. */
        minCatchment: z.number().positive().default(400_000),
        /** Deepest river bed carved, metres. */
        maxDepth: z.number().min(0).default(4),
      })
      .default({ minCatchment: 400_000, maxDepth: 4 }),
    biomes: z.array(BiomeSpecSchema).min(1),
  })
  .superRefine((w, ctx) => {
    if (w.sizeChunks % w.regionsPerSide !== 0) {
      ctx.addIssue({ code: "custom", message: `sizeChunks (${w.sizeChunks}) must be divisible by regionsPerSide (${w.regionsPerSide})` });
    }
    const ids = new Set<string>();
    for (const b of w.biomes) {
      if (ids.has(b.id)) ctx.addIssue({ code: "custom", message: `duplicate biome id "${b.id}"` });
      ids.add(b.id);
    }
    if (w.biomes.reduce((n, b) => n + b.count, 0) === 0) {
      ctx.addIssue({ code: "custom", message: "the world needs at least one biome region (all counts are 0)" });
    }
    if (!w.biomes.some((b) => b.pick === "rest")) {
      ctx.addIssue({ code: "custom", message: 'one biome must use pick "rest" (it takes the regions nothing else claims)' });
    }
  });

export type BiomeSpec = z.infer<typeof BiomeSpecSchema>;
export type WorldSpec = z.infer<typeof WorldSpecSchema>;

export function parseWorldSpec(value: unknown): WorldSpec {
  return WorldSpecSchema.parse(value);
}

export function loadWorldSpec(file: string): WorldSpec {
  return parseWorldSpec(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** World bounds in metres: chunks cx in [-size/2, size/2). */
export function worldBounds(spec: WorldSpec): { minChunk: number; maxChunk: number; min: number; max: number } {
  const half = Math.floor(spec.sizeChunks / 2);
  const minChunk = -half;
  const maxChunk = minChunk + spec.sizeChunks - 1;
  return {
    minChunk,
    maxChunk,
    min: minChunk * spec.chunkWorldSize,
    max: (maxChunk + 1) * spec.chunkWorldSize,
  };
}
