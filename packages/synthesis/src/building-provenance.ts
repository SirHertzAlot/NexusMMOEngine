/**
 * Per-building 5W1H provenance & Slice H adoption orchestrator.
 *
 * Records `template`, `seed`, `knobValues`, `weatheringInputs`, and
 * `layerPasses` alongside `@mmo-engine/art`'s `Provenance5W1H` fields so any
 * baked structure can answer "why does this house look like this" directly
 * from generated world data.
 */

import { z } from "zod";
import type { Provenance5W1H } from "@mmo-engine/art/browser";
import {
  BuildingWeatheringInputsSchema,
  WEATHERING_CHANNELS,
  evaluateBuildingWeatheringMask,
  type BuildingWeatheringInputParams,
  type BuildingWeatheringMask,
  type WeatheringChannel,
  type WeatheringSamplePoint,
} from "./building-weathering.js";
import {
  KnobPrimitiveSchema,
  SplatExperimentMetadataSchema,
  rollLotVariation,
  type DistrictNarrowingRule,
  type KnobValue,
  type LotVariationRoll,
  type ParametricBuildingTemplate,
  type SplatExperimentMetadata,
} from "./parametric-template.js";
import {
  generateSpilloverDetailLayer,
  type AdjacentStructureRef,
  type SpilloverLayerResult,
  type StructureDetailLayerInput,
  type StructureSurfaceInput,
  type StructureSurfaceRole,
} from "./structure-spillover.js";
import type { Aabb } from "./structure-checks.js";
import type { SynthesizedPlacement } from "./types.js";

export const LayerPassRecordSchema = z
  .object({
    layerId: z.string().min(1),
    assetSet: z.string().min(1),
    surface: z.string().min(1),
    seed: z.number().int(),
    tierScale: z.number().positive().finite(),
    candidateCount: z.number().int().nonnegative(),
    placedCount: z.number().int().nonnegative(),
    roleCounts: z
      .object({
        "wall-face": z.number().int().nonnegative(),
        seam: z.number().int().nonnegative(),
        ground: z.number().int().nonnegative(),
        "adjacent-wall": z.number().int().nonnegative(),
      })
      .strict(),
    treatment: z.enum(["cross-quad", "splat-overlay", "hybrid"]).default("cross-quad"),
    splatGateStatus: z.literal("rd-only").optional(),
  })
  .strict();

export type BuildingLayerPassRecord = z.infer<typeof LayerPassRecordSchema>;

const WeatheringChannelRecordSchema = z
  .object({
    moss: z.number().min(0).max(1),
    lichen: z.number().min(0).max(1),
    sunDried: z.number().min(0).max(1),
    cracking: z.number().min(0).max(1),
    dirt: z.number().min(0).max(1),
    soot: z.number().min(0).max(1),
    wornThresholds: z.number().min(0).max(1),
  })
  .strict();

export const BuildingTemplateProvenanceSchema = z
  .object({
    id: z.string().min(1),
    family: z.string().min(1),
    sourceMode: z.enum(["parametric-gn", "static-decomposed"]),
    prototypeId: z.string().min(1).optional(),
    baseGrammarId: z.string().min(1).optional(),
    splatExperiment: SplatExperimentMetadataSchema.optional(),
  })
  .strict();

export type BuildingTemplateProvenance = z.infer<typeof BuildingTemplateProvenanceSchema>;

export const BuildingProvenance5W1HSchema = z
  .object({
    schema: z.literal("mmo-building-provenance/1").default("mmo-building-provenance/1"),
    // Standard @mmo-engine/art Provenance5W1H narrative fields
    who: z.string().min(1),
    what: z.string().min(1),
    when: z.string().min(1),
    where: z.string().min(1),
    why: z.string().min(1),
    how: z.string().min(1),
    replaced: z.string().optional(),
    // Slice H structured fields
    buildingId: z.string().min(1),
    archetype: z.string().min(1),
    district: z.string().min(1).optional(),
    template: BuildingTemplateProvenanceSchema,
    seed: z.number().int(),
    knobValues: z.record(z.string().min(1), KnobPrimitiveSchema),
    appliedConstraints: z.array(z.string()).default([]),
    weatheringInputs: BuildingWeatheringInputsSchema,
    weatheringSummary: z
      .object({
        meanChannels: WeatheringChannelRecordSchema,
        maxChannels: WeatheringChannelRecordSchema,
        dominantTraits: z.array(z.enum(WEATHERING_CHANNELS)),
      })
      .strict(),
    layerPasses: z.array(LayerPassRecordSchema),
  })
  .strict();

export type BuildingProvenance5W1H = z.infer<typeof BuildingProvenance5W1HSchema>;

// Compile-time guarantee that BuildingProvenance5W1H satisfies @mmo-engine/art's Provenance5W1H.
type _AssertArtProvenanceCompat = BuildingProvenance5W1H extends Provenance5W1H ? true : never;
const _compatCheck: _AssertArtProvenanceCompat = true;
void _compatCheck;

export interface BuildBuildingProvenanceInput {
  buildingId: string;
  archetype: string;
  template: {
    id: string;
    family: string;
    sourceMode: "parametric-gn" | "static-decomposed";
    prototypeId?: string;
    baseGrammarId?: string;
    splatExperiment?: SplatExperimentMetadata;
  };
  seed: number;
  district?: string;
  knobValues: Record<string, KnobValue>;
  appliedConstraints?: string[];
  weatheringMask: BuildingWeatheringMask;
  spilloverResults?: readonly SpilloverLayerResult[];
  /** Optional 5W1H context overrides. */
  who?: string;
  when?: string;
  where?: string;
  replaced?: string;
}

export interface BuildingAppearanceExplanation {
  summary: string;
  fiveWOneH: Provenance5W1H;
  byField: {
    template: string;
    seed: string;
    knobValues: Record<string, string>;
    weatheringInputs: string;
    weatheringChannels: Record<WeatheringChannel, string>;
    layerPasses: Array<{ layerId: string; explanation: string }>;
  };
}

export interface BuildingAdoptionPipelineOptions {
  buildingId: string;
  archetype: string;
  template: ParametricBuildingTemplate;
  seed: number;
  parcelSizeM?: [number, number];
  district?: string | DistrictNarrowingRule;
  overrides?: Record<string, KnobValue>;
  /** Reuse a precomputed lot variation roll instead of rolling twice. */
  preRolledVariation?: LotVariationRoll;
  weatheringInputs: BuildingWeatheringInputParams;
  /** Surface points or synthesized placements used to evaluate building weathering & spillover. */
  placements?: readonly SynthesizedPlacement[];
  weatheringSamples?: readonly WeatheringSamplePoint[];
  buildingBox?: Aabb;
  adjacentStructures?: readonly AdjacentStructureRef[];
  spilloverLayers?: readonly StructureDetailLayerInput[];
  tierScale?: number;
  provenanceContext?: {
    who?: string;
    when?: string;
    where?: string;
    replaced?: string;
  };
}

export interface BuildingAdoptionResult {
  variation: LotVariationRoll;
  weatheringMask: BuildingWeatheringMask;
  spilloverLayers: SpilloverLayerResult[];
  provenance: BuildingProvenance5W1H;
}

function toLayerPassRecord(res: SpilloverLayerResult): BuildingLayerPassRecord {
  const roleCounts: Record<StructureSurfaceRole, number> = {
    "wall-face": res.roleCounts["wall-face"],
    seam: res.roleCounts.seam,
    ground: res.roleCounts.ground,
    "adjacent-wall": res.roleCounts["adjacent-wall"],
  };
  return {
    layerId: res.layerId,
    assetSet: res.assetSet,
    surface: res.surface,
    seed: res.seed,
    tierScale: res.tierScale,
    candidateCount: res.candidateCount,
    placedCount: res.placements.length,
    roleCounts,
    treatment: res.splatExperiment?.requestedTreatment ?? "cross-quad",
    ...(res.splatExperiment ? { splatGateStatus: res.splatExperiment.gateStatus } : {}),
  };
}

/**
 * Build and Zod-validate a complete 5W1H provenance record combining
 * `@mmo-engine/art` provenance metadata with Slice H structured fields.
 */
export function buildBuildingProvenance5W1H(
  input: BuildBuildingProvenanceInput,
): BuildingProvenance5W1H {
  const layerPasses = (input.spilloverResults ?? []).map(toLayerPassRecord);
  const wInputs = input.weatheringMask.inputs;
  const traits = input.weatheringMask.dominantTraits;
  const knobSummary = Object.entries(input.knobValues)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  const totalSpill = layerPasses.reduce((sum, p) => sum + p.placedCount, 0);

  const who = input.who ?? "@mmo-engine/synthesis (Slice H building bake)";
  const what = `Baked ${input.archetype} "${input.buildingId}" from template "${input.template.id}" (${input.template.family}, ${input.template.sourceMode})`;
  const when = input.when ?? `settlement-age=${wInputs.buildingAgeYears}y`;
  const where =
    input.where ??
    (input.district
      ? `district=${input.district}, aspect=${wInputs.aspectDeg}deg, groundY=${wInputs.groundY}m`
      : `aspect=${wInputs.aspectDeg}deg, groundY=${wInputs.groundY}m`);
  const why =
    `Deterministic lot roll from seed=${input.seed}` +
    (input.district ? ` constrained to district "${input.district}"` : "") +
    `; weathering driven by moisture=${wInputs.moisture}, aspect=${wInputs.aspectDeg}deg, age=${wInputs.buildingAgeYears}y` +
    (traits.length > 0 ? ` (dominant traits: ${traits.join(", ")})` : " (clean/unweathered)");
  const how =
    `Knobs [${knobSummary || "none"}]; ` +
    `${layerPasses.length} spillover pass(es) placing ${totalSpill} detail instances`;

  return BuildingProvenance5W1HSchema.parse({
    schema: "mmo-building-provenance/1",
    who,
    what,
    when,
    where,
    why,
    how,
    ...(input.replaced ? { replaced: input.replaced } : {}),
    buildingId: input.buildingId,
    archetype: input.archetype,
    ...(input.district ? { district: input.district } : {}),
    template: {
      id: input.template.id,
      family: input.template.family,
      sourceMode: input.template.sourceMode,
      ...(input.template.prototypeId ? { prototypeId: input.template.prototypeId } : {}),
      ...(input.template.baseGrammarId ? { baseGrammarId: input.template.baseGrammarId } : {}),
      ...(input.template.splatExperiment ? { splatExperiment: input.template.splatExperiment } : {}),
    },
    seed: input.seed,
    knobValues: input.knobValues,
    appliedConstraints: input.appliedConstraints ?? [],
    weatheringInputs: wInputs,
    weatheringSummary: {
      meanChannels: input.weatheringMask.meanChannels,
      maxChannels: input.weatheringMask.maxChannels,
      dominantTraits: input.weatheringMask.dominantTraits,
    },
    layerPasses,
  });
}

/**
 * Parse and validate an untyped provenance payload.
 */
export function parseBuildingProvenance5W1H(raw: unknown): BuildingProvenance5W1H {
  return BuildingProvenance5W1HSchema.parse(raw);
}

/**
 * Answer "why does this house look like this" field by field directly from a
 * building's persisted 5W1H provenance record.
 */
export function explainBuildingAppearance(
  rawProvenance: BuildingProvenance5W1H,
): BuildingAppearanceExplanation {
  const p = BuildingProvenance5W1HSchema.parse(rawProvenance);
  const knobExplanations: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.knobValues)) {
    knobExplanations[k] =
      `Rolled value ${String(v)} from template "${p.template.id}" under seed=${p.seed}` +
      (p.district ? ` and district "${p.district}" rules` : "") +
      (p.appliedConstraints.length > 0
        ? ` obeying constraints [${p.appliedConstraints.join(", ")}]`
        : "");
  }

  const w = p.weatheringInputs;
  const weatheringChannels = {} as Record<WeatheringChannel, string>;
  for (const ch of WEATHERING_CHANNELS) {
    const mean = p.weatheringSummary.meanChannels[ch];
    const max = p.weatheringSummary.maxChannels[ch];
    let cause: string;
    if (ch === "moss" || ch === "lichen") {
      cause = `moisture=${w.moisture} and surface shade (aspect=${w.aspectDeg}deg vs sun=${w.sunAzimuthDeg}deg)`;
    } else if (ch === "sunDried") {
      cause = `sun exposure (aspect=${w.aspectDeg}deg vs sun=${w.sunAzimuthDeg}deg) and inverse moisture (${(1 - w.moisture).toFixed(2)})`;
    } else if (ch === "soot") {
      cause = `buildingAgeYears=${w.buildingAgeYears}, hearthActivity=${w.hearthActivity}, chimneys=${w.chimneyPositions.length}`;
    } else if (ch === "wornThresholds") {
      cause = `buildingAgeYears=${w.buildingAgeYears}, footTraffic=${w.footTraffic}, thresholds=${w.thresholdPositions.length}`;
    } else {
      cause = `settlement age=${w.buildingAgeYears}y and moisture=${w.moisture}`;
    }
    weatheringChannels[ch] = `mean=${mean.toFixed(3)}, max=${max.toFixed(3)} driven by ${cause}`;
  }

  const layerPasses = p.layerPasses.map((lp) => ({
    layerId: lp.layerId,
    explanation:
      `Surface "${lp.surface}" (${lp.assetSet}, seed=${lp.seed}, tierScale=${lp.tierScale}) placed ${lp.placedCount}/${lp.candidateCount} ` +
      `[wall=${lp.roleCounts["wall-face"]}, seam=${lp.roleCounts.seam}, ground=${lp.roleCounts.ground}, adjacent=${lp.roleCounts["adjacent-wall"]}] ` +
      `using ${lp.treatment}` +
      (lp.splatGateStatus ? ` (splat gate: ${lp.splatGateStatus})` : ""),
  }));

  return {
    summary: `${p.what}. ${p.why}. ${p.how}.`,
    fiveWOneH: {
      who: p.who,
      what: p.what,
      when: p.when,
      where: p.where,
      why: p.why,
      how: p.how,
      ...(p.replaced ? { replaced: p.replaced } : {}),
    },
    byField: {
      template:
        `Template "${p.template.id}" (family="${p.template.family}", mode="${p.template.sourceMode}"` +
        (p.template.prototypeId ? `, prototype="${p.template.prototypeId}"` : "") +
        (p.template.baseGrammarId ? `, grammar="${p.template.baseGrammarId}"` : "") +
        `)`,
      seed: `Deterministic lot seed ${p.seed}`,
      knobValues: knobExplanations,
      weatheringInputs:
        `moisture=${w.moisture}, aspectDeg=${w.aspectDeg}, buildingAgeYears=${w.buildingAgeYears}, ` +
        `chimneys=${w.chimneyPositions.length}, thresholds=${w.thresholdPositions.length}`,
      weatheringChannels,
      layerPasses,
    },
  };
}

/**
 * Execute the Slice H parametric adoption stages cleanly:
 *   1. Deterministic lot variation roll within district/grammar constraints
 *   2. Building weathering & personality mask evaluation
 *   3. Structure-surface spillover detail passes across seams & nearby structures
 *   4. Per-building 5W1H provenance emission
 */
export function runBuildingAdoptionPipeline(
  opts: BuildingAdoptionPipelineOptions,
): BuildingAdoptionResult {
  const variation =
    opts.preRolledVariation ??
    rollLotVariation(opts.template, {
      seed: opts.seed,
      parcelSizeM: opts.parcelSizeM,
      district: opts.district,
      overrides: opts.overrides,
    });

  const wInputs = BuildingWeatheringInputsSchema.parse({
    seed: opts.seed,
    ...opts.weatheringInputs,
  });

  const defaultBox: Aabb = opts.buildingBox ?? {
    min: [-variation.rolledFootprintM[0] * 0.5, wInputs.groundY, -variation.rolledFootprintM[1] * 0.5],
    max: [
      variation.rolledFootprintM[0] * 0.5,
      wInputs.groundY +
        (typeof variation.knobValues.floors === "number" ? variation.knobValues.floors : 1) *
          (typeof variation.knobValues.wallHeightM === "number" ? variation.knobValues.wallHeightM : 3.0),
      variation.rolledFootprintM[1] * 0.5,
    ],
  };

  const sampleSource =
    opts.weatheringSamples && opts.weatheringSamples.length > 0
      ? opts.weatheringSamples
      : opts.placements && opts.placements.length > 0
        ? opts.placements
        : [];

  const weatheringMask = evaluateBuildingWeatheringMask(wInputs, sampleSource);

  const surfaceInput: StructureSurfaceInput = {
    buildingId: opts.buildingId,
    ...(opts.placements && opts.placements.length > 0 && !opts.buildingBox
      ? { placements: opts.placements }
      : { buildingBox: defaultBox }),
    groundY: wInputs.groundY,
    weatheringInputs: wInputs,
    adjacentStructures: opts.adjacentStructures,
  };

  const spilloverLayers = (opts.spilloverLayers ?? []).map((layer) =>
    generateSpilloverDetailLayer(layer, surfaceInput, opts.tierScale ?? 1),
  );

  const provenance = buildBuildingProvenance5W1H({
    buildingId: opts.buildingId,
    archetype: opts.archetype,
    template: {
      id: opts.template.id,
      family: opts.template.family,
      sourceMode: opts.template.sourceMode,
      prototypeId: opts.template.prototypeId,
      baseGrammarId: opts.template.baseGrammarId,
      splatExperiment: opts.template.splatExperiment,
    },
    seed: opts.seed,
    district: variation.district,
    knobValues: variation.knobValues,
    appliedConstraints: variation.appliedConstraints,
    weatheringMask,
    spilloverResults: spilloverLayers,
    ...opts.provenanceContext,
  });

  return {
    variation,
    weatheringMask,
    spilloverLayers,
    provenance,
  };
}
