/**
 * The generator: a request runs through the stages in order, each reading
 * what the one before wrote, and the result is a manifest, or the stage that
 * failed and why (no exceptions across the API, spec §29.10). Stages are
 * small and independently testable; the manifest is canonical, so its hash
 * identifies the town.
 */

import { WfcError } from "@mmo-engine/wfc";
import { bakeDemographics } from "./demographics.js";
import { capDemand, solveDemand } from "./demand.js";
import { EventLog, type GenerationEvent, type Verbosity } from "./events.js";
import { contentHash } from "./hash.js";
import { FOOTPRINT_SAMPLES, fieldIsGreen, layOut, plotIsDry, scaledLayout, townCentreMm } from "./layout.js";
import { drawMastery } from "./mastery.js";
import { drawHomeless, townSetting, withDensity } from "./setting.js";
import { townIndustry, withIndustry, type Land } from "./industry.js";
import { townGuild } from "./guild.js";
import { placeResources } from "./resources.js";
import { occupy } from "./occupancy.js";
import { placeProps, propBox } from "./props.js";
import { streams, type Streams } from "./rng.js";
import { ACCESS, BUILTIN_RULES, type Access, type SettlementRules, TRENDS, type Trend } from "./rules.js";
import { placeStructures } from "./structures.js";
import { validateTown, type Gate, type Town } from "./validate.js";
import {
  defaultCharacterCatalogs,
  generateCharacter,
  professionScore,
  assembleBackstory,
  alignmentBand,
  type CharacterGenerationContext,
} from "./character/index.js";

/** How many block rows a town beside water may grow to make up for its wet parcels. */
const MAX_EXTRA_BLOCKS = 3;

export const GENERATOR_VERSION = "settlement-gen/0.8.0";
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
  /**
   * The land around the town (a site's `biomes`, `waterKind` and `shoreM`): its industry (rules.industry) caps how big
   * it grows on that land, what it exports and what its masters practise. Without it the town has no industry.
   */
  land?: Land;
  /** Whether the town is growing, stable or shrinking (a region's history, `evolveRegion`); without it, drawn from its access. */
  trend?: Trend;
  rules?: SettlementRules;
  /** The building factor (`resolveScale(doc, "building")`) the town is laid out at; default 1. */
  scale?: number;
  /**
   * Where the town will stand (the scene's origin, world metres [x, z]) and the world's dryness test at a world
   * point. A parcel whose footprint (centre, corners, edge midpoints) is not dry is dropped before the structures
   * are solved: the town is built on what is left, or fails with the solver's reason. Without it, the ground is not considered.
   */
  site?: {
    origin: [number, number];
    dry: (x: number, z: number) => boolean;
    /**
     * Routes a paved street over the ground from `from` to `to` (world metres), returning its centreline in world metres with
     * each point's height `h` above the ground at `centre`; null when there is no route. Without it, streets stay straight.
     */
    route?: (from: [number, number], to: [number, number], centre: [number, number]) => Array<{ x: number; z: number; h: number }> | null;
  };
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
  /** What the town lives off and is known for (null: no land given, or no industry rules). */
  industry: Town["industry"];
  /** The town's craft guild: its hall, its master, and the recipes each rank of reputation with it may buy (null: no industry). */
  guild: Town["guild"];
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
  /** What players gather round the town (tree stands, ore veins, fishing spots), in id order; none without its land. */
  resources: Town["resources"];
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
      // Its industry first, from the land: it caps how big the town grows there and what its masters practise.
      const industry = ctx.request.land ? townIndustry(ctx.request.land, ctx.rules) : null;
      ctx.town.industry = industry;
      const drawn = townSetting(ctx.request.population, ctx.request.access, ctx.rules, ctx.rng, industry);
      const setting = drawn.access && ctx.request.trend ? { ...drawn, trend: ctx.request.trend } : drawn;
      ctx.town.setting = setting;
      ctx.rules = withIndustry(withDensity(ctx.rules, setting.densityPermille, setting.trend), industry);
      if (setting.population < setting.requestedPopulation) ctx.events.emit("summary", "demographics", "capped", { access: setting.access, requested: setting.requestedPopulation, capacity: setting.capacity });
      // The town's masters next: the people they draw to live there are part of its population.
      const mastery = drawMastery(setting.population, ctx.rules, ctx.rng, setting.access ? ctx.rules.settings.access[setting.access].masteryPermille : 1000);
      ctx.town.mastery = mastery;
      const people = setting.population + mastery.residents;
      const d = bakeDemographics(people, ctx.rules.demographics, drawHomeless(people, setting.densityPermille, ctx.rules, ctx.rng));
      ctx.town.demographics = d;
      ctx.events.emit("summary", "demographics", "baked", { population: d.population, households: d.households, homeless: d.homeless, laborPool: d.laborPool, access: setting.access, densityPermille: setting.densityPermille, trend: setting.trend, industry: industry?.primary ?? null, masters: mastery.masters, communities: mastery.communities, grandMasters: mastery.grandMasters, discipline: mastery.discipline, pupils: mastery.pupils, visitors: mastery.visitors });
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
            plotIsDry(p, pw, pd, c, dryMm) && (!p.holding || fieldIsGreen(p.holding.center, p.holding.sizeXMm, p.holding.sizeZMm, c, dryMm));
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
          const surfaced = full.roads.edges.map((e) => (e.surface === "paved" && !slabDry(e) ? { ...e, surface: "dirt" as const } : e));
          // Each paved street routed over the ground, when the site gives a router; its ends stay on the junctions.
          const route = site.route;
          const edges = route
            ? surfaced.map((e) => {
                if (e.surface !== "paved") return e;
                const a = at.get(e.from)!;
                const b = at.get(e.to)!;
                const toWorld = (p: { x: number; z: number }): [number, number] => [site.origin[0] + (p.x - c.x) / 1000, site.origin[1] + (p.z - c.z) / 1000];
                const pts = route(toWorld(a), toWorld(b), site.origin);
                if (!pts || pts.length < 2) return e;
                const path = pts.map((p) => ({ x: Math.round((p.x - site.origin[0]) * 1000), z: Math.round((p.z - site.origin[1]) * 1000), h: Math.round(p.h * 100) / 100 }));
                // The ends are the junctions themselves, so the street meets its crossings exactly.
                path[0] = { x: a.x - c.x, z: a.z - c.z, h: path[0]!.h };
                path[path.length - 1] = { x: b.x - c.x, z: b.z - c.z, h: path[path.length - 1]!.h };
                return { ...e, path };
              })
            : surfaced;
          const kept = { ...full, roads: { ...full.roads, edges }, parcels: full.parcels.filter(dry), fortifications, wallOpenToWater: full.fortifications.length - fortifications.length, square: squareDry ? sq : null };
          ctx.events.emit("summary", "structures", "wet_parcels_dropped", { extraBlocks: extra, dropped: full.parcels.length - kept.parcels.length, kept: kept.parcels.length });
          // Too few dry farm plots: the farms and food are capped to what they hold. If even that cannot be solved (a lone master
          // farm's workers overrun a small town's labour), the town keeps no farms and imports its food.
          const farmless = { ...kept, parcels: kept.parcels.filter((p) => p.kind !== "agriculture") };
          try {
            for (const tryLayout of kept.parcels.length === farmless.parcels.length ? [kept] : [kept, farmless]) {
              const capped = capDemand(demand!, tryLayout.parcels, ctx.rules);
              try {
                if (!tryLayout.parcels.some((p) => p.kind === "housing")) throw new WfcError("no dry housing plots");
                structures = placeStructures(tryLayout, capped.demand, ctx.rules, ctx.rng);
              } catch (err) {
                if (!(err instanceof WfcError) || tryLayout === farmless) throw err;
                continue;
              }
              layout = tryLayout;
              ctx.town.demand = capped.demand;
              if (capped.importedFood > 0) {
                ctx.events.emit("summary", "structures", "farms_capped", { farms: tryLayout.parcels.filter((p) => p.kind === "agriculture").length, importedFood: capped.importedFood, foodDemand: demand!.foodDemand });
                // The masters the town has are the master workplaces it could build.
                const masters = { ...ctx.town.mastery!.masters };
                const grandMasters = { ...ctx.town.mastery!.grandMasters };
                for (const [name, prof] of Object.entries(ctx.rules.mastery?.professions ?? {})) {
                  const shops = structures.filter((st) => st.archetype === prof.master).length;
                  masters[name] = Math.min(masters[name] ?? 0, shops);
                  if (name in grandMasters) grandMasters[name] = Math.min(grandMasters[name]!, masters[name]!);
                }
                ctx.town.mastery = { ...ctx.town.mastery!, masters, grandMasters };
              }
              break;
            }
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
      ctx.town.guild = townGuild(ctx.town.industry ?? null, structures!, o, ctx.rules);
      const employed = o.npcs.filter((n) => n.workplace).length;
      ctx.events.emit("summary", "occupancy", "settled", { households: o.households.length, npcs: o.npcs.length, employed, shops: o.shops.length });
    },
  },
  {
    name: "character",
    run(ctx) {
      const { occupancy, structures } = ctx.town;
      if (!occupancy || !structures) return;

      const r = ctx.rng.get("character");
      const catalogs = defaultCharacterCatalogs();
      const byId = [...structures].sort((a, b) => (a.id < b.id ? -1 : 1));
      const structureArchetype = new Map(byId.map((s) => [s.id, s.archetype]));
      const professionOf = new Map(Object.entries(ctx.rules.mastery?.professions ?? {}).map(([name, p]) => [p.master, name]));

      // 1. Initial character composition draw per NPC (deterministic by NPC ID order)
      const npcs = occupancy.npcs;
      for (const npc of npcs) {
        const charCtx: CharacterGenerationContext = {
          characterId: npc.id,
          seedStream: { next: () => r.raw() },
          cohort: npc.cohort,
          classId: npc.class,
          role: npc.role,
          profession: npc.role,
          townId: ctx.request.settlementId,
        };
        npc.character = generateCharacter(charCtx, catalogs);
      }

      // 2. Profession rescoring (§11, §15):
      // Eligible candidates are working-age NPCs (adult, adolescent)
      const WORKING = new Set(["adult", "adolescent"]);
      const eligible = npcs.filter((n) => WORKING.has(n.cohort));

      // Build job slots from structures with worker capacity
      interface JobSlot {
        structureId: string;
        structureArchetype: string;
        role: string;
        professionKey: string;
        isMaster: boolean;
        isGrandMaster: boolean;
      }

      let grandMastersLeft = { ...(ctx.town.mastery?.grandMasters ?? {}) };
      const jobSlots: JobSlot[] = [];

      for (const s of byId) {
        const arch = ctx.rules.archetypes[s.archetype];
        if (!arch || arch.workers <= 0) continue;
        const masterProf = professionOf.get(s.archetype);

        for (let w = 0; w < arch.workers; w++) {
          const isMaster = w === 0 && !!masterProf;
          let isGrand = false;
          if (isMaster && masterProf && (grandMastersLeft[masterProf] ?? 0) > 0) {
            grandMastersLeft[masterProf] = grandMastersLeft[masterProf]! - 1;
            isGrand = true;
          }
          jobSlots.push({
            structureId: s.id,
            structureArchetype: s.archetype,
            role: arch.role,
            professionKey: masterProf ?? arch.role,
            isMaster,
            isGrandMaster: isGrand,
          });
        }
      }

      // Pre-rank candidates for each unique (professionKey, role) pair for fast slot assignment
      const rankedCandidatesByKey = new Map<string, (typeof eligible)[number][]>();
      const cursorByKey = new Map<string, number>();

      for (const slot of jobSlots) {
        const key = `${slot.professionKey}|${slot.role}`;
        if (!rankedCandidatesByKey.has(key)) {
          const list = [...eligible].sort((a, b) => {
            const charA = a.character!;
            const charB = b.character!;
            const scoreKeyA = professionScore(charA, slot.professionKey, catalogs);
            const scoreRoleA = slot.role !== slot.professionKey ? professionScore(charA, slot.role, catalogs) : scoreKeyA;
            const scoreA = Math.max(scoreKeyA, scoreRoleA);

            const scoreKeyB = professionScore(charB, slot.professionKey, catalogs);
            const scoreRoleB = slot.role !== slot.professionKey ? professionScore(charB, slot.role, catalogs) : scoreKeyB;
            const scoreB = Math.max(scoreKeyB, scoreRoleB);

            if (scoreA !== scoreB) return scoreB - scoreA;
            return a.id < b.id ? -1 : 1;
          });
          rankedCandidatesByKey.set(key, list);
          cursorByKey.set(key, 0);
        }
      }

      // Match candidates to job slots by professionScore ranking
      const unassigned = new Set(eligible);

      for (const slot of jobSlots) {
        if (unassigned.size === 0) break;
        const key = `${slot.professionKey}|${slot.role}`;
        const ranked = rankedCandidatesByKey.get(key)!;
        let cursor = cursorByKey.get(key)!;

        while (cursor < ranked.length && !unassigned.has(ranked[cursor]!)) {
          cursor++;
        }
        cursorByKey.set(key, cursor);

        if (cursor < ranked.length) {
          const bestCandidate = ranked[cursor]!;
          bestCandidate.workplace = slot.structureId;
          if (slot.isMaster) bestCandidate.mastery = slot.professionKey;
          else delete bestCandidate.mastery;
          if (slot.isGrandMaster) bestCandidate.grandMaster = true;
          else delete bestCandidate.grandMaster;
          unassigned.delete(bestCandidate);
        }
      }

      // Any remaining candidates without a workplace
      for (const candidate of unassigned) {
        delete candidate.workplace;
        delete candidate.mastery;
        delete candidate.grandMaster;
      }

      // Update NPC roles matching occupancy logic
      for (const n of npcs) {
        if (n.workplace) {
          const sArch = structureArchetype.get(n.workplace)!;
          const archDef = ctx.rules.archetypes[sArch]!;
          if (n.grandMaster) {
            n.role = `grand ${archDef.role}`;
          } else if (n.mastery) {
            n.role = archDef.role;
          } else if (professionOf.has(sArch)) {
            const profName = professionOf.get(sArch)!;
            const baseArch = ctx.rules.mastery?.professions?.[profName]?.archetype ?? sArch;
            const baseRole = ctx.rules.archetypes[baseArch]?.role ?? profName;
            n.role = `apprentice ${baseRole}`;
          } else {
            n.role = archDef.role;
          }
        } else {
          n.role = n.home === null
            ? (n.cohort === "child" ? "orphan" : "beggar")
            : (n.cohort === "child" ? "child" : n.cohort === "elder" ? "elder" : "resident");
        }
      }

      // Shop ownership follows the worker as today
      for (const shop of occupancy.shops) {
        shop.owner = npcs.find((n) => n.workplace === shop.structure)?.id ?? null;
      }

      // Recompute guild with rescored masters
      ctx.town.guild = townGuild(ctx.town.industry ?? null, structures, occupancy, ctx.rules);

      // 3. Backstory re-render with assigned role and town (§12, §15)
      for (const n of npcs) {
        if (n.character) {
          n.character.backstory = assembleBackstory(
            {
              characterId: n.id,
              archetypeId: n.character.archetypeId,
              temperamentId: n.character.temperamentId,
              alignment: n.character.alignment,
              interests: n.character.interests,
              descriptorIds: n.character.descriptorIds,
              profession: n.role,
              townId: ctx.request.settlementId,
              tier: "local",
              pins: n.character.backstory,
            },
            catalogs,
            {
              next: () => r.raw(),
              weightedPick: <T>(items: readonly T[], weightFn: (item: T) => number): T => {
                let total = 0;
                for (const it of items) total += weightFn(it);
                if (total <= 0) return items[0];
                let roll = r.raw() * total;
                for (const it of items) {
                  const w = weightFn(it);
                  if (roll <= w) return it;
                  roll -= w;
                }
                return items[items.length - 1];
              },
            },
          );
        }
      }

      // 4. Character distribution report and histograms (§15)
      const archetypes: Record<string, number> = {};
      const alignmentBands: Record<string, number> = {};
      const topInterests: Record<string, number> = {};

      for (const n of npcs) {
        if (!n.character) continue;
        archetypes[n.character.archetypeId] = (archetypes[n.character.archetypeId] ?? 0) + 1;
        const bBand = alignmentBand(n.character.alignment.benevolence);
        const oBand = alignmentBand(n.character.alignment.order);
        alignmentBands[`benevolence:${bBand}`] = (alignmentBands[`benevolence:${bBand}`] ?? 0) + 1;
        alignmentBands[`order:${oBand}`] = (alignmentBands[`order:${oBand}`] ?? 0) + 1;
        const topInt = n.character.interests[0]?.id;
        if (topInt) topInterests[topInt] = (topInterests[topInt] ?? 0) + 1;
      }

      const maxArch = Math.max(0, ...Object.values(archetypes));
      const skew = npcs.length > 0 && maxArch / npcs.length > 0.40;
      if (skew) {
        ctx.events.emit("normal", "character", "distribution_skew", { archetypes, alignmentBands });
      }

      ctx.events.emit("summary", "character", "profiled", {
        total: npcs.length,
        archetypes,
        alignmentBands,
        topInterests,
      });
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
      // What players gather round the town: on the world's dry land (fishing spots on its water) where the site is known.
      const c0 = townCentreMm(layout!.roads.nodes);
      const dryMm = site ? (x: number, z: number): boolean => site.dry(site.origin[0] + (x - c0.x) / 1000, site.origin[1] + (z - c0.z) / 1000) : undefined;
      ctx.town.resources = placeResources(ctx.request.settlementId, layout!, structures!, ctx.town.industry ?? null, ctx.request.land ?? null, ctx.rules, ctx.rng, scaledLayout(ctx.rules, scale).parcelMm, dryMm);
      if (ctx.town.resources.length) ctx.events.emit("normal", "props", "resources_placed", Object.fromEntries([...new Set(ctx.town.resources.map((r) => r.kind))].map((k) => [k, ctx.town.resources!.filter((r) => r.kind === k).length])));
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
  if (request.trend !== undefined && !TRENDS.includes(request.trend)) return fail("request", "bad_trend", `trend must be one of ${TRENDS.join(", ")}`);
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

  const { setting, industry, guild, demographics, mastery, demand, layout, structures, occupancy, props, resources } = ctx.town as Town;
  const body = {
    format: MANIFEST_FORMAT as typeof MANIFEST_FORMAT,
    generatorVersion: GENERATOR_VERSION,
    rulesVersion: ctx.rules.version,
    settlementId: request.settlementId,
    seed: request.seed,
    scale: request.scale ?? 1,
    determinism: { rngStreams: ctx.rng.seeds(), sortPolicy: "id" as const, units: "millimeters" as const },
    setting,
    industry,
    guild,
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
    resources,
    validation: ctx.validation,
  };
  const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const sorted = { ...body, districts: byId(body.districts), parcels: byId(body.parcels), fortifications: byId(body.fortifications), structures: byId(body.structures), props: byId(body.props), resources: byId(body.resources), occupancy: { households: byId(occupancy.households), npcs: byId(occupancy.npcs), shops: byId(occupancy.shops) } };
  return { ok: true, manifest: { ...sorted, hash: contentHash(sorted) }, events: events.events(verbosity) };
}
