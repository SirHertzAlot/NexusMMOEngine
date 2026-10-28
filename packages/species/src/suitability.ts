/**
 * Suitability: the one generic function. Pure, off-tick, no per-species
 * branches. No species ids appear in this file (proposal invariant 4).
 *
 * Semantics (proposal §5, adopted verbatim from the draft §A3):
 *  - per need: satisfaction = max across its requirements;
 *  - any hardBounds violation returns 0 immediately (hard exclusion);
 *  - total = product over needs of needSat ^ weight.
 *
 * A requirement reading a field the supplier does not provide contributes
 * 0 satisfaction. That is how dungeon-scoped needs (e.g. need:essence.*,
 * which read "dungeon.essence") score 0 everywhere in the open world while
 * remaining satisfiable once dungeon systems supply the field.
 */

import type { ConditionFields, NeedCatalog, NeedDef, SpeciesNeeds, Vec2 } from "./needs.js";

/** Piecewise-linear interpolation over [fieldValue, satisfaction] anchors. Clamps past the ends. */
export function sampleAnchors(anchors: ReadonlyArray<readonly [number, number]>, v: number): number {
  if (v <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    if (v <= anchors[i][0]) {
      const [x0, y0] = anchors[i - 1];
      const [x1, y1] = anchors[i];
      return y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return anchors[anchors.length - 1][1];
}

/** One requirement's satisfaction at the supplied fields; 0 when the field is missing. */
export function requirementSatisfaction(req: NeedDef["requirement"][number], fields: ConditionFields): number {
  const v = fields[req.field];
  if (v === undefined) return 0;
  return sampleAnchors(req.anchors, v);
}

/** A need's satisfaction at the supplied fields: the max across its requirements. */
export function needSatisfaction(need: NeedDef, fields: ConditionFields): number {
  let sat = 0;
  for (const req of need.requirement) sat = Math.max(sat, requirementSatisfaction(req, fields));
  return sat;
}

function needOf(catalog: NeedCatalog, needId: string): NeedDef {
  const need = catalog.byId.get(needId);
  if (!need) throw new Error(`suitability: unknown need id ${needId} (catalog holds: ${[...catalog.byId.keys()].join(", ") || "none"})`);
  return need;
}

/**
 * The one generic function. Returns 0..1. Returns 0 on any hard exclusion:
 * the species never spawns there. The catalog is passed explicitly — no
 * global registry, so the function stays pure and testable.
 */
export function suitability(catalog: NeedCatalog, species: SpeciesNeeds, pos: Vec2, fields: ConditionFields): number {
  void pos; // suitability reads fields, not coordinates; position stays in the signature for the seam.
  let s = 1;
  for (const [needId, tuning] of Object.entries(species.needs)) {
    const need = needOf(catalog, needId);
    for (const req of need.requirement) {
      const v = fields[req.field];
      if (req.hardBounds && v !== undefined && (v < req.hardBounds[0] || v > req.hardBounds[1])) {
        return 0; // hard exclusion — never spawns here
      }
    }
    const sat = needSatisfaction(need, fields);
    s *= Math.pow(sat, tuning.weight);
  }
  return s;
}

export interface SuitabilityGradient {
  dx: number;
  dz: number;
  /** Slope magnitude: how much suitability changes per meter uphill. 0 on flat ground. */
  gain: number;
}

/**
 * Derived by sampling, not analytic: condition fields are arbitrary
 * functions, so the gradient is measured (sample nearby cells, weight by
 * delta-suitability), exactly as the draft's migration section describes.
 * Drives displacement recovery.
 */
export function suitabilityGradient(
  catalog: NeedCatalog,
  species: SpeciesNeeds,
  pos: Vec2,
  fieldsAt: (pos: Vec2) => ConditionFields,
  sampleRadius: number,
): SuitabilityGradient {
  if (!(sampleRadius > 0)) throw new Error("suitabilityGradient: sampleRadius must be positive");
  const at = (x: number, z: number): number => suitability(catalog, species, { x, z }, fieldsAt({ x, z }));
  const dx = (at(pos.x + sampleRadius, pos.z) - at(pos.x - sampleRadius, pos.z)) / (2 * sampleRadius);
  const dz = (at(pos.x, pos.z + sampleRadius) - at(pos.x, pos.z - sampleRadius)) / (2 * sampleRadius);
  return { dx, dz, gain: Math.hypot(dx, dz) };
}

/**
 * Maps a need's current level to urgency for the decider's state digest
 * ("Needs vector", substrate spec §4 — quantized, fixed vocabulary, never
 * prose). Intensity = 1 - level, quantized to 3 decimals.
 */
export function needIntensity(_need: NeedDef, level: number): number {
  void _need; // intensity is level-derived; the need is in the signature for the seam.
  const v = Math.min(1, Math.max(0, 1 - level));
  return Math.round(v * 1000) / 1000;
}

/**
 * Which action families the entity's needs currently fan out to (proposal
 * §9): needs whose level has crossed below their uneasy band contribute
 * their action lists, in priority order, deduplicated. These become the
 * candidates for the decision-substrate seam — this schema never scores
 * or picks one.
 */
export function candidateActions(catalog: NeedCatalog, species: SpeciesNeeds, state: { levels: Record<string, number> }): string[] {
  const out: string[] = [];
  for (const [needId, tuning] of Object.entries(species.needs)) {
    void tuning;
    const need = needOf(catalog, needId);
    const level = state.levels[needId] ?? 1;
    if (level < need.thresholds.uneasy) out.push(...need.actions);
  }
  return [...new Set(out)];
}

/**
 * Tolerance is trigger-only for migration urgency (recorded open-question
 * decision): the entity accepts locations within its max tolerance of peak
 * suitability (1); below that, the thinking layer starts generating
 * migrate actions.
 */
export function wantsToMigrate(catalog: NeedCatalog, species: SpeciesNeeds, pos: Vec2, fields: ConditionFields): boolean {
  const tolerances = Object.values(species.needs).map((t) => t.tolerance);
  const accept = 1 - (tolerances.length ? Math.max(...tolerances) : 0);
  return suitability(catalog, species, pos, fields) < accept;
}
