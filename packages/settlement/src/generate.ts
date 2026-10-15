/**
 * The generator: a request runs through the stages in order, each reading
 * what the one before wrote, and the result is a manifest, or the stage that
 * failed and why (no exceptions across the API, spec §29.10). Stages are
 * small and independently testable; the manifest is canonical, so its hash
 * identifies the town.
 */

import { WfcError } from "@mmo-engine/wfc";
import { bakeDemographics } from "./demographics.js";
import { solveDemand } from "./demand.js";
import { EventLog, type GenerationEvent, type Verbosity } from "./events.js";
import { contentHash } from "./hash.js";
import { layOut } from "./layout.js";
import { occupy } from "./occupancy.js";
import { streams, type Streams } from "./rng.js";
import { BUILTIN_RULES, type SettlementRules } from "./rules.js";
import { placeStructures } from "./structures.js";
import { validateTown, type Gate, type Town } from "./validate.js";

export const GENERATOR_VERSION = "settlement-gen/0.1.0";
export const MANIFEST_FORMAT = "mmo-settlement/1";

export interface SettlementRequest {
  settlementId: string;
  seed: number;
  population: number;
  rules?: SettlementRules;
  /** The building factor (`resolveScale(doc, "building")`) the town is laid out at; default 1. */
  scale?: number;
  verbosity?: Verbosity;
}

export interface SettlementManifest {
  format: typeof MANIFEST_FORMAT;
  hash: string;
  generatorVersion: string;
  rulesVersion: string;
  settlementId: string;
  seed: number;
  /** The building factor the parcels and streets were baked at: a different scale is a different town (and hash). */
  scale: number;
  determinism: { rngStreams: Record<string, number>; sortPolicy: "id"; units: "millimeters" };
  demographics: Town["demographics"];
  demand: Town["demand"];
  roads: Town["layout"]["roads"];
  districts: Town["layout"]["districts"];
  parcels: Town["layout"]["parcels"];
  structures: Town["structures"];
  occupancy: Town["occupancy"];
  validation: Gate[];
}

export interface GenerationError {
  stage: string;
  code: string;
  message: string;
}

export type GenerationResult = { ok: true; manifest: SettlementManifest; events: GenerationEvent[] } | { ok: false; error: GenerationError; events: GenerationEvent[] };

interface Context {
  request: SettlementRequest;
  rules: SettlementRules;
  rng: Streams;
  events: EventLog;
  town: Partial<Town>;
  validation: Gate[];
}

interface Stage {
  name: string;
  run(ctx: Context): void;
}

class StageFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const STAGES: Stage[] = [
  {
    name: "demographics",
    run(ctx) {
      const d = bakeDemographics(ctx.request.population, ctx.rules.demographics);
      ctx.town.demographics = d;
      ctx.events.emit("summary", "demographics", "baked", { population: d.population, households: d.households, laborPool: d.laborPool });
    },
  },
  {
    name: "demand",
    run(ctx) {
      const demand = solveDemand(ctx.town.demographics!, ctx.rules);
      ctx.town.demand = demand;
      ctx.events.emit("summary", "demand", "solved", { housing: demand.housingDemand, food: demand.foodDemand, required: demand.required });
    },
  },
  {
    name: "layout",
    run(ctx) {
      const layout = layOut(ctx.request.settlementId, ctx.town.demographics!.households, ctx.rules, ctx.rng, ctx.request.scale ?? 1);
      ctx.town.layout = layout;
      ctx.events.emit("summary", "layout", "laid_out", { blocks: layout.blocks, parcels: layout.parcels.length, junctions: layout.roads.nodes.length });
    },
  },
  {
    name: "structures",
    run(ctx) {
      const { layout, demand } = ctx.town;
      const structures = placeStructures(layout!, demand!, ctx.rules, ctx.rng);
      ctx.town.structures = structures;
      ctx.events.emit("summary", "structures", "placed", { structures: structures.length });
      for (const s of structures) ctx.events.emit("verbose", "structures", "structure_collapsed", { target: s.parcel, chosen: s.archetype });
    },
  },
  {
    name: "occupancy",
    run(ctx) {
      const { demographics, structures } = ctx.town;
      const o = occupy(ctx.request.settlementId, demographics!, structures!, ctx.rules, ctx.rng);
      ctx.town.occupancy = o;
      const employed = o.npcs.filter((n) => n.workplace).length;
      ctx.events.emit("summary", "occupancy", "settled", { households: o.households.length, npcs: o.npcs.length, employed, shops: o.shops.length });
    },
  },
  {
    name: "validation",
    run(ctx) {
      ctx.validation = validateTown(ctx.town as Town, ctx.rules);
      const failed = ctx.validation.filter((g) => !g.ok);
      ctx.events.emit("summary", "validation", "checked", { gates: ctx.validation.length, failed: failed.length });
      if (failed.length) throw new StageFailure("gate_failed", failed.map((g) => `${g.gate}: ${g.detail}`).join("; "));
    },
  },
];

export function generateSettlement(request: SettlementRequest): GenerationResult {
  const events = new EventLog();
  const verbosity = request.verbosity ?? "normal";
  const fail = (stage: string, code: string, message: string): GenerationResult => ({ ok: false, error: { stage, code, message }, events: events.events(verbosity) });
  if (!Number.isInteger(request.population) || request.population < 1) return fail("request", "bad_population", "population must be a positive whole number");

  if (request.scale !== undefined && !(request.scale > 0 && Number.isFinite(request.scale))) return fail("request", "bad_scale", "scale must be a positive number");

  const ctx: Context = { request, rules: request.rules ?? BUILTIN_RULES, rng: streams(request.seed), events, town: {}, validation: [] };
  for (const stage of STAGES) {
    try {
      stage.run(ctx);
    } catch (err) {
      if (err instanceof StageFailure) return fail(stage.name, err.code, err.message);
      if (err instanceof WfcError) return fail(stage.name, "unsolvable", err.message);
      throw err;
    }
  }

  const { demographics, demand, layout, structures, occupancy } = ctx.town as Town;
  const body = {
    format: MANIFEST_FORMAT as typeof MANIFEST_FORMAT,
    generatorVersion: GENERATOR_VERSION,
    rulesVersion: ctx.rules.version,
    settlementId: request.settlementId,
    seed: request.seed,
    scale: request.scale ?? 1,
    determinism: { rngStreams: ctx.rng.seeds(), sortPolicy: "id" as const, units: "millimeters" as const },
    demographics,
    demand,
    roads: layout.roads,
    districts: layout.districts,
    parcels: layout.parcels,
    structures,
    occupancy,
    validation: ctx.validation,
  };
  const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const sorted = { ...body, districts: byId(body.districts), parcels: byId(body.parcels), structures: byId(body.structures), occupancy: { households: byId(occupancy.households), npcs: byId(occupancy.npcs), shops: byId(occupancy.shops) } };
  return { ok: true, manifest: { ...sorted, hash: contentHash(sorted) }, events: events.events(verbosity) };
}
