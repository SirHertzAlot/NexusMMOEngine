/**
 * Detail (decoration) layers as data: moss, rubble, mushrooms, ground plants.
 *
 * One schema serves dungeon interiors and the overworld. A layer says where it
 * may go (surface and a band), how often (density and noise), what it prefers
 * (affinity), how it clusters, and a hard budget per bake unit. The evaluator
 * (engine-core terrain/detail-layer.ts) turns a layer and a surface context
 * into placements at bake time. The runtime never decides placement.
 */
import { z } from "zod";

export const DETAIL_SURFACES = ["floor", "wall", "ceiling", "terrain"] as const;
export type DetailSurface = (typeof DETAIL_SURFACES)[number];

export const DetailLayer = z
  .object({
    id: z.string().min(1),
    /** The asset set the placements draw from (a content id). */
    assetSet: z.string().min(1),
    surface: z.enum(DETAIL_SURFACES),
    /** Probability per eligible sample before noise and affinity, 0..1. */
    density: z.number().min(0).max(1),
    noise: z.object({ scale: z.number().positive(), threshold: z.number().min(0).max(1) }),
    /**
     * Eligible band. Indoors: distance to the nearest wall, metres. Outdoors:
     * a mask channel value 0..1 (terrain-mask.ts).
     */
    band: z.object({ min: z.number(), max: z.number() }).refine((b) => b.max >= b.min, { message: "max must be at least min" }),
    /**
     * Affinity: `preference` 0..1 is how strongly a sample's affinity (corners
     * indoors; a moisture or slope match outdoors) counts, and `weight` how
     * much it changes the probability (0 ignores affinity).
     */
    affinity: z.object({ weight: z.number().min(0).max(1), preference: z.number().min(0).max(1) }),
    /** Clustering: placements gather in patches of `size` metres, softened over `falloff` metres. */
    cluster: z.object({ size: z.number().min(0), falloff: z.number().min(0) }),
    seed: z.number().int().min(0).max(0xffffffff),
    /** Hard cap on placements per bake unit (a room or a chunk). */
    budget: z.number().int().min(0),
    /**
     * Outdoor layers only: which terrain mask channel the band reads
     * (terrain-mask.ts). The moisture affinity reads the wet channel.
     */
    channel: z.enum(["base", "rock", "wet", "path"]).optional(),
  })
  .strict();
export type DetailLayer = z.infer<typeof DetailLayer>;

export function parseDetailLayer(value: unknown): DetailLayer {
  return DetailLayer.parse(value);
}
