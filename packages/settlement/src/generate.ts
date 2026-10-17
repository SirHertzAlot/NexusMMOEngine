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
import { drawMastery } from "./mastery.js";
import { drawHomeless, townSetting, withDensity } from "./setting.js";
import { occupy } from "./occupancy.js";
import { placeProps, propBox } from "./props.js";
import { streams, type Streams } from "./rng.js";
import { ACCESS, BUILTIN_RULES, type Access, type SettlementRules } from "./rules.js";
import { placeStructures } from "./structures.js";
import { validateTown, type Gate, type Town } from "./validate.js";

/** How many block rows a town beside water may grow to make up for its wet parcels. */
const MAX_EXTRA_BLOCKS = 3;

export const GENERATOR_VERSION = "settlement-gen/0.5.0";
export const MANIFEST_FORMAT = "mmo-settlement/1";

export interface SettlementRequest {
  settlementId: string;
  seed: number;
  population: number;
  /**
   * How the town is reached (rules.settings; `siteAccess` reads it off a site): caps the population and sets how
   * densely it lives. Without it the population stands as asked and the layout is the rules' own.
   */
  access?: Access;
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
  /** How the town is reached, how densely it lives, and the people asked for against the people its access keeps. */
  setting: Town["setting"];
  demographics: Town["demographics"];
  /** The town's masters by profession, the master communities, and the residents and visitors they draw. */
  mastery: Town["mastery"];
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
  /** Street furniture and dressing (lamps, benches, fountains, statues, barrels, planters) and the terraces with their stairs, in id order. */
  props: Town["props"];
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
      // The town's setting first: its access caps the people and sets the density every later stage lays out by.
      const setting = townSetting(ctx.request.population, ctx.request.access, ctx.rules, ctx.rng);
      ctx.town.setting = setting;
      ctx.rules = withDensity(ctx.rules, setting.densityPermille, setting.trend);
      if (setting.population < setting.requestedPopulation) ctx.events.emit("summary", "demographics", "capped", { access: setting.access, requested: setting.requestedPopulation, capacity: setting.capacity });
      // The town's masters next: the people they draw to live there are part of its population.
      const mastery = drawMastery(setting.population, ctx.rules, ctx.rng, setting.access ? ctx.rules.settings.access[setting.access].masteryPermille : 1000);
      ctx.town.mastery = mastery;
      const people = setting.population + mastery.residents;
      const d = bakeDemographics(people, ctx.rules.demographics, drawHomeless(people, setting.densityPermille, ctx.rules, ctx.rng));
      ctx.town.demographics = d;
      ctx.events.emit("summary", "demographics", "baked", { population: d.population, households: d.households, homeless: d.homeless, laborPool: d.laborPool, access: setting.access, densityPermille: setting.densityPermille, trend: setting.trend, masters: mastery.masters, communities: mastery.communities, grandMasters: mastery.grandMasters, discipline: mastery.discipline, pupils: mastery.pupils, visitors: mastery.visitors });
    },
  },
  {
    name: "demand",
    run(ctx) {
      const demand = solveDemand(ctx.town.demographics!, ctx.rules, ctx.town.mastery);
      ctx.town.demand = demand;
      ctx.events.emit("summary", "demand", "solved", { housing: demand.housingDemand, food: demand.foodDemand, required: demand.required });
    },
  },
  {
    name: "layout",
    run(ctx) {
      const layout = layOut(ctx.request.settlementId, ctx.town.demographics!.households, ctx.rules, ctx.rng, ctx.request.scale ?? 1, 0, undefined, ctx.town.mastery);
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
          const full = layOut(ctx.request.settlementId, ctx.town.demographics!.households, ctx.rules, streams(ctx.request.seed), ctx.request.scale ?? 1, extra, dryMm, ctx.town.mastery);
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
          // No paving is laid in the water: a paved street whose slab (over its crossings) is not all dry stays a track.
          const at = new Map(full.roads.nodes.map((n) => [n.id, n]));
          const slabDry = (e: (typeof full.roads.edges)[number]): boolean => {
            const a = at.get(e.from)!;
            const b = at.get(e.to)!;
            const [w, d] = a.z === b.z ? [Math.abs(b.x - a.x) + e.widthMm, e.widthMm] : [e.widthMm, Math.abs(b.z - a.z) + e.widthMm];
            return FOOTPRINT_SAMPLES.every((fx) => FOOTPRINT_SAMPLES.every((fz) => dryMm((a.x + b.x) / 2 + fx * w - c.x, (a.z + b.z) / 2 + fz * d - c.z)));
          };
          const edges = full.roads.edges.map((e) => (e.surface === "paved" && !slabDry(e) ? { ...e, surface: "dirt" as const } : e));
          const kept = { ...full, roads: { ...full.roads, edges }, parcels: full.parcels.filter(dry), fortifications, wallOpenToWater: full.fortifications.length - fortifications.length, square: squareDry ? sq : null };
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
      const o = occupy(ctx.request.settlementId, demographics!, structures!, ctx.rules, ctx.rng, ctx.town.mastery!.grandMasters);
      ctx.town.occupancy = o;
      const employed = o.npcs.filter((n) => n.workplace).length;
      ctx.events.emit("summary", "occupancy", "settled", { households: o.households.length, npcs: o.npcs.length, employed, shops: o.shops.length });
    },
  },
  {
    name: "props",
    run(ctx) {
      const { layout, structures, occupancy, demographics } = ctx.town;
      const scale = ctx.request.scale ?? 1;
      let props = placeProps(ctx.request.settlementId, layout!, structures!, occupancy!, demographics!.population, ctx.rules, ctx.rng, scaledLayout(ctx.rules, scale).parcelMm, scale);
      const site = ctx.request.site;
      if (site) {
        // Nothing stands in the water: a prop whose footprint is not dry is left out, and a terrace whose stairs are
        // goes too (its building and what stood on it come down to the ground).
        const c = townCentreMm(layout!.roads.nodes);
        const dry = (p: (typeof props)[number]): boolean => {
          const b = propBox(p);
          return [b.x0, b.x1].every((x) => [b.z0, b.z1].every((z) => site.dry(site.origin[0] + (x - c.x) / 1000, site.origin[1] + (z - c.z) / 1000)));
        };
        const kept = props.filter((p) => p.kind === "terrace" || dry(p));
        const stairs = new Set(kept.filter((p) => p.kind === "stairs").map((p) => p.parcel));
        const flat = new Set(kept.filter((p) => p.kind === "terrace" && !stairs.has(p.parcel)).map((p) => p.parcel));
        props = kept.filter((p) => !(p.kind === "terrace" && flat.has(p.parcel))).map((p) => (p.yMm && flat.has(p.parcel) ? (({ yMm: _, ...rest }) => rest)(p) : p));
      }
      ctx.town.props = props;
      const counts: Record<string, number> = {};
      for (const p of props) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
      ctx.events.emit("summary", "props", "dressed", counts);
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

  if (request.access !== undefined && !ACCESS.includes(request.access)) return fail("request", "bad_access", `access must be one of ${ACCESS.join(", ")}`);
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

  const { setting, demographics, mastery, demand, layout, structures, occupancy, props } = ctx.town as Town;
  const body = {
    format: MANIFEST_FORMAT as typeof MANIFEST_FORMAT,
    generatorVersion: GENERATOR_VERSION,
    rulesVersion: ctx.rules.version,
    settlementId: request.settlementId,
    seed: request.seed,
    scale: request.scale ?? 1,
    determinism: { rngStreams: ctx.rng.seeds(), sortPolicy: "id" as const, units: "millimeters" as const },
    setting,
    demographics,
    mastery,
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
    props,
    validation: ctx.validation,
  };
  const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const sorted = { ...body, districts: byId(body.districts), parcels: byId(body.parcels), fortifications: byId(body.fortifications), structures: byId(body.structures), props: byId(body.props), occupancy: { households: byId(occupancy.households), npcs: byId(occupancy.npcs), shops: byId(occupancy.shops) } };
  return { ok: true, manifest: { ...sorted, hash: contentHash(sorted) }, events: events.events(verbosity) };
}
