/**
 * Needs schema: the data layer behind the decision-substrate seam.
 *
 * Two layers (proposal §2):
 *  - definitions: NeedDef rows (the need catalog) and SpeciesNeeds rows
 *    (per-species tunings). Content, versioned, authored. No species ids
 *    appear in this file (proposal invariant 4).
 *  - instance state: NeedState, per entity, evaluated in batches off the
 *    tick (see need-state.ts). The tick-hot `Needs` SAB component in
 *    engine-core stays untouched.
 *
 * Unknown schemaVersions are rejected loudly, never guessed. Every row
 * carries provenance (proposal invariant 3).
 */

import { z } from "zod";

/** The only needs-schema version this build reads. */
export const NEEDS_SCHEMA_VERSION = 1 as const;

const schemaVersion = z
  .number()
  .int()
  .refine((v) => v === NEEDS_SCHEMA_VERSION, {
    message: `unknown needs schemaVersion: this build reads ${NEEDS_SCHEMA_VERSION}, refusing to guess`,
  });

const unitInterval = z.number().min(0).max(1);

export const ProvenanceSchema = z.strictObject({
  /** The script that produced the row, e.g. "needs/water.scm". */
  script: z.string().min(1),
  /** Who authored it, e.g. "design". */
  author: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

const needId = z.string().regex(/^need:[a-z][a-z0-9.-]*$/, "need ids are lowercase dot-namespaced, e.g. need:hydration.fresh");

const anchors = z
  .array(z.tuple([z.number(), unitInterval]))
  .min(2)
  .refine((pts) => pts.every((p, i) => i === 0 || p[0] > pts[i - 1][0]), {
    message: "anchors must be sorted by field value ascending",
  });

export const NeedDefSchema = z.strictObject({
  /** Stable id, e.g. "need:hydration.fresh". */
  id: needId,
  schemaVersion,
  category: z.enum(["water", "food", "temperature", "shelter", "social", "custom"]),
  /** How fast `level` drains per sim-hour when the need is unsatisfied. Data, not code. */
  decayPerHour: unitInterval,
  /** Level bands, each 0..1, strictly decreasing. Crossing below a band raises urgency. */
  thresholds: z
    .strictObject({ uneasy: unitInterval, urgent: unitInterval, critical: unitInterval })
    .refine((t) => t.uneasy > t.urgent && t.urgent > t.critical, {
      message: "thresholds must strictly decrease: uneasy > urgent > critical",
    }),
  /** Which environment condition fields this need reads (see CONDITION_FIELDS). */
  conditionFields: z.array(z.string().min(1)).min(1),
  /** How condition values map to satisfaction — scored, never hardcoded per species. */
  requirement: z
    .array(
      z.strictObject({
        field: z.string().min(1),
        /** Piecewise-linear [fieldValue, satisfaction] points. */
        anchors,
        /** Reading outside [min, max] forces suitability to 0 (hard exclusion). */
        hardBounds: z.tuple([z.number(), z.number()]).optional(),
      }),
    )
    .min(1),
  /** Action families this need can fan out to for the thinking layer, in priority order. */
  actions: z.array(z.string().min(1)).default([]),
  provenance: ProvenanceSchema,
});
export type NeedDef = z.infer<typeof NeedDefSchema>;

const needTuning = z.strictObject({
  /** How strongly this need pulls the suitability product — the specialist's key need gets the big weight. */
  weight: z.number().min(0),
  /** How far below peak suitability the entity accepts before migrate actions start. */
  tolerance: unitInterval,
});

export const SpeciesNeedsSchema = z.strictObject({
  /** Stable species id, e.g. "mire-newt". Same format as the species roster. */
  speciesId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  schemaVersion,
  /** need id -> tuning. Species tune ONLY weight and tolerance, never anchors. */
  needs: z.record(z.string(), needTuning),
  /** Constraint axes for the WFC variant generator, e.g. ["biome", "size"]. */
  variantAxes: z.array(z.string()).default([]),
  provenance: ProvenanceSchema,
});
export type SpeciesNeeds = z.infer<typeof SpeciesNeedsSchema>;

export const NeedStateSchema = z.strictObject({
  entityId: z.number().int(),
  /** need id -> current level, 1 = fully satisfied ... 0 = empty. */
  levels: z.record(z.string(), unitInterval),
  updatedTick: z.number().int(),
});
export type NeedState = z.infer<typeof NeedStateSchema>;

/** The need catalog file envelope (content/species/needs.json). */
export const NeedCatalogSchema = z
  .strictObject({
    schemaVersion,
    /** Optional free text marking the pack, e.g. "sample". Not parsed as data. */
    pack: z.string().optional(),
    description: z.string().optional(),
    needs: z
      .array(NeedDefSchema)
      .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, {
        message: "need ids must be unique within the catalog",
      }),
  })
  .transform((c) => ({ schemaVersion: c.schemaVersion, needs: c.needs }));
export type NeedCatalogFile = z.input<typeof NeedCatalogSchema>;

/** The validated catalog the suitability functions read. */
export interface NeedCatalog {
  schemaVersion: number;
  needs: NeedDef[];
  byId: Map<string, NeedDef>;
}

export function toNeedCatalog(file: NeedCatalogFile): NeedCatalog {
  const parsed = NeedCatalogSchema.parse(file);
  const byId = new Map(parsed.needs.map((n) => [n.id, n]));
  return { schemaVersion: parsed.schemaVersion, needs: parsed.needs, byId };
}

/** A 2D position. The gradient returns dx/dz, so the vertical axis is z. */
export interface Vec2 {
  x: number;
  z: number;
}

/**
 * The environment condition fields habitat systems must supply at a queried
 * location (proposal §6). Ranges are part of the contract; a field outside
 * its range is a bug in the supplier, not the schema.
 */
export type ConditionFields = Record<string, number>;

export const CONDITION_FIELDS: ReadonlyArray<{ field: string; min: number; max: number; meaning: string }> = [
  { field: "water.fresh", min: 0, max: 1, meaning: "fresh water availability at the location" },
  { field: "water.salinity", min: 0, max: 1, meaning: "0 = fresh, 1 = seawater — the freshwater-obligate axis" },
  { field: "water.shoreDist", min: -Infinity, max: Infinity, meaning: "signed meters to nearest shoreline; negative = submerged" },
  { field: "temperature", min: 0, max: 1, meaning: "0 = polar … 1 = volcanic — the arctic-exclusion axis" },
  { field: "aridity", min: 0, max: 1, meaning: "dryness — the desert-exclusion axis" },
  { field: "moisture", min: 0, max: 1, meaning: "groundwater-derived dampness" },
  { field: "forest.density", min: 0, max: 1, meaning: "canopy cover" },
  { field: "forest.edgeGradient", min: 0, max: 1, meaning: "how much this spot is a forest edge" },
  { field: "soil.fertility", min: 0, max: 1, meaning: "ground productivity for forage/farming" },
  { field: "forage.abundance", min: 0, max: 1, meaning: "edible matter here, as judged by the habitat systems" },
];

/** Fail fast on a supplier bug: a ranged contract field outside its range. Throws. */
export function assertConditionFields(fields: ConditionFields): void {
  for (const { field, min, max } of CONDITION_FIELDS) {
    const v = fields[field];
    if (v === undefined) continue;
    if (!(v >= min && v <= max)) throw new Error(`condition field ${field}=${v} outside its contract range [${min}, ${max}]`);
  }
}
