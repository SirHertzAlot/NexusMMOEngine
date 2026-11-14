/**
 * Parametric building template & deterministic lot variation roller.
 *
 * Bridges static architectural grammars / Unity structure prototypes with a
 * typed knob space, variation weights, district/ward narrowing, and grammar
 * legality constraints while keeping experimental gaussian-splat treatments
 * strictly gated behind metadata and budget fields.
 */

import { z } from "zod";
import { DeterministicRng } from "./synthesizer.js";
import { InteriorGrammarSchema } from "./grammar.js";
import type { StructurePrototype } from "./types.js";

export type InteriorGrammarDoc = z.infer<typeof InteriorGrammarSchema>;

export const KnobPrimitiveSchema = z.union([
  z.number().finite(),
  z.string().min(1),
  z.boolean(),
]);
export type KnobValue = z.infer<typeof KnobPrimitiveSchema>;

export const RangeKnobSchema = z
  .object({
    kind: z.literal("range"),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().positive().finite().optional(),
    integer: z.boolean().optional(),
    default: z.number().finite(),
    variationWeight: z.number().nonnegative().finite(),
    legalConstraintTag: z.string().min(1).optional(),
  })
  .strict()
  .refine((k) => k.min <= k.max, {
    message: "RangeKnob min must be <= max",
  });
export type RangeKnobSpec = z.infer<typeof RangeKnobSchema>;

export const ChoiceOptionSchema = z
  .object({
    value: KnobPrimitiveSchema,
    weight: z.number().nonnegative().finite(),
  })
  .strict();
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;

export const ChoiceKnobSchema = z
  .object({
    kind: z.literal("choice"),
    options: z.array(ChoiceOptionSchema).min(1),
    default: KnobPrimitiveSchema,
    variationWeight: z.number().nonnegative().finite(),
    legalConstraintTag: z.string().min(1).optional(),
  })
  .strict();
export type ChoiceKnobSpec = z.infer<typeof ChoiceKnobSchema>;

export const KnobSpecSchema = z.discriminatedUnion("kind", [
  RangeKnobSchema,
  ChoiceKnobSchema,
]);
export type KnobSpec = z.infer<typeof KnobSpecSchema>;

export const FootprintBoundConstraintSchema = z
  .object({
    kind: z.literal("footprint-bound"),
    id: z.string().min(1),
    minWidthM: z.number().positive().finite().optional(),
    maxWidthM: z.number().positive().finite().optional(),
    minDepthM: z.number().positive().finite().optional(),
    maxDepthM: z.number().positive().finite().optional(),
    widthKnob: z.string().min(1).optional(),
    depthKnob: z.string().min(1).optional(),
  })
  .strict();

export const MaxHeightConstraintSchema = z
  .object({
    kind: z.literal("max-height"),
    id: z.string().min(1),
    maxHeightM: z.number().positive().finite(),
    floorsKnob: z.string().min(1),
    floorHeightKnob: z.string().min(1).optional(),
    defaultFloorHeightM: z.number().positive().finite().default(3.0),
    roofHeightKnob: z.string().min(1).optional(),
  })
  .strict();

export const RequiresConstraintSchema = z
  .object({
    kind: z.literal("requires"),
    id: z.string().min(1),
    whenKnob: z.string().min(1),
    whenEquals: KnobPrimitiveSchema.optional(),
    whenNotEquals: KnobPrimitiveSchema.optional(),
    whenMin: z.number().finite().optional(),
    targetKnob: z.string().min(1),
    allowedValues: z.array(KnobPrimitiveSchema).min(1).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();

export const ForbidsConstraintSchema = z
  .object({
    kind: z.literal("forbids"),
    id: z.string().min(1),
    knobA: z.string().min(1),
    equalsA: z.union([KnobPrimitiveSchema, z.array(KnobPrimitiveSchema).min(1)]),
    knobB: z.string().min(1),
    equalsB: z.union([KnobPrimitiveSchema, z.array(KnobPrimitiveSchema).min(1)]),
  })
  .strict();

export const SumBoundConstraintSchema = z
  .object({
    kind: z.literal("sum-bound"),
    id: z.string().min(1),
    knobs: z.array(z.string().min(1)).min(1),
    minSum: z.number().finite().optional(),
    maxSum: z.number().finite().optional(),
  })
  .strict();

export const TemplateConstraintSchema = z.discriminatedUnion("kind", [
  FootprintBoundConstraintSchema,
  MaxHeightConstraintSchema,
  RequiresConstraintSchema,
  ForbidsConstraintSchema,
  SumBoundConstraintSchema,
]);
export type TemplateConstraint = z.infer<typeof TemplateConstraintSchema>;

export const DistrictKnobOverrideSchema = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    allowedValues: z.array(KnobPrimitiveSchema).min(1).optional(),
    fixedValue: KnobPrimitiveSchema.optional(),
    variationWeightMultiplier: z.number().nonnegative().finite().optional(),
    optionWeightMultipliers: z.record(z.string(), z.number().nonnegative().finite()).optional(),
  })
  .strict();
export type DistrictKnobOverride = z.infer<typeof DistrictKnobOverrideSchema>;

export const DistrictNarrowingRuleSchema = z
  .object({
    district: z.string().min(1),
    knobOverrides: z.record(z.string().min(1), DistrictKnobOverrideSchema).default({}),
    maxFootprintM: z.tuple([z.number().positive().finite(), z.number().positive().finite()]).optional(),
    maxHeightM: z.number().positive().finite().optional(),
  })
  .strict();
export type DistrictNarrowingRule = z.infer<typeof DistrictNarrowingRuleSchema>;

/**
 * R&D-only gate for experimental gaussian splat treatments on micro-foliage
 * overlays. Runtime ships standard cross-quad geometry until approved.
 */
export const SplatExperimentMetadataSchema = z
  .object({
    treatment: z.enum(["cross-quad", "splat-overlay", "hybrid"]).default("cross-quad"),
    gateStatus: z.literal("rd-only").default("rd-only"),
    maxSplatBudget: z.number().int().nonnegative(),
    celPaletteSnapped: z.boolean().default(true),
    notes: z.string().optional(),
  })
  .strict();
export type SplatExperimentMetadata = z.infer<typeof SplatExperimentMetadataSchema>;

export const ParametricBuildingTemplateSchema = z
  .object({
    schema: z.literal("mmo-parametric-building/1").default("mmo-parametric-building/1"),
    id: z.string().min(1),
    family: z.string().min(1),
    sourceMode: z.enum(["parametric-gn", "static-decomposed"]).default("parametric-gn"),
    archetypes: z.array(z.string().min(1)).min(1),
    baseGrammarId: z.string().min(1).optional(),
    prototypeId: z.string().min(1).optional(),
    footprintRangeM: z
      .object({
        min: z.tuple([z.number().positive().finite(), z.number().positive().finite()]),
        max: z.tuple([z.number().positive().finite(), z.number().positive().finite()]),
      })
      .strict(),
    knobSpace: z.record(z.string().min(1), KnobSpecSchema),
    grammarConstraints: z.array(TemplateConstraintSchema).default([]),
    districtRules: z.array(DistrictNarrowingRuleSchema).default([]),
    splatExperiment: SplatExperimentMetadataSchema.optional(),
  })
  .strict();
export type ParametricBuildingTemplate = z.infer<typeof ParametricBuildingTemplateSchema>;

export interface LotVariationOptions {
  seed: number;
  parcelSizeM?: [number, number];
  district?: string | DistrictNarrowingRule;
  overrides?: Record<string, KnobValue>;
  maxAttempts?: number;
}

export interface LotVariationRoll {
  templateId: string;
  family: string;
  sourceMode: "parametric-gn" | "static-decomposed";
  seed: number;
  district?: string;
  knobValues: Record<string, KnobValue>;
  rolledFootprintM: [number, number];
  appliedConstraints: string[];
  legal: true;
  attempts: number;
}

export interface KnobValidationResult {
  legal: boolean;
  violations: string[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function snapRangeValue(spec: RangeKnobSpec, raw: number): number {
  let v = clamp(raw, spec.min, spec.max);
  if (spec.step !== undefined) {
    const steps = Math.round((v - spec.min) / spec.step);
    v = clamp(spec.min + steps * spec.step, spec.min, spec.max);
  }
  if (spec.integer) {
    v = clamp(Math.round(v), Math.ceil(spec.min), Math.floor(spec.max));
  }
  return Math.round(v * 1e6) / 1e6;
}

function enumerateDiscreteRange(spec: RangeKnobSpec): number[] {
  const step = spec.step ?? (spec.integer ? 1 : undefined);
  if (step === undefined) return [];
  const out: number[] = [];
  const count = Math.floor((spec.max - spec.min) / step + 1e-9);
  if (count > 512) return [];
  for (let i = 0; i <= count; i++) {
    out.push(snapRangeValue(spec, spec.min + i * step));
  }
  return out;
}

function matchesValue(actual: KnobValue | undefined, expected: KnobValue | KnobValue[]): boolean {
  if (actual === undefined) return false;
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

/**
 * Parse and structurally validate a ParametricBuildingTemplate JSON object.
 */
export function parseParametricBuildingTemplate(raw: unknown): ParametricBuildingTemplate {
  const parsed = ParametricBuildingTemplateSchema.parse(raw);
  const [minW, minD] = parsed.footprintRangeM.min;
  const [maxW, maxD] = parsed.footprintRangeM.max;
  if (minW > maxW || minD > maxD) {
    throw new Error(
      `Template "${parsed.id}" invalid footprintRangeM: min [${minW}, ${minD}] exceeds max [${maxW}, ${maxD}]`,
    );
  }
  for (const [name, knob] of Object.entries(parsed.knobSpace)) {
    if (knob.kind === "range") {
      if (knob.default < knob.min - 1e-9 || knob.default > knob.max + 1e-9) {
        throw new Error(
          `Template "${parsed.id}" knob "${name}" default ${knob.default} outside [${knob.min}, ${knob.max}]`,
        );
      }
      if (knob.integer && Math.ceil(knob.min) > Math.floor(knob.max)) {
        throw new Error(
          `Template "${parsed.id}" integer knob "${name}" has no integers in [${knob.min}, ${knob.max}]`,
        );
      }
    } else {
      const hasDefault = knob.options.some((o) => o.value === knob.default);
      if (!hasDefault) {
        throw new Error(
          `Template "${parsed.id}" choice knob "${name}" default "${String(knob.default)}" not in options`,
        );
      }
      const totalW = knob.options.reduce((s, o) => s + o.weight, 0);
      if (totalW <= 0) {
        throw new Error(`Template "${parsed.id}" choice knob "${name}" must have positive option weights`);
      }
    }
  }
  return parsed;
}

/**
 * Bridge a static InteriorGrammar into a ParametricBuildingTemplate without
 * duplicating grammar types. Adds safe architectural variation knobs around the
 * grammar's cell dimensions and storey height.
 */
export function createParametricTemplateFromGrammar(opts: {
  id: string;
  family: string;
  grammar: InteriorGrammarDoc;
  archetypes?: string[];
  extraKnobs?: Record<string, KnobSpec>;
  constraints?: TemplateConstraint[];
  districtRules?: DistrictNarrowingRule[];
  splatExperiment?: SplatExperimentMetadata;
}): ParametricBuildingTemplate {
  const parsedGrammar = InteriorGrammarSchema.parse(opts.grammar);
  const rows = parsedGrammar.plan.length;
  const cols = parsedGrammar.plan[0]?.length ?? 1;
  const baseW = cols * parsedGrammar.cellM;
  const baseD = rows * parsedGrammar.cellM;

  return parseParametricBuildingTemplate({
    schema: "mmo-parametric-building/1",
    id: opts.id,
    family: opts.family,
    sourceMode: "parametric-gn",
    archetypes: opts.archetypes ?? [opts.family],
    baseGrammarId: opts.id,
    footprintRangeM: {
      min: [Math.max(1, baseW * 0.8), Math.max(1, baseD * 0.8)],
      max: [baseW * 1.4, baseD * 1.4],
    },
    knobSpace: {
      floors: {
        kind: "range",
        min: 1,
        max: 3,
        step: 1,
        integer: true,
        default: 1,
        variationWeight: 0.65,
        legalConstraintTag: "storey-limit",
      },
      wallHeightM: {
        kind: "range",
        min: Math.max(2.2, parsedGrammar.wallHeightM * 0.85),
        max: parsedGrammar.wallHeightM * 1.25,
        step: 0.1,
        default: parsedGrammar.wallHeightM,
        variationWeight: 0.4,
      },
      widthM: {
        kind: "range",
        min: Math.max(1, baseW * 0.8),
        max: baseW * 1.4,
        step: 0.25,
        default: baseW,
        variationWeight: 0.5,
      },
      depthM: {
        kind: "range",
        min: Math.max(1, baseD * 0.8),
        max: baseD * 1.4,
        step: 0.25,
        default: baseD,
        variationWeight: 0.5,
      },
      roofForm: {
        kind: "choice",
        options: [
          { value: "gabled", weight: 0.5 },
          { value: "hipped", weight: 0.3 },
          { value: "flat-parapet", weight: 0.2 },
        ],
        default: "gabled",
        variationWeight: 0.8,
      },
      balconyType: {
        kind: "choice",
        options: [
          { value: "none", weight: 0.55 },
          { value: "timber", weight: 0.3 },
          { value: "stone", weight: 0.15 },
        ],
        default: "none",
        variationWeight: 0.7,
        legalConstraintTag: "requires-upper-floor",
      },
      ...opts.extraKnobs,
    },
    grammarConstraints: [
      {
        kind: "requires",
        id: "balcony-requires-upper-floor",
        whenKnob: "balconyType",
        whenNotEquals: "none",
        targetKnob: "floors",
        min: 2,
      },
      ...(opts.constraints ?? []),
    ],
    districtRules: opts.districtRules ?? [],
    splatExperiment: opts.splatExperiment,
  });
}

/**
 * Bridge a decomposed Unity StructurePrototype into a ParametricBuildingTemplate
 * so decomposed assets participate in bounded lot variation, weathering, and
 * provenance without losing their prototype identity.
 */
export function createParametricTemplateFromPrototype(opts: {
  prototype: StructurePrototype;
  id?: string;
  family?: string;
  extraKnobs?: Record<string, KnobSpec>;
  constraints?: TemplateConstraint[];
  districtRules?: DistrictNarrowingRule[];
  splatExperiment?: SplatExperimentMetadata;
}): ParametricBuildingTemplate {
  const proto = opts.prototype;
  const w = Math.max(1.5, proto.footprint[0]);
  const d = Math.max(1.5, proto.footprint[2]);
  const baseStoreys = Math.max(
    1,
    proto.storeys.length > 0 ? proto.storeys.length : Math.round(proto.footprint[1] / 3.2),
  );

  return parseParametricBuildingTemplate({
    schema: "mmo-parametric-building/1",
    id: opts.id ?? `proto-${proto.id}`,
    family: opts.family ?? proto.category,
    sourceMode: "static-decomposed",
    prototypeId: proto.id,
    archetypes: proto.settlementArchetypes.length > 0 ? proto.settlementArchetypes : [proto.category],
    footprintRangeM: {
      min: [Math.max(1, w * 0.75), Math.max(1, d * 0.75)],
      max: [w * 1.25, d * 1.25],
    },
    knobSpace: {
      floors: {
        kind: "range",
        min: Math.max(1, baseStoreys - 1),
        max: Math.max(1, baseStoreys + 1),
        step: 1,
        integer: true,
        default: baseStoreys,
        variationWeight: 0.35,
      },
      widthM: {
        kind: "range",
        min: Math.max(1, w * 0.75),
        max: w * 1.25,
        step: 0.25,
        default: w,
        variationWeight: 0.45,
      },
      depthM: {
        kind: "range",
        min: Math.max(1, d * 0.75),
        max: d * 1.25,
        step: 0.25,
        default: d,
        variationWeight: 0.45,
      },
      dressingDensity: {
        kind: "range",
        min: 0.35,
        max: 0.95,
        step: 0.05,
        default: 0.75,
        variationWeight: 0.6,
      },
      trimVariant: {
        kind: "choice",
        options: [
          { value: "standard", weight: 0.5 },
          { value: "weathered", weight: 0.3 },
          { value: "ornate", weight: 0.2 },
        ],
        default: "standard",
        variationWeight: 0.75,
      },
      ...opts.extraKnobs,
    },
    grammarConstraints: opts.constraints ?? [],
    districtRules: opts.districtRules ?? [],
    splatExperiment: opts.splatExperiment,
  });
}

function resolveDistrictRule(
  template: ParametricBuildingTemplate,
  district: string | DistrictNarrowingRule,
): DistrictNarrowingRule | undefined {
  if (typeof district !== "string") {
    return DistrictNarrowingRuleSchema.parse(district);
  }
  return template.districtRules.find((r) => r.district === district);
}

/**
 * Narrow a template's knob domains, variation weights, and structural limits for
 * a settlement district/ward rule. Throws if narrowing empties a domain.
 */
export function narrowTemplateForDistrict(
  template: ParametricBuildingTemplate,
  district: string | DistrictNarrowingRule,
): ParametricBuildingTemplate {
  const rule = resolveDistrictRule(template, district);
  if (!rule) return template;

  const nextKnobs: Record<string, KnobSpec> = {};
  for (const [name, spec] of Object.entries(template.knobSpace)) {
    const ov = rule.knobOverrides[name];
    if (!ov) {
      nextKnobs[name] = spec;
      continue;
    }

    if (spec.kind === "range") {
      let min = ov.min !== undefined ? Math.max(spec.min, ov.min) : spec.min;
      let max = ov.max !== undefined ? Math.min(spec.max, ov.max) : spec.max;
      if (ov.fixedValue !== undefined) {
        if (typeof ov.fixedValue !== "number") {
          throw new Error(`District "${rule.district}" fixedValue for range knob "${name}" must be numeric`);
        }
        min = Math.max(min, ov.fixedValue);
        max = Math.min(max, ov.fixedValue);
      }
      if (min > max) {
        throw new Error(
          `District "${rule.district}" narrowed range knob "${name}" to empty domain [${min}, ${max}]`,
        );
      }
      const nextWeight = spec.variationWeight * (ov.variationWeightMultiplier ?? 1);
      const snappedMin = spec.integer ? Math.ceil(min) : min;
      const snappedMax = spec.integer ? Math.floor(max) : max;
      if (snappedMin > snappedMax) {
        throw new Error(
          `District "${rule.district}" integer range knob "${name}" has no integers in [${min}, ${max}]`,
        );
      }
      const nextDefault = snapRangeValue({ ...spec, min, max }, clamp(spec.default, min, max));
      nextKnobs[name] = {
        ...spec,
        min,
        max,
        default: nextDefault,
        variationWeight: nextWeight,
      };
    } else {
      let options = spec.options.slice();
      if (ov.fixedValue !== undefined) {
        options = options.filter((o) => o.value === ov.fixedValue);
      } else if (ov.allowedValues !== undefined) {
        options = options.filter((o) => ov.allowedValues!.includes(o.value));
      }
      if (ov.optionWeightMultipliers) {
        options = options.map((o) => ({
          ...o,
          weight: o.weight * (ov.optionWeightMultipliers![String(o.value)] ?? 1),
        }));
      }
      options = options.filter((o) => o.weight > 0);
      if (options.length === 0) {
        throw new Error(
          `District "${rule.district}" narrowed choice knob "${name}" to zero positive-weight options`,
        );
      }
      const nextDefault = options.some((o) => o.value === spec.default)
        ? spec.default
        : options[0]!.value;
      nextKnobs[name] = {
        ...spec,
        options,
        default: nextDefault,
        variationWeight: spec.variationWeight * (ov.variationWeightMultiplier ?? 1),
      };
    }
  }

  const nextConstraints = template.grammarConstraints.slice();
  if (rule.maxFootprintM) {
    nextConstraints.push({
      kind: "footprint-bound",
      id: `district:${rule.district}:footprint`,
      maxWidthM: rule.maxFootprintM[0],
      maxDepthM: rule.maxFootprintM[1],
    });
  }
  if (rule.maxHeightM !== undefined && nextKnobs.floors) {
    nextConstraints.push({
      kind: "max-height",
      id: `district:${rule.district}:max-height`,
      maxHeightM: rule.maxHeightM,
      floorsKnob: "floors",
      floorHeightKnob: nextKnobs.wallHeightM ? "wallHeightM" : undefined,
      defaultFloorHeightM: 3.0,
    });
  }

  const nextMaxW = rule.maxFootprintM
    ? Math.min(template.footprintRangeM.max[0], rule.maxFootprintM[0])
    : template.footprintRangeM.max[0];
  const nextMaxD = rule.maxFootprintM
    ? Math.min(template.footprintRangeM.max[1], rule.maxFootprintM[1])
    : template.footprintRangeM.max[1];

  return parseParametricBuildingTemplate({
    ...template,
    footprintRangeM: {
      min: template.footprintRangeM.min,
      max: [nextMaxW, nextMaxD],
    },
    knobSpace: nextKnobs,
    grammarConstraints: nextConstraints,
  });
}

function deriveFootprintFromKnobs(
  template: ParametricBuildingTemplate,
  knobValues: Record<string, KnobValue>,
  parcelSizeM?: [number, number],
): [number, number] {
  const rawW = typeof knobValues.widthM === "number"
    ? knobValues.widthM
    : (template.footprintRangeM.min[0] + template.footprintRangeM.max[0]) * 0.5;
  const rawD = typeof knobValues.depthM === "number"
    ? knobValues.depthM
    : (template.footprintRangeM.min[1] + template.footprintRangeM.max[1]) * 0.5;
  const maxW = parcelSizeM ? Math.min(template.footprintRangeM.max[0], parcelSizeM[0]) : template.footprintRangeM.max[0];
  const maxD = parcelSizeM ? Math.min(template.footprintRangeM.max[1], parcelSizeM[1]) : template.footprintRangeM.max[1];
  return [
    Math.round(clamp(rawW, template.footprintRangeM.min[0], maxW) * 1000) / 1000,
    Math.round(clamp(rawD, template.footprintRangeM.min[1], maxD) * 1000) / 1000,
  ];
}

/**
 * Validate a candidate knob assignment against knob domains, parcel limits,
 * and all grammar constraints on the template.
 */
export function validateRolledKnobs(
  template: ParametricBuildingTemplate,
  knobValues: Record<string, KnobValue>,
  context?: { parcelSizeM?: [number, number] },
): KnobValidationResult {
  const violations: string[] = [];

  for (const [name, spec] of Object.entries(template.knobSpace)) {
    const val = knobValues[name];
    if (val === undefined) {
      violations.push(`Missing knob "${name}"`);
      continue;
    }
    if (spec.kind === "range") {
      if (typeof val !== "number" || !Number.isFinite(val)) {
        violations.push(`Knob "${name}" expected number, got ${typeof val}`);
        continue;
      }
      if (val < spec.min - 1e-6 || val > spec.max + 1e-6) {
        violations.push(`Knob "${name}"=${val} outside [${spec.min}, ${spec.max}]`);
      }
      if (spec.integer && Math.abs(val - Math.round(val)) > 1e-6) {
        violations.push(`Knob "${name}"=${val} must be an integer`);
      }
    } else if (!spec.options.some((o) => o.value === val)) {
      violations.push(`Knob "${name}"="${String(val)}" is not an allowed option`);
    }
  }

  const fp = deriveFootprintFromKnobs(template, knobValues);
  if (context?.parcelSizeM) {
    const [pw, pd] = context.parcelSizeM;
    if (fp[0] > pw + 1e-6 || fp[1] > pd + 1e-6) {
      violations.push(
        `Footprint [${fp[0]}, ${fp[1]}] exceeds parcel [${pw}, ${pd}]`,
      );
    }
  }

  for (const c of template.grammarConstraints) {
    if (c.kind === "footprint-bound") {
      const wVal = c.widthKnob && typeof knobValues[c.widthKnob] === "number"
        ? (knobValues[c.widthKnob] as number)
        : fp[0];
      const dVal = c.depthKnob && typeof knobValues[c.depthKnob] === "number"
        ? (knobValues[c.depthKnob] as number)
        : fp[1];
      if (c.minWidthM !== undefined && wVal < c.minWidthM - 1e-6) {
        violations.push(`${c.id}: width ${wVal} < minWidthM ${c.minWidthM}`);
      }
      if (c.maxWidthM !== undefined && wVal > c.maxWidthM + 1e-6) {
        violations.push(`${c.id}: width ${wVal} > maxWidthM ${c.maxWidthM}`);
      }
      if (c.minDepthM !== undefined && dVal < c.minDepthM - 1e-6) {
        violations.push(`${c.id}: depth ${dVal} < minDepthM ${c.minDepthM}`);
      }
      if (c.maxDepthM !== undefined && dVal > c.maxDepthM + 1e-6) {
        violations.push(`${c.id}: depth ${dVal} > maxDepthM ${c.maxDepthM}`);
      }
    } else if (c.kind === "max-height") {
      const floors = knobValues[c.floorsKnob];
      const floorH = c.floorHeightKnob && typeof knobValues[c.floorHeightKnob] === "number"
        ? (knobValues[c.floorHeightKnob] as number)
        : c.defaultFloorHeightM;
      const roofH = c.roofHeightKnob && typeof knobValues[c.roofHeightKnob] === "number"
        ? (knobValues[c.roofHeightKnob] as number)
        : 0;
      if (typeof floors === "number") {
        const totalH = floors * floorH + roofH;
        if (totalH > c.maxHeightM + 1e-6) {
          violations.push(`${c.id}: height ${totalH.toFixed(2)}m > maxHeightM ${c.maxHeightM}m`);
        }
      }
    } else if (c.kind === "requires") {
      const trigger = knobValues[c.whenKnob];
      const eqTriggered = c.whenEquals === undefined || trigger === c.whenEquals;
      const neqTriggered = c.whenNotEquals === undefined || trigger !== c.whenNotEquals;
      const minTriggered = c.whenMin === undefined || (typeof trigger === "number" && trigger >= c.whenMin);
      const triggered = eqTriggered && neqTriggered && minTriggered;
      if (triggered) {
        const target = knobValues[c.targetKnob];
        if (c.allowedValues && !c.allowedValues.includes(target!)) {
          violations.push(
            `${c.id}: ${c.whenKnob}=${String(trigger)} requires ${c.targetKnob} in [${c.allowedValues.join(", ")}]`,
          );
        }
        if (c.min !== undefined && (typeof target !== "number" || target < c.min - 1e-6)) {
          violations.push(`${c.id}: ${c.whenKnob}=${String(trigger)} requires ${c.targetKnob} >= ${c.min}`);
        }
        if (c.max !== undefined && (typeof target !== "number" || target > c.max + 1e-6)) {
          violations.push(`${c.id}: ${c.whenKnob}=${String(trigger)} requires ${c.targetKnob} <= ${c.max}`);
        }
      }
    } else if (c.kind === "forbids") {
      if (
        matchesValue(knobValues[c.knobA], c.equalsA) &&
        matchesValue(knobValues[c.knobB], c.equalsB)
      ) {
        violations.push(
          `${c.id}: forbids ${c.knobA}=${String(knobValues[c.knobA])} with ${c.knobB}=${String(knobValues[c.knobB])}`,
        );
      }
    } else if (c.kind === "sum-bound") {
      let sum = 0;
      let numeric = true;
      for (const k of c.knobs) {
        const v = knobValues[k];
        if (typeof v !== "number") {
          numeric = false;
          break;
        }
        sum += v;
      }
      if (numeric) {
        if (c.minSum !== undefined && sum < c.minSum - 1e-6) {
          violations.push(`${c.id}: sum(${c.knobs.join("+")})=${sum} < ${c.minSum}`);
        }
        if (c.maxSum !== undefined && sum > c.maxSum + 1e-6) {
          violations.push(`${c.id}: sum(${c.knobs.join("+")})=${sum} > ${c.maxSum}`);
        }
      }
    }
  }

  return { legal: violations.length === 0, violations };
}

function rollSingleKnob(spec: KnobSpec, rng: DeterministicRng): KnobValue {
  if (spec.kind === "range") {
    if (spec.variationWeight <= 0 || spec.max === spec.min) {
      return snapRangeValue(spec, spec.default);
    }
    const spread = clamp(spec.variationWeight, 0, 1);
    const discrete = enumerateDiscreteRange(spec);
    if (discrete.length > 1) {
      // Score each discrete candidate: when variationWeight is low, weights peak
      // sharply around default; as variationWeight approaches 1, distribution flattens.
      const span = Math.max(1e-6, spec.max - spec.min);
      const decay = (1 - spread) * 4.5;
      const picked = rng.pickWeighted(discrete, (v) => {
        const normDist = Math.abs(v - spec.default) / span;
        return Math.exp(-decay * normDist);
      });
      return picked ?? snapRangeValue(spec, spec.default);
    }
    const lo = spec.default - (spec.default - spec.min) * spread;
    const hi = spec.default + (spec.max - spec.default) * spread;
    const raw = lo + rng.next() * (hi - lo);
    return snapRangeValue(spec, raw);
  }

  if (spec.variationWeight <= 0) {
    return spec.default;
  }
  const activeProb = clamp(spec.variationWeight, 0, 1);
  if (activeProb < 1 && rng.next() > activeProb) {
    return spec.default;
  }
  const picked = rng.pickWeighted(spec.options, (o) => o.weight);
  return picked ? picked.value : spec.default;
}

function applyParcelBoundToTemplate(
  template: ParametricBuildingTemplate,
  parcelSizeM?: [number, number],
): ParametricBuildingTemplate {
  if (!parcelSizeM) return template;
  const [pw, pd] = parcelSizeM;
  const [minW, minD] = template.footprintRangeM.min;
  if (minW > pw + 1e-6 || minD > pd + 1e-6) {
    throw new Error(
      `Template "${template.id}" min footprint [${minW}, ${minD}] cannot fit parcel [${pw}, ${pd}]`,
    );
  }
  const nextKnobs: Record<string, KnobSpec> = { ...template.knobSpace };
  for (const [knobName, cap] of [
    ["widthM", pw],
    ["depthM", pd],
  ] as const) {
    const k = nextKnobs[knobName];
    if (k && k.kind === "range") {
      if (k.min > cap + 1e-6) {
        throw new Error(
          `Template "${template.id}" knob "${knobName}" min ${k.min} exceeds parcel bound ${cap}`,
        );
      }
      const nextMax = Math.min(k.max, cap);
      nextKnobs[knobName] = {
        ...k,
        max: nextMax,
        default: snapRangeValue({ ...k, max: nextMax }, Math.min(k.default, nextMax)),
      };
    }
  }
  return {
    ...template,
    footprintRangeM: {
      min: [minW, minD],
      max: [Math.min(template.footprintRangeM.max[0], pw), Math.min(template.footprintRangeM.max[1], pd)],
    },
    knobSpace: nextKnobs,
  };
}

/**
 * Deterministically roll every knob of a parametric template from `seed` within
 * district narrowing rules, parcel footprint bounds, and grammar constraints.
 */
export function rollLotVariation(
  template: ParametricBuildingTemplate,
  opts: LotVariationOptions,
): LotVariationRoll {
  const districtName = typeof opts.district === "string"
    ? opts.district
    : opts.district?.district;
  const narrowed = opts.district
    ? narrowTemplateForDistrict(template, opts.district)
    : template;
  const bounded = applyParcelBoundToTemplate(narrowed, opts.parcelSizeM);

  const overrides = opts.overrides ?? {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in bounded.knobSpace)) {
      throw new Error(`Override specifies unknown knob "${k}" on template "${bounded.id}"`);
    }
    const spec = bounded.knobSpace[k]!;
    if (spec.kind === "range" && (typeof v !== "number" || v < spec.min - 1e-6 || v > spec.max + 1e-6)) {
      throw new Error(`Override "${k}"=${v} outside narrowed domain [${spec.min}, ${spec.max}]`);
    }
    if (spec.kind === "choice" && !spec.options.some((o) => o.value === v)) {
      throw new Error(`Override "${k}"="${String(v)}" not permitted in narrowed options`);
    }
  }

  const rng = new DeterministicRng(opts.seed);
  const knobNames = Object.keys(bounded.knobSpace).sort();
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 64);

  let lastViolations: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate: Record<string, KnobValue> = {};
    for (const name of knobNames) {
      candidate[name] =
        name in overrides
          ? overrides[name]!
          : rollSingleKnob(bounded.knobSpace[name]!, rng);
    }

    const check = validateRolledKnobs(bounded, candidate, {
      parcelSizeM: opts.parcelSizeM,
    });
    if (check.legal) {
      return {
        templateId: bounded.id,
        family: bounded.family,
        sourceMode: bounded.sourceMode,
        seed: opts.seed,
        district: districtName,
        knobValues: candidate,
        rolledFootprintM: deriveFootprintFromKnobs(bounded, candidate, opts.parcelSizeM),
        appliedConstraints: bounded.grammarConstraints.map((c) => c.id),
        legal: true,
        attempts: attempt,
      };
    }
    lastViolations = check.violations;
  }

  // Fallback: try deterministic defaults + overrides if stochastic search failed
  // to hit a tight valid corner of the constraint polytope.
  const fallback: Record<string, KnobValue> = {};
  for (const name of knobNames) {
    const spec = bounded.knobSpace[name]!;
    fallback[name] =
      name in overrides
        ? overrides[name]!
        : spec.kind === "range"
          ? snapRangeValue(spec, spec.default)
          : spec.default;
  }
  const fallbackCheck = validateRolledKnobs(bounded, fallback, {
    parcelSizeM: opts.parcelSizeM,
  });
  if (fallbackCheck.legal) {
    return {
      templateId: bounded.id,
      family: bounded.family,
      sourceMode: bounded.sourceMode,
      seed: opts.seed,
      district: districtName,
      knobValues: fallback,
      rolledFootprintM: deriveFootprintFromKnobs(bounded, fallback, opts.parcelSizeM),
      appliedConstraints: bounded.grammarConstraints.map((c) => c.id),
      legal: true,
      attempts: maxAttempts + 1,
    };
  }

  throw new Error(
    `rollLotVariation("${bounded.id}", seed=${opts.seed}) failed grammar constraints after ${maxAttempts} attempts: ${[
      ...lastViolations,
      ...fallbackCheck.violations,
    ]
      .slice(0, 4)
      .join("; ")}`,
  );
}
