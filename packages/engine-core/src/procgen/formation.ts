/**
 * Formations: groups of things placed together (a ring of standing stones,
 * a cairn, a camp): WFC decides **what**, scatter and the raymarcher
 * decide **where**.
 *
 *  1. Sites. Scatter's candidates are world-space cells (like a `field`
 *     layer), kept where the layer's filters allow (biome, density, slope,
 *     water); the ecology's chance there weighs them.
 *  2. What, per site (WFC over the sites): which kind of formation each
 *     becomes, or none, with `avoid` distances between kinds (and between
 *     any two formations, so they never overlap) and per-tile `counts`.
 *  3. What, per formation (WFC over its pieces): how many of each piece,
 *     within the kind's `maxPieces`.
 *  4. Where (@mmo-engine/placement): each piece is scattered by its
 *     pattern (a ring, a cluster, the centre) and dropped onto the ground
 *     by the raymarcher; ground steeper than the piece allows, or too near
 *     another piece, rejects the spot.
 *
 * Seams. Chunks load in any order, but a formation must come out the same
 * whichever loads first. So formations are solved in world-space **tiles**
 * of `tileChunks` × `tileChunks` chunks, in four phases on a 2 × 2
 * pattern: tiles of one phase never touch (not even at corners), so they
 * solve on their own; a tile of a later phase solves with its already-
 * solved neighbours' sites and pieces near its border brought in as fixed
 * context. Every reach (avoid distances, a formation's size) must be
 * shorter than a tile, so same-phase tiles can't interact. Any chunk is
 * then rebuilt from the seed alone.
 *
 * Baked. A tile takes tens of milliseconds to solve, too long for the
 * server's tick, so the world bake solves every tile of the world into
 * world.db (persist/formation-tiles.ts) and the server only reads them. A
 * tile the store lacks is solved on demand and written back.
 */

import { HeightfieldSdf, mulberry32, poissonDisc, snapToGround } from "@mmo-engine/placement";
import { pointsProblem, solve, type WfcOption } from "@mmo-engine/wfc";
import { fnv1a32 } from "@mmo-engine/scatter";
import { terrainHeightAt } from "../systems.js";
import { fieldAt, hash, ramp, type EcologyLayer, type EcologyPlan, type WeightedAsset } from "./ecology.js";

/** One kind of piece in a formation. */
export interface FormationPiece {
  id: string;
  assets: WeightedAsset[];
  scale?: [number, number];
  /** How many, [min, max] (WFC picks within it). */
  count: [number, number];
  /** Where around the site: evenly round a ring, clustered, or at the centre. */
  pattern: "ring" | "cluster" | "centre";
  /** Distance from the site, metres: [min, max] (ring: its radius; cluster: its spread). */
  radius: [number, number];
  /** Keeps this far from other pieces, metres. */
  clearance: number;
  /** Steepest ground it stands on (rise over run; default 0.6). */
  maxSlope?: number;
}

export interface FormationKind {
  id: string;
  weight: number;
  tags?: string[];
  pieces: FormationPiece[];
  /** At most this many pieces in one (default: the pieces' maxima). */
  maxPieces?: number;
}

export interface FormationSpec {
  kinds: FormationKind[];
  /** How likely a site is to stay empty, against the kinds' weights. */
  emptyWeight: number;
  /** Kinds (by tag) this far apart, site to site. */
  avoid?: { a: string; b: string; distance: number }[];
  /** Per tile. */
  counts?: { tag: string; min?: number; max?: number }[];
}

/**
 * A solved point of a formation: a piece (option = its index in the
 * layer's pieces, all kinds in order), or a site's unseen centre (option
 * -1 - kind index), which later layers avoid.
 */
export interface FormationPoint {
  x: number;
  y: number;
  z: number;
  /** The point's own random stream (site cell, and the piece's serial). */
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

/** Every piece of the layer's formation, all kinds in order (a point's option indexes this). */
export function formationPieces(f: FormationSpec): { piece: FormationPiece; kind: number }[] {
  return f.kinds.flatMap((k, kind) => k.pieces.map((piece) => ({ piece, kind })));
}

/** How far a formation reaches from its site (its widest piece plus clearance). */
export function formationExtent(f: FormationSpec): number {
  return Math.max(0, ...f.kinds.flatMap((k) => k.pieces.map((p) => p.radius[1] + p.clearance)));
}

/** Two formations' sites never nearer than this (so they can't overlap). */
const siteGap = (f: FormationSpec): number => 2 * formationExtent(f);

/** The longest reach across a tile border: tiles must be larger. */
export function formationReach(f: FormationSpec): number {
  return Math.max(siteGap(f), ...(f.avoid ?? []).map((a) => a.distance)) + formationExtent(f);
}

/** Check a formation layer (called by parseEcologyPlan). */
export function checkFormation(layer: EcologyLayer): void {
  const f = layer.formation;
  const bad = (m: string): never => {
    throw new Error(`ecology plan: layer "${layer.id}": ${m}`);
  };
  if (!f || layer.place.kind !== "formation") bad(`is a formation without a "formation" spec`);
  const spec = f as FormationSpec;
  if (!(layer.place.kind === "formation" && layer.place.spacing > 0)) bad("spacing must be > 0");
  if (layer.avoid) bad("a formation doesn't avoid other layers (list it first, and let later layers avoid it)");
  if (!Array.isArray(spec.kinds) || spec.kinds.length === 0) bad("a formation needs at least one kind");
  if (!(spec.emptyWeight >= 0)) bad("emptyWeight must be >= 0");
  for (const k of spec.kinds) {
    if (!(k.weight > 0)) bad(`kind "${k.id}": weight must be > 0`);
    if (!k.pieces?.length) bad(`kind "${k.id}" has no pieces`);
    for (const p of k.pieces) {
      const at = `kind "${k.id}", piece "${p.id}"`;
      if (!p.assets?.length) bad(`${at} has no assets`);
      if (!(p.count[0] >= 0 && p.count[1] >= p.count[0])) bad(`${at}: count must be [min, max] with min <= max`);
      if (!(p.radius[0] >= 0 && p.radius[1] >= p.radius[0])) bad(`${at}: radius must be [min, max] with min <= max`);
      if (!["ring", "cluster", "centre"].includes(p.pattern)) bad(`${at}: pattern must be ring, cluster or centre`);
      if (!(p.clearance > 0)) bad(`${at}: clearance must be > 0`);
    }
  }
  const tags = new Set(spec.kinds.flatMap((k) => k.tags ?? []));
  for (const t of [...(spec.avoid ?? []).flatMap((a) => [a.a, a.b]), ...(spec.counts ?? []).map((c) => c.tag)]) {
    if (!tags.has(t)) bad(`no kind is tagged "${t}"`);
  }
}

/**
 * The formation's points in the tile (ti, tj): its sites' centres and
 * pieces, solving (and caching) the earlier-phase neighbour tiles it
 * borders first.
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
    throw new Error(`ecology plan: layer "${layer.id}": the formation reaches ${reach.toFixed(1)} m across tiles, which must be less than its tile (${tileChunks} chunks = ${T} m)`);
  }

  // Earlier-phase neighbours first: their sites and pieces near our border are fixed context.
  const phase = phaseOf(ti, tj);
  const context: FormationPoint[] = [];
  const x0 = ti * T, z0 = tj * T;
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      if ((di === 0 && dj === 0) || phaseOf(ti + di, tj + dj) >= phase) continue;
      for (const p of formationTile(plan, layer, env, cache, ti + di, tj + dj)) {
        if (p.x > x0 - reach && p.x < x0 + T + reach && p.z > z0 - reach && p.z < z0 + T + reach) context.push(p);
      }
    }
  const contextSites = context.filter((p) => p.option < 0);
  const contextPieces = context.filter((p) => p.option >= 0);

  // 1. Sites: world-space cells, kept where the ground allows.
  const layerSeed = hash(env.seed32, fnv1a32(layer.id));
  const s = layer.place.spacing;
  const sites: { x: number; z: number; i: number; j: number; p: number }[] = [];
  for (let j = Math.ceil(z0 / s - 1e-9); j * s < z0 + T - 1e-9; j++)
    for (let i = Math.ceil(x0 / s - 1e-9); i * s < x0 + T - 1e-9; i++) {
      const r = (k: number): number => unit(hash(layerSeed, i, j, k));
      const x = (i + 0.05 + 0.9 * r(10)) * s;
      const z = (j + 0.05 + 0.9 * r(11)) * s;
      if (x < x0 || x >= x0 + T || z < z0 || z >= z0 + T) continue;
      const p = suitability(plan, layer, env, x, z);
      // (i | 0: Math.ceil can give -0, which a stored int32 reads back as 0.)
      if (p > 0) sites.push({ x, z, i: i | 0, j: j | 0, p });
    }
  if (sites.length === 0) {
    cache.set(layer.id, ti, tj, []);
    return [];
  }

  // 2. What each site becomes (WFC over the sites): a kind, or nothing.
  const kindTag = (k: number): string => `kind:${k}`;
  const options: WfcOption[] = [
    { id: "", weight: f.emptyWeight },
    ...f.kinds.map((k, n) => ({ id: k.id, weight: k.weight, tags: [...(k.tags ?? []), kindTag(n), "formation"] })),
  ];
  const settled = new Map(contextSites.map((c, n) => [sites.length + n, 1 + (-1 - c.option)]));
  const siteProblem = pointsProblem({
    points: [...sites.map((c) => ({ x: c.x, y: c.z })), ...contextSites.map((c) => ({ x: c.x, y: c.z }))],
    options,
    // Formations never overlap; a game's own distances between kinds on top.
    avoid: [{ a: "formation", b: "formation", distance: siteGap(f) }, ...(f.avoid ?? [])],
    counts: f.counts,
    settled,
    weight: (pt, o) => (pt < sites.length && o > 0 ? sites[pt].p : 1),
  });
  const chosen = solve(siteProblem, { seed: hash(layerSeed, ti, tj, 0x464f524d) }).assignment;

  // 3 + 4. Each formation's pieces: how many (WFC), then where (scatter + raymarcher).
  const pieces = formationPieces(f);
  const heightAt = (x: number, z: number): number => {
    const cx = Math.floor(x / W), cz = Math.floor(z / W);
    return terrainHeightAt(env.heightsOf(cx, cz), x - cx * W, z - cz * W, W);
  };
  const ground = new HeightfieldSdf(heightAt, 4);
  const out: FormationPoint[] = [];
  const placed: { x: number; z: number; r: number }[] = contextPieces.map((p) => ({ x: p.x, z: p.z, r: pieces[p.option].piece.clearance }));
  sites.forEach((site, k) => {
    const kindIndex = chosen[k] - 1;
    if (kindIndex < 0) return;
    const kind = f.kinds[kindIndex];
    const siteY = heightAt(site.x, site.z);
    out.push({ x: site.x, y: siteY, z: site.z, i: site.i, j: site.j * 64 + 63, option: -1 - kindIndex });
    // How many of each piece: WFC within the kind's piece budget.
    const top = Math.max(...kind.pieces.map((p) => p.count[1]));
    const counts = solve(
      {
        options: Array.from({ length: top + 1 }, (_, n) => ({ id: String(n) })),
        slots: kind.pieces.length,
        domains: kind.pieces.map((p) => Array.from({ length: p.count[1] - p.count[0] + 1 }, (_, n) => p.count[0] + n)),
        budgets: kind.maxPieces === undefined ? [] : [{ cost: Array.from({ length: top + 1 }, (_, n) => n), max: kind.maxPieces }],
      },
      { seed: hash(layerSeed, site.i, site.j, 0x434f554e) },
    ).assignment;
    const rand = mulberry32(hash(layerSeed, site.i, site.j, 0x57484552));
    let serial = 0;
    kind.pieces.forEach((piece, n) => {
      const option = pieces.findIndex((q) => q.piece === piece);
      const want = counts[n];
      // Scatter: candidate spots by pattern.
      let spots: { x: number; z: number }[];
      if (piece.pattern === "centre") spots = [{ x: site.x, z: site.z }];
      else if (piece.pattern === "ring") {
        const start = rand() * Math.PI * 2;
        // Evenly round the ring, a little jittered; twice as many spots as wanted, the extras spare.
        const m = Math.max(1, want * 2);
        spots = Array.from({ length: m }, (_, q) => {
          const a = start + (q * Math.PI * 2) / m + (rand() - 0.5) * (Math.PI / m) * 0.5;
          const r = piece.radius[0] + (piece.radius[1] - piece.radius[0]) * rand();
          return { x: site.x + Math.cos(a) * r, z: site.z + Math.sin(a) * r };
        });
        // Alternate spots first, so a ring left short still goes all the way round.
        spots = [...spots.filter((_, q) => q % 2 === 0), ...spots.filter((_, q) => q % 2 === 1)];
      } else {
        const R = Math.max(piece.radius[1], 1e-3);
        spots = poissonDisc(
          { x0: site.x - R, y0: site.z - R, x1: site.x + R, y1: site.z + R, inside: (x, y) => {
            const d = Math.hypot(x - site.x, y - site.z);
            return d >= piece.radius[0] && d <= R;
          } },
          piece.clearance,
          hash(layerSeed, site.i, site.j, 100 + n),
        ).map((p) => ({ x: p.x, z: p.y }));
      }
      let got = 0;
      for (const spot of spots) {
        if (got >= want) break;
        if (placed.some((q) => Math.hypot(q.x - spot.x, q.z - spot.z) < Math.max(q.r, piece.clearance))) continue;
        // The raymarcher sets it on the ground; too steep there, and it moves on.
        const hit = snapToGround(ground, spot.x, spot.z, heightAt(spot.x, spot.z) + 20, 60);
        if (!hit) continue;
        const [, ny] = hit.normal;
        const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(ny, 1e-6);
        if (slope > (piece.maxSlope ?? 0.6)) continue;
        placed.push({ x: spot.x, z: spot.z, r: piece.clearance });
        out.push({ x: spot.x, y: hit.y, z: spot.z, i: site.i, j: site.j * 64 + serial++, option });
        got++;
      }
    });
  });
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
