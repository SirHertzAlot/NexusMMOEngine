/**
 * Node type registry — the v1 node vocabulary (UE PCG taxonomy subset).
 *
 * Each node type declares its category, input pins, and settings shape.
 * Settings marked `paramable` accept `{ "$param": "name" }` references,
 * resolved by the cooker against graph params / instance overrides.
 *
 * Categories: sampler (source, no inputs) → filter / modifier (one `in`
 * pin) → spawner (terminal, consumes points, emits spawn records).
 */
import { z } from "zod";
import { ParamRefSchema } from "./schema.js";

export type NodeCategory = "sampler" | "filter" | "modifier" | "spawner";

export interface NodeTypeDef {
  type: string;
  category: NodeCategory;
  description: string;
  /** Samplers take no input; everything else takes one point-list input. */
  inputs: "none" | ["in"];
  /** Spawners are terminal: they must be graph sinks. */
  terminal: boolean;
  /** settings key -> Zod schema for the literal (post-resolution) value. */
  settings: Record<string, z.ZodTypeAny>;
  /** Settings keys that accept `{ "$param": name }` references. */
  paramable: string[];
}

/** u32 seed literal. */
const Seed = z.number().int().min(0).max(0xffffffff);
/** Probability literal. */
const Prob = z.number().min(0).max(1);

const defs: NodeTypeDef[] = [
  {
    type: "gridSampler",
    category: "sampler",
    description:
      "Emit a jittered lattice of points over the 16x16 chunk footprint (y=0; height is resolved downstream by the region).",
    inputs: "none",
    terminal: false,
    settings: {
      spacing: z.number().positive(),
      jitter: z.number().min(0).max(1),
      seed: Seed,
    },
    paramable: ["spacing", "jitter", "seed"],
  },
  {
    type: "densityFilter",
    category: "filter",
    description:
      "Keep each point with probability `density`, decided by hashing the point seed (order-independent).",
    inputs: ["in"],
    terminal: false,
    settings: { density: Prob, seed: Seed },
    paramable: ["density", "seed"],
  },
  {
    type: "slopeFilter",
    category: "filter",
    description:
      "Drop points where terrain slope (rise/run from the chunk heightfield) exceeds `maxSlope`.",
    inputs: ["in"],
    terminal: false,
    settings: { maxSlope: z.number().positive() },
    paramable: ["maxSlope"],
  },
  {
    type: "attributeFilter",
    category: "filter",
    description: "Keep points whose dynamic attribute lies in [min, max].",
    inputs: ["in"],
    terminal: false,
    settings: {
      attribute: z.string().min(1),
      min: z.number(),
      max: z.number(),
    },
    paramable: ["min", "max"],
  },
  {
    type: "setAttribute",
    category: "modifier",
    description: "Write a constant value into a dynamic attribute column.",
    inputs: ["in"],
    terminal: false,
    settings: {
      attribute: z.string().min(1),
      value: z.number(),
    },
    paramable: ["value"],
  },
  {
    type: "transformPoints",
    category: "modifier",
    description:
      "Randomize yaw in [yawMin, yawMax] and uniform scale in [scaleMin, scaleMax] from a seeded stream.",
    inputs: ["in"],
    terminal: false,
    settings: {
      yawMin: z.number(),
      yawMax: z.number(),
      scaleMin: z.number().positive(),
      scaleMax: z.number().positive(),
      seed: Seed,
    },
    paramable: ["yawMin", "yawMax", "scaleMin", "scaleMax", "seed"],
  },
  {
    type: "meshSpawner",
    category: "spawner",
    description:
      "Terminal: assign each surviving point a mesh asset by weighted hash choice. Emits spawn records.",
    inputs: ["in"],
    terminal: true,
    settings: {
      entries: z
        .array(
          z.object({
            asset: z.string().min(1),
            weight: z.number().positive(),
          }),
        )
        .min(1, "meshSpawner needs at least one entry"),
      seed: Seed,
    },
    paramable: ["seed"],
  },
];

const byType = new Map(defs.map((d) => [d.type, d]));

export function getNodeType(type: string): NodeTypeDef | undefined {
  return byType.get(type);
}

export function listNodeTypes(): NodeTypeDef[] {
  return [...defs];
}

/**
 * Validate raw settings for a node type.
 * Phase "pre": paramable keys may be literals or `{ $param }` refs.
 * Phase "post": all refs resolved — literals only.
 * Returns the parsed settings (pre) — post-resolution callers re-parse
 * with "post" after substituting.
 */
export function validateSettings(
  def: NodeTypeDef,
  raw: Record<string, unknown>,
  phase: "pre" | "post",
): Record<string, unknown> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, lit] of Object.entries(def.settings)) {
    shape[key] =
      phase === "pre" && def.paramable.includes(key)
        ? z.union([lit, ParamRefSchema])
        : lit;
  }
  const parsed = z.object(shape).strict().safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `invalid settings for node type "${def.type}" (${phase}): ${issues}`,
    );
  }
  return parsed.data as Record<string, unknown>;
}
