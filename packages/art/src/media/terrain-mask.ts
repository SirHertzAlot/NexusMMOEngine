/**
 * Terrain material masks as data.
 *
 * The world bake writes one mask per chunk, after terrain generation and
 * before scatter and detail. Each channel says how strongly a material
 * layer shows at that spot, so the client blends the terrain textures and
 * the detail layers read the same conditions instead of recomputing them.
 *
 * Channel meanings are fixed (TERRAIN_MASK_CHANNELS) and stored as RGBA bytes:
 * - R base: ground variation (seeded noise; the base layer's blend)
 * - G rock: exposure of bare rock (steep slopes, thinned by moisture)
 * - B wet: darkened, wet soil (high moisture and flow)
 * - A path: worn ground along roads
 *
 * Every channel is independent: a change to one channel's parameters
 * changes only that channel's bytes (engine-core tests pin this).
 */
import { z } from "zod";

export const TERRAIN_MASK_CHANNELS = ["base", "rock", "wet", "path"] as const;
export type TerrainMaskChannel = (typeof TERRAIN_MASK_CHANNELS)[number];

/**
 * A smooth 0..1 ramp between two thresholds (smoothstep) on an input in the
 * input's own units (degrees of slope, or 0..1 moisture), with a seeded
 * noise offset of up to `noiseAmplitude` in those units.
 */
const Ramp = z
  .object({
    /** Below this (after noise) the channel is 0. */
    from: z.number().min(0),
    /** At or above this the channel is 1. */
    to: z.number().min(0),
    /** Noise amplitude added to the input before the ramp (0 none). */
    noiseAmplitude: z.number().min(0).default(0),
  })
  .refine((r) => r.to > r.from, { message: "to must be greater than from" });

export const TerrainMaskSpec = z.object({
  version: z.literal(1),
  /** The seed every noise field uses; same seed, same mask. */
  seed: z.number().int().min(0).max(0xffffffff),
  /** Mask samples per chunk side (the mask is resolution × resolution). */
  resolution: z.number().int().min(8).max(256),
  /** Noise feature size in metres for the base and the threshold noise. */
  noiseScaleMetres: z.number().positive(),
  /** Slope in degrees: rock exposure ramps across this range. */
  rock: z.object({ slope: Ramp, moistureDamping: z.number().min(0).max(1).default(0.5) }),
  /** Moisture (0..1): wet soil ramps across this range, boosted by flow. */
  wet: z.object({ moisture: Ramp, flowBoost: z.number().min(0).max(1).default(0.25) }),
  /** Path: road cells are 1, widened by `featherCells` box-blur passes. */
  path: z.object({ featherCells: z.number().int().min(0).max(8).default(1) }),
});
export type TerrainMaskSpec = z.infer<typeof TerrainMaskSpec>;

/** Parse and validate a mask spec, throwing with the field path on error. */
export function parseTerrainMaskSpec(value: unknown): TerrainMaskSpec {
  return TerrainMaskSpec.parse(value);
}

/** The default mask spec the world bake uses (content may override it later). */
export const DEFAULT_TERRAIN_MASK_SPEC: TerrainMaskSpec = {
  version: 1,
  seed: 1,
  resolution: 64,
  noiseScaleMetres: 24,
  rock: { slope: { from: 28, to: 48, noiseAmplitude: 3 }, moistureDamping: 0.5 },
  wet: { moisture: { from: 0.55, to: 0.85, noiseAmplitude: 0.05 }, flowBoost: 0.25 },
  path: { featherCells: 1 },
};
