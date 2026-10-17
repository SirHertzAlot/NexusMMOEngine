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
import { FOOTPRINT_SAMPLES, layOut, plotIsDry, scaledLayout, townCentreMm } from "./layout.js";
import { occupy } from "./occupancy.js";
import { streams, type Streams } from "./rng.js";
import { BUILTIN_RULES, type SettlementRules } from "./rules.js";
import { placeStructures } from "./structures.js";
import { validateTown, type Gate, type Town } from "./validate.js";

/** How many block rows a town beside water may grow to make up for its wet parcels. */
const MAX_EXTRA_BLOCKS = 3;

export const GENERATOR_VERSION = "settlement-gen/0.3.0";
export const MANIFEST_FORMAT = "mmo-settlement/1";

export interface SettlementRequest {
  settlementId: string;
  seed: number;
  population: number;
  rules?: SettlementRules;
  /** The building factor (`resolveScale(doc, "building")`) the town is laid out at; default 1. */
  scale?: number;
  /**
   * Where the town will stand (the scene's origin, world metres [x, z]) and the world's dryness test at a world
   * point. A parcel whose footprint (centre, corners, edge midpoints) is not dry is dropped before the structures
   * are solved: the town is built on what is left, or fails with the solver's reason. Without it, the ground is not considered.
   */
  site?: { origin: [number, number]; dry: (x: number, z: number) => boolean };
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
  /** Whether the town is walled, and its wall pieces (towers, gates, wall) in id order; none for an open village. */
  walled: boolean;
  /** Wall pieces left out where water stands (the town is open to the water there); 0 for a full ring. */
  wallOpenToWater: number;
  fortifications: Town["layout"]["fortifications"];
  /** The town square at the centre (a village green), null where water took it. */
  square: Town["layout"]["square"];
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
      ctx.events.emit("summary", "layout", "laid_out", { blocks: layout.blocks, parcels: layout.parcels.length, junctions: layout.roads.nodes.length, walled: layout.walled, wallPieces: layout.fortifications.length });
    },
  },
  {
    name: "structures",
    run(ctx) {
      const { demand } = ctx.town;
      const site = ctx.request.site;
      let layout = ctx.town.layout!;
      let structures;
      if (!site) structures = placeStructures(layout, demand!, ctx.rules, ctx.rng);
      else {
        // The wet parcels are not part of the town: the solve, the gates and the manifest see only the dry ones.
        // Losing some may leave too little to house and serve everyone, so the grid grows a block row at a time
        // (a bigger town, laid out again) until the demand is met, up to MAX_EXTRA_BLOCKS; then it fails, saying why.
        const [pw, pd] = scaledLayout(ctx.rules, ctx.request.scale ?? 1).parcelMm;
        let failure = "";
        for (let extra = 0; extra <= MAX_EXTRA_BLOCKS && !structures; extra++) {
          // Laid out again knowing the ground, so the quarters keep to dry blocks; the "districts" stream is
          // re-forked so every attempt picks from the same draw.
          const dryMm = (dx: number, dz: number): boolean => site.dry(site.origin[0] + dx / 1000, site.origin[1] + dz / 1000);
          const full = layOut(ctx.request.settlementId, ctx.town.demographics!.households, ctx.rules, streams(ctx.request.seed), ctx.request.scale ?? 1, extra, dryMm);
          const c = townCentreMm(full.roads.nodes);
          // A farm stays only if its fields are dry too.
          const dry = (p: (typeof full.parcels)[number]): boolean =>
            plotIsDry(p, pw, pd, c, dryMm) && (!p.holding || FOOTPRINT_SAMPLES.every((fx) => FOOTPRINT_SAMPLES.every((fz) => dryMm(p.holding!.center.x + fx * p.holding!.sizeXMm - c.x, p.holding!.center.z + fz * p.holding!.sizeZMm - c.z))));
          // The wall is not built in the water: a piece whose footprint is not dry is left out, and the town is open on that side.
          const dryPiece = (w: (typeof full.fortifications)[number]): boolean => {
            for (const fa of FOOTPRINT_SAMPLES) for (const fb of FOOTPRINT_SAMPLES) {
              const [dx, dz] = w.yawDeg === 0 ? [fa * w.lengthMm, fb * w.thicknessMm] : [fb * w.thicknessMm, fa * w.lengthMm];
              if (!site.dry(site.origin[0] + (w.center.x + dx - c.x) / 1000, site.origin[1] + (w.center.z + dz - c.z) / 1000)) return false;
            }
            return true;
          };
          const fortifications = full.fortifications.filter(dryPiece);
          // The square stays only if its whole paving is dry.
          const sq = full.square;
          const squareDry = sq !== null && FOOTPRINT_SAMPLES.every((fx) => FOOTPRINT_SAMPLES.every((fz) => site.dry(site.origin[0] + (sq.center.x + fx * sq.widthMm - c.x) / 1000, site.origin[1] + (sq.center.z + fz * sq.depthMm - c.z) / 1000)));
          const kept = { ...full, parcels: full.parcels.filter(dry), fortifications, wallOpenToWater: full.fortifications.length - fortifications.length, square: squareDry ? sq : null };
          ctx.events.emit("summary", "structures", "wet_parcels_dropped", { extraBlocks: extra, dropped: full.parcels.length - kept.parcels.length, kept: kept.parcels.length });
          try {
            structures = placeStructures(kept, demand!, ctx.rules, ctx.rng);
            layout = kept;
          } catch (err) {
            if (!(err instanceof WfcError)) throw err;
            failure = `${err.message}; ${full.parcels.length - kept.parcels.length} of ${full.parcels.length} parcels are not dry`;
          }
        }
        if (!structures) throw new StageFailure("unsolvable", `the site is too wet for the town (no dry layout up to ${MAX_EXTRA_BLOCKS} extra block rows): ${failure}; choose a drier site`);
        ctx.town.layout = layout;
      }
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
      ctx.validation = validateTown(ctx.town as Town, ctx.rules, ctx.request.scale ?? 1);
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
    walled: layout.walled,
    wallOpenToWater: layout.wallOpenToWater,
    fortifications: layout.fortifications,
    square: layout.square,
    structures,
    occupancy,
    validation: ctx.validation,
  };
  const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const sorted = { ...body, districts: byId(body.districts), parcels: byId(body.parcels), fortifications: byId(body.fortifications), structures: byId(body.structures), occupancy: { households: byId(occupancy.households), npcs: byId(occupancy.npcs), shops: byId(occupancy.shops) } };
  return { ok: true, manifest: { ...sorted, hash: contentHash(sorted) }, events: events.events(verbosity) };
}
