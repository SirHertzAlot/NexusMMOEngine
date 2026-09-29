/**
 * Formations: ecology layers whose points are decided together by Wave
 * Function Collapse (@mmo-engine/wfc) rather than one by one. Scatter says
 * where things may go; the formation says what each place becomes given
 * its neighbours: a ring of standing stones around a clearing, tents
 * around a fire, veins that cluster.
 *
 * A formation layer's candidates are world-space cells (like a `field`
 * layer), kept only where the layer's filters allow (biome, density,
 * slope, water); the ecology's chance there scales the non-empty options.
 * The options, with their `avoid`, `needs` and `counts`, are the layer's
 * `formation`.
 *
 * Seams. Chunks load in any order, but a formation must come out the same
 * whichever loads first. So formations are solved in world-space **tiles**
 * of `tileChunks` × `tileChunks` chunks, in four phases on a 2 × 2
 * pattern: tiles of one phase never touch (not even at corners), so they
 * solve on their own; a tile of a later phase solves with its already-
 * solved neighbours' points near its border brought in as settled context.
 * Every constraint distance must be shorter than a tile, so same-phase
 * tiles can't interact. Any chunk is then rebuilt from the seed alone.
 *
 * Baked. A tile takes tens of milliseconds to solve, too long for the
 * server's tick, so the world bake solves every tile of the world into
 * world.db (persist/formation-tiles.ts) and the server only reads them. A
 * tile the store lacks is solved on demand and written back.
 */

import { pointsProblem, solve, type WfcOption } from "@mmo-engine/wfc";
import { fnv1a32 } from "@mmo-engine/scatter";
import { terrainHeightAt } from "../systems.js";
import { fieldAt, hash, ramp, type EcologyLayer, type EcologyPlan, type WeightedAsset } from "./ecology.js";

export interface FormationOption {
  id: string;
  weight: number;
  tags?: string[];
  /** What it spawns (none: an unseen point, like a clearing's centre, that other points can need). */
  assets?: WeightedAsset[];
  scale?: [number, number];
}

export interface FormationSpec {
  /** One option should be the empty ground (no assets, no tags). */
  options: FormationOption[];
  avoid?: { a: string; b: string; distance: number }[];
  needs?: { tag: string; near: string; distance: number; count?: number }[];
  /** Per tile. */
  counts?: { tag: string; min?: number; max?: number }[];
}

/** A solved point of a formation. */
export interface FormationPoint {
  x: number;
  z: number;
  /** Cell indices (the candidate's own random stream). */
  i: number;
  j: number;
  option: number;
}

export interface FormationEnv {
  seed32: number;
  chunkWorldSize: number;
  /** Heights of any chunk (the terrain source), for tiles that span or border other chunks. */
  heightsOf: (cx: number, cz: number) => Float32Array;
  biomeAt?: (x: number, z: number) => string | null;
  waterAt?: (x: number, z: number) => number | null;
  seaLevel?: number;
}

/** Where solved tiles persist between runs (world.db: persist/formation-tiles.ts). */
export interface FormationTileBacking {
  get(layer: string, ti: number, tj: number): FormationPoint[] | undefined;
  put(layer: string, ti: number, tj: number, points: FormationPoint[]): void;
}

/**
 * Solved tiles, by layer and tile: in memory (least recently used first
 * out), over an optional persistent backing that the bake fills. A tile
 * missing from both is solved and written to both; the result is the same
 * whenever it's solved, so either may drop tiles.
 */
export class FormationCache {
  private readonly tiles = new Map<string, FormationPoint[]>();
  /** Tiles solved here (not found in memory or the backing). */
  solved = 0;
  constructor(
    private readonly limit = 1024,
    private readonly backing: FormationTileBacking | null = null,
  ) {}
  get(layer: string, ti: number, tj: number): FormationPoint[] | undefined {
    const key = `${layer}:${ti},${tj}`;
    let v = this.tiles.get(key);
    if (v) this.tiles.delete(key);
    else v = this.backing?.get(layer, ti, tj);
    if (v) this.remember(key, v);
    return v;
  }
  set(layer: string, ti: number, tj: number, v: FormationPoint[]): void {
    this.solved++;
    this.backing?.put(layer, ti, tj, v);
    this.remember(`${layer}:${ti},${tj}`, v);
  }
  private remember(key: string, v: FormationPoint[]): void {
    this.tiles.set(key, v);
    while (this.tiles.size > this.limit) this.tiles.delete(this.tiles.keys().next().value as string);
  }
}

/**
 * Solve every formation tile covering chunks [minChunk, maxChunk] (the
 * bake: the server then only reads them). Returns the tiles covered.
 */
export function bakeFormations(
  plan: EcologyPlan,
  env: FormationEnv,
  cache: FormationCache,
  minChunk: { x: number; z: number },
  maxChunk: { x: number; z: number },
  onTile?: (done: number, total: number) => void,
): number {
  let done = 0;
  const jobs: [EcologyLayer, number, number][] = [];
  for (const layer of plan.layers) {
    if (layer.place.kind !== "formation") continue;
    const [ta, tb] = tileOfChunk(layer, minChunk.x, minChunk.z);
    const [tc, td] = tileOfChunk(layer, maxChunk.x, maxChunk.z);
    for (let tj = tb; tj <= td; tj++) for (let ti = ta; ti <= tc; ti++) jobs.push([layer, ti, tj]);
  }
  for (const [layer, ti, tj] of jobs) {
    formationTile(plan, layer, env, cache, ti, tj);
    onTile?.(++done, jobs.length);
  }
  return jobs.length;
}

const unit = (h: number): number => h / 4294967296;
const mod2 = (n: number): number => ((n % 2) + 2) % 2;
const phaseOf = (ti: number, tj: number): number => mod2(ti) + 2 * mod2(tj);

/** The longest constraint distance: tiles must be larger. */
export function formationReach(f: FormationSpec): number {
  return Math.max(0, ...(f.avoid ?? []).map((a) => a.distance), ...(f.needs ?? []).map((n) => n.distance));
}

/** Check a formation layer (called by parseEcologyPlan). */
export function checkFormation(layer: EcologyLayer): void {
  const f = layer.formation;
  if (!f || layer.place.kind !== "formation") throw new Error(`ecology plan: layer "${layer.id}" is a formation without a "formation" spec`);
  if (!(layer.place.spacing > 0)) throw new Error(`ecology plan: layer "${layer.id}": spacing must be > 0`);
  if (layer.avoid) throw new Error(`ecology plan: layer "${layer.id}": a formation doesn't avoid other layers (list it first, and let later layers avoid it)`);
  if (f.options.length < 2) throw new Error(`ecology plan: layer "${layer.id}": a formation needs at least two options (one the empty ground)`);
  const tags = new Set(f.options.flatMap((o) => o.tags ?? []));
  for (const t of [...(f.avoid ?? []).flatMap((a) => [a.a, a.b]), ...(f.needs ?? []).flatMap((n) => [n.tag, n.near]), ...(f.counts ?? []).map((c) => c.tag)]) {
    if (!tags.has(t)) throw new Error(`ecology plan: layer "${layer.id}": no option is tagged "${t}"`);
  }
}

/**
 * The formation's points in the tile (ti, tj), solving (and caching) the
 * earlier-phase neighbour tiles it borders first.
 */
export function formationTile(plan: EcologyPlan, layer: EcologyLayer, env: FormationEnv, cache: FormationCache, ti: number, tj: number): FormationPoint[] {
  const hit = cache.get(layer.id, ti, tj);
  if (hit) return hit;
  const f = layer.formation as FormationSpec;
  if (layer.place.kind !== "formation") throw new Error(`layer "${layer.id}" is not a formation`);
  const tileChunks = layer.place.tileChunks ?? 4;
  const W = env.chunkWorldSize;
  const T = tileChunks * W;
  const reach = formationReach(f);
  if (reach >= T) {
    throw new Error(`ecology plan: layer "${layer.id}": a constraint reaches ${reach} m, which must be less than its tile (${tileChunks} chunks = ${T} m)`);
  }

  // Earlier-phase neighbours first: their points near our border are fixed context.
  const phase = phaseOf(ti, tj);
  const settled: FormationPoint[] = [];
  const x0 = ti * T, z0 = tj * T;
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      if ((di === 0 && dj === 0) || phaseOf(ti + di, tj + dj) >= phase) continue;
      for (const p of formationTile(plan, layer, env, cache, ti + di, tj + dj)) {
        if (p.x > x0 - reach && p.x < x0 + T + reach && p.z > z0 - reach && p.z < z0 + T + reach) settled.push(p);
      }
    }

  // Our candidates: world-space cells, kept where the ground allows.
  const layerSeed = hash(env.seed32, fnv1a32(layer.id));
  const s = layer.place.spacing;
  const cands: { x: number; z: number; i: number; j: number; p: number }[] = [];
  for (let j = Math.ceil(z0 / s - 1e-9); j * s < z0 + T - 1e-9; j++)
    for (let i = Math.ceil(x0 / s - 1e-9); i * s < x0 + T - 1e-9; i++) {
      const r = (k: number): number => unit(hash(layerSeed, i, j, k));
      const x = (i + 0.05 + 0.9 * r(10)) * s;
      const z = (j + 0.05 + 0.9 * r(11)) * s;
      if (x < x0 || x >= x0 + T || z < z0 || z >= z0 + T) continue;
      const p = suitability(plan, layer, env, x, z);
      // (i | 0: Math.ceil can give -0, which a stored int32 reads back as 0.)
      if (p > 0) cands.push({ x, z, i: i | 0, j: j | 0, p });
    }
  if (cands.length === 0) {
    cache.set(layer.id, ti, tj, []);
    return [];
  }

  const options: WfcOption[] = f.options.map((o) => ({ id: o.id, weight: o.weight, tags: o.tags }));
  const empty = f.options.findIndex((o) => !o.assets?.length && !o.tags?.length);
  const points = [...cands.map((c) => ({ x: c.x, y: c.z })), ...settled.map((p) => ({ x: p.x, y: p.z }))];
  const settledMap = new Map(settled.map((p, k) => [cands.length + k, p.option]));
  const problem = pointsProblem({
    points,
    options,
    avoid: f.avoid,
    needs: f.needs,
    counts: f.counts,
    settled: settledMap,
    // The ecology's chance scales everything but the empty ground.
    weight: (pt, o) => (pt < cands.length ? (o === empty ? 1 : cands[pt].p) : 1),
  });
  const r = solve(problem, { seed: hash(layerSeed, ti, tj, 0x464f524d) });
  const out: FormationPoint[] = [];
  for (let k = 0; k < cands.length; k++) {
    const option = r.assignment[k];
    if (option === empty) continue;
    out.push({ x: cands[k].x, z: cands[k].z, i: cands[k].i, j: cands[k].j, option });
  }
  cache.set(layer.id, ti, tj, out);
  return out;
}

/** How suitable (x, z) is for the layer: the ecology's chance there, 0 where its filters say no. */
function suitability(plan: EcologyPlan, layer: EcologyLayer, env: FormationEnv, x: number, z: number): number {
  const W = env.chunkWorldSize;
  const cx = Math.floor(x / W), cz = Math.floor(z / W);
  const heights = env.heightsOf(cx, cz);
  const ground = (px: number, pz: number): number => terrainHeightAt(heights, px - cx * W, pz - cz * W, W);
  const biome = env.biomeAt?.(x, z) ?? "default";
  let p = layer.chance ?? 1;
  if (layer.biome) p *= plan.biomes[biome]?.[layer.biome] ?? plan.biomes.default?.[layer.biome] ?? 1;
  if (p <= 0) return 0;
  for (const d of layer.density ?? []) p *= ramp(fieldAt(plan.fields[d.field], x, z), d.ramp);
  if (p <= 0) return 0;
  // Slope within the point's own chunk (as planChunk measures it).
  const e = 0.5;
  const xm = Math.max(cx * W, x - e), xp = Math.min((cx + 1) * W, x + e);
  const zm = Math.max(cz * W, z - e), zp = Math.min((cz + 1) * W, z + e);
  const slope = Math.hypot((ground(xp, z) - ground(xm, z)) / (xp - xm), (ground(x, zp) - ground(x, zm)) / (zp - zm));
  if (layer.slope && (slope < layer.slope[0] || slope > layer.slope[1])) return 0;
  if (layer.slopeBoost) p *= 1 + layer.slopeBoost * slope;
  if (layer.aboveWater) {
    const w = env.waterAt ? env.waterAt(x, z) : env.seaLevel ?? null;
    const above = w === null ? Infinity : ground(x, z) - w;
    const [lo, hi] = layer.aboveWater;
    if (above < lo || (hi !== null && above > hi)) return 0;
  }
  return Math.min(p, 1);
}

/** Pick an asset by weight (as ecology's layers do). */
export function pickAsset(list: WeightedAsset[], r: number): WeightedAsset {
  let total = 0;
  for (const a of list) total += a.weight;
  let t = r * total;
  for (const a of list) {
    t -= a.weight;
    if (t < 0) return a;
  }
  return list[list.length - 1];
}

/** The tile holding chunk (cx, cz). */
export function tileOfChunk(layer: EcologyLayer, cx: number, cz: number): [number, number] {
  const n = layer.place.kind === "formation" ? (layer.place.tileChunks ?? 4) : 1;
  return [Math.floor(cx / n), Math.floor(cz / n)];
}

export { phaseOf as formationPhase };
