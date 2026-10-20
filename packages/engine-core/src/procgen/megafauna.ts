/**
 * Megafauna: where the tier-5 bosses of the wildlife table have their lairs,
 * which settlements they raid, and which art models show them. The numbers
 * are in `content/wildlife/wildlife.json` (`species.*.boss`, `megafauna`), the
 * reasoning in docs/WILDLIFE.md. Pure functions of (table, seed, lookups).
 */

import { hash } from "./ecology.js";
import { maxDangerAt, words, type CatalogModel, type Centre, type WildlifeTable } from "./wildlife-table.js";

const unit = (h: number): number => h / 4294967296;
const SALT = 0x6e9a;
/** Candidate points tried per lair before giving up on it (the world may hold no fitting spot). */
const TRIES = 48;
/** A shore boss's lair stands within this of the water, metres. */
const SHORE_M = 40;

export interface Lair {
  kind: string;
  biome: string;
  x: number;
  z: number;
  /** The boss stays within this of the lair when not hunting or raiding. */
  radiusM: number;
  tier: 5;
  /** Water bosses: the water depth at the lair, metres. */
  depthM?: number;
}

export interface MegafaunaContext {
  seed: number;
  /** The world is a square of this side, metres, from (0, 0). */
  sizeM: number;
  biomeAt: (x: number, z: number) => string | null;
  /** Metres of water over the ground; null or 0: dry. Default: all dry. */
  depthAt?: (x: number, z: number) => number | null;
  /** Metres to the nearest water (shore bosses). Default: unknown, any spot passes. */
  waterDistanceAt?: (x: number, z: number) => number;
  /** 0 to 1: how much megaflora grove stands at the spot (see `megaGroveAt`). */
  groveAt?: (x: number, z: number) => number;
  /** Spawn and settlement centres. */
  centres: readonly Centre[];
}

/**
 * The boss lairs of one world. Per boss species the expected count is its
 * `rarityPer100Km2` times the world's area, rounded up or down by a seeded
 * draw (so most species are absent from a small world); each lair is the first
 * of up to 48 seeded points that fits its biome weight, habitat (and depth),
 * the tier-5 ring from the spawn, the settlement and separation distances and
 * its lean toward groves. The world is then capped at `maxPerWorld`.
 */
export function planMegafauna(t: WildlifeTable, ctx: MegafaunaContext): Lair[] {
  const m = t.megafauna;
  if (!m) return [];
  const spawns = ctx.centres.filter((c) => c.kind === "spawn");
  const towns = ctx.centres.filter((c) => c.kind === "settlement");
  const area = (ctx.sizeM * ctx.sizeM) / 100e6;
  const bosses = Object.entries(t.species).filter(([, s]) => s.boss).sort(([a], [b]) => (a < b ? -1 : 1));
  const found: Array<Lair & { score: number }> = [];
  bosses.forEach(([id, sp], si) => {
    const b = sp.boss!;
    const e = b.rarityPer100Km2 * area;
    const n = Math.min(m.maxPerWorld, Math.floor(e) + (unit(hash(ctx.seed, SALT, si, 0, 0)) < e - Math.floor(e) ? 1 : 0));
    const top = Math.max(0, ...Object.values(sp.biomes));
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < TRIES; k++) {
        const h = (j: number): number => unit(hash(ctx.seed, SALT, si, 1 + i, k * 4 + j));
        const x = h(0) * ctx.sizeM, z = h(1) * ctx.sizeM;
        const biome = ctx.biomeAt(x, z);
        const w = biome === null ? 0 : sp.biomes[biome] ?? 0;
        if (w <= 0 || h(2) >= w / top) continue;
        const depth = ctx.depthAt?.(x, z) ?? 0;
        if (sp.habitat === "water" ? !(depth > 0 && depth >= sp.depthM![0] && depth <= sp.depthM![1]) : depth > 0) continue;
        if (sp.habitat === "shore" && ctx.waterDistanceAt && ctx.waterDistanceAt(x, z) > SHORE_M) continue;
        const dSpawn = Math.min(Infinity, ...spawns.map((c) => Math.hypot(c.x - x, c.z - z)));
        if (maxDangerAt(t, dSpawn) < 5) continue;
        if (towns.some((c) => Math.hypot(c.x - x, c.z - z) < m.lairMinFromSettlementM)) continue;
        if (found.some((l) => Math.hypot(l.x - x, l.z - z) < m.minSeparationM)) continue;
        if (ctx.groveAt && b.lair.floraBias > 0 && h(3) >= 1 - b.lair.floraBias + b.lair.floraBias * ctx.groveAt(x, z)) continue;
        found.push({ kind: id, biome: biome!, x, z, radiusM: b.lair.radiusM, tier: 5, ...(depth > 0 ? { depthM: depth } : {}), score: unit(hash(ctx.seed, SALT, si, 1 + i, 999)) });
        break;
      }
    }
  });
  return found.sort((a, b) => a.score - b.score).slice(0, m.maxPerWorld).map(({ score: _score, ...l }) => l);
}

export interface RaidSettlement {
  id: string;
  x: number;
  z: number;
  population: number;
  structures: number;
  livestock: number;
  foodStores: number;
  /** Stands by the sea, a lake or a river: reachable along the water. */
  coastal: boolean;
}

/**
 * The settlements a boss may raid from `at` (its lair): all of its raid
 * thresholds met, in range, reachable by its approach, and outside the starter
 * safe radius unless its raid says otherwise. Nearest first; none when the
 * species has no raid.
 */
export function raidTargets(t: WildlifeTable, species: string, at: { x: number; z: number }, settlements: readonly RaidSettlement[], centres: readonly Centre[]): RaidSettlement[] {
  const r = t.species[species]?.boss?.raid;
  if (!r) return [];
  const spawns = centres.filter((c) => c.kind === "spawn");
  const d = (s: RaidSettlement): number => Math.hypot(s.x - at.x, s.z - at.z);
  return settlements
    .filter((s) =>
      s.population >= r.minPopulation && s.structures >= r.minStructures && s.livestock >= r.minLivestock && s.foodStores >= r.minFoodStores &&
      d(s) <= r.rangeM && (r.approach !== "along_water" || s.coastal) &&
      (r.allowInsideSafeRadius === true || spawns.every((c) => Math.hypot(c.x - s.x, c.z - s.z) >= t.safeRadiusM)))
    .sort((a, b) => d(a) - d(b) || (a.id < b.id ? -1 : 1));
}

export interface BossModels {
  /** own: its `models` words matched; base:<species>: scaled up from that species' model; none: nothing in the catalog. */
  from: "own" | `base:${string}` | "none";
  /** Catalog model ids with the scale that makes the model as long as the boss. */
  models: Array<{ id: string; scale: number }>;
}

/**
 * Boss id -> the static catalog models that show it and their scales. A model's
 * natural length is its longer horizontal side; a catalog with no size uses the
 * boss's `base.lengthM`. Own name matches win, else the base species' models; a model
 * that would need more than `maxModelScale` is skipped.
 */
export function bossModels(t: WildlifeTable, catalog: readonly CatalogModel[]): Record<string, BossModels> {
  const pick = (patterns: string, not?: string): CatalogModel[] => {
    const yes = words(patterns), no = not ? words(not) : null;
    return catalog.filter((m) => !m.skinned && yes.test(m.name) && !(no && no.test(m.name))).sort((a, b) => (a.id < b.id ? -1 : 1));
  };
  const out: Record<string, BossModels> = {};
  for (const [id, sp] of Object.entries(t.species)) {
    const b = sp.boss;
    if (!b) continue;
    const base = t.species[b.base.species];
    let from: BossModels["from"] = "own";
    let ms = pick(sp.models, b.modelsNot);
    if (ms.length === 0 && base) { from = `base:${b.base.species}`; ms = pick(base.models, b.modelsNot ?? base.boss?.modelsNot); }
    const scaled = ms.map((m) => ({ id: m.id, scale: b.lengthM / (m.size ? Math.max(m.size[0], m.size[2]) : b.base.lengthM) })).filter((m) => m.scale <= t.megafauna!.maxModelScale);
    out[id] = { from: scaled.length === 0 ? "none" : from, models: scaled };
  }
  return out;
}
