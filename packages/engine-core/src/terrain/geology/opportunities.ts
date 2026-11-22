/**
 * Gameplay opportunities on a surveyed world: the second pass that turns
 * geography into decisions. Works on any survey; when the survey carries
 * geology, resources follow province kinds (a designer table), otherwise
 * they follow what the terrain shows (the simpler baseline).
 *
 *  - two complementary resources (ore on belts and old cores, fuel in basins),
 *    sampled with spacing, never exact guarantees;
 *  - settlement candidates (flat, near fresh water, near some resources) and
 *    a chosen pair that specialise in different resources;
 *  - the best bridge between them over a river that blocks carts, with the
 *    detour it saves and proof that a route exists without it;
 *  - alternative routes between the pair (penalty method);
 *  - readability proxies (landform regions, landmarks, macro coherence) and
 *    a surveying proxy (does survey knowledge beat looking at the terrain?).
 *
 * Offline only: runs at bake/authoring time on the coarse survey grid.
 * Deterministic: seeded mulberry32, fixed scan orders, ties broken by index.
 */

import { boxBlur, distanceTo, slopeDegrees } from "../grid-ops.js";
import { LAKE, LAND, SEA } from "../hydrology.js";
import type { Survey } from "../survey.js";
import { mulberry32 } from "../survey.js";
import { PROVINCE_KINDS, type ProvinceKind } from "./snapshot.js";

export type ResourceId = "ore" | "fuel";

/**
 * Designer table keyed to provinces the terrain shows: ore on the mountain
 * belts, fuel in the lowland basins. Kept for comparison.
 */
export const VISIBLE_RESOURCE_TABLE: Record<ResourceId, Partial<Record<ProvinceKind, number>>> = {
  ore: { orogen: 1, arc: 0.8, suture: 0.9, craton: 0.55, transform: 0.35, rift: 0.25, platform: 0.08, foreland: 0.04 },
  fuel: { foreland: 1, rift: 0.75, platform: 0.45, transform: 0.2, suture: 0.1, craton: 0.03, orogen: 0.03, arc: 0.05 },
};

/**
 * The same idea keyed to provinces the terrain does not give away: old
 * sutures and cratons (worn flat) carry the ore, so surveying pays.
 * Default: in geology:compare (3 seeds, 4 km world) it raised the survey
 * advantage from about 0 to 0.83..0.92 with the same monopoly share and
 * starter access as the visible table.
 */
export const HIDDEN_RESOURCE_TABLE: Record<ResourceId, Partial<Record<ProvinceKind, number>>> = {
  ore: { suture: 1, craton: 0.9, transform: 0.6, arc: 0.5, orogen: 0.4, rift: 0.2, platform: 0.05, foreland: 0.03 },
  fuel: { foreland: 1, rift: 0.8, transform: 0.35, platform: 0.25, suture: 0.05, craton: 0.03, orogen: 0.02, arc: 0.05 },
};

export const DEFAULT_RESOURCE_TABLE = HIDDEN_RESOURCE_TABLE;

export interface OpportunityOptions {
  seed?: number;
  /** Deposits per resource. */
  deposits?: number;
  /** Minimum spacing between deposits of one resource, metres. */
  depositSpacingM?: number;
  table?: Record<ResourceId, Partial<Record<ProvinceKind, number>>>;
  /** Longest bridge span, metres. */
  maxBridgeSpanM?: number;
  /** Rivers carrying at least this many times the river threshold block carts (no ford). */
  barrierCatchments?: number;
  /** Minimum distance between the settlement pair, metres. */
  minSiteSeparationM?: number;
  /** World-space spawn (newcomer area) to check starter resources against. */
  spawn?: { x: number; z: number };
}

export interface Deposit { resource: ResourceId; x: number; z: number; richness: number; province: string | null; kind: ProvinceKind | null }
export interface Site { x: number; z: number; score: number; province: string | null; kind: ProvinceKind | null; nearestOreM: number; nearestFuelM: number }
export interface Bridge {
  /** Bank-to-bank endpoints, world metres. */
  a: { x: number; z: number };
  b: { x: number; z: number };
  spanM: number;
  /** Rain-weighted catchment at the crossing, m². */
  catchmentM2: number;
  /** Route cost between the sites with and without this bridge (cost-metres). */
  costWith: number;
  costWithout: number;
  /** Share of the no-bridge route the bridge saves (0..1). */
  saving: number;
}
export interface Route { cost: number; lengthM: number; points: Array<{ x: number; z: number }>; maxGrade: number; overlapWithFirst: number }

export interface OpportunityMetrics {
  /** Landform regions covering ≥ 0.5% of the land each, and the land share in the six largest. */
  landformRegions: number;
  topSixLandShare: number;
  /** Peaks standing ≥ 40 m above their 200 m surroundings. */
  landmarks: number;
  /** Share of height variance at ≥ 400 m scale (macro structure vs noise). */
  macroCoherence: number;
  /** Sites scoring ≥ 70% of the best, ≥ minSiteSeparation apart. */
  viableSites: number;
  /** Routes ≤ 1.6 × the best cost, overlapping the first by < 50%. */
  viableRoutes: number;
  /** Deposit capture of the top-quarter land ranked by (a) visible terrain, (b) survey knowledge; lift = capture / 0.25. */
  terrainLift: number;
  surveyLift: number;
  /** surveyLift − terrainLift: what surveying adds over reading the terrain. */
  surveyAdvantage: number;
  /** Deposits of each resource within 600 m of spawn (newcomer safeguard). */
  starterOre: number;
  starterFuel: number;
  /** Largest share of one resource's deposits inside a single province (monopoly risk). */
  maxProvinceShare: number;
  /** A cart route exists between the sites with no bridge (alternative-route safeguard). */
  routeWithoutBridge: boolean;
}

export interface OpportunityReport {
  deposits: Deposit[];
  candidates: Site[];
  sites: [Site, Site] | null;
  bridge: Bridge | null;
  routes: Route[];
  metrics: OpportunityMetrics;
  timingsMs: Record<string, number>;
}

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ---------------------------------------------------------------------------
// Least-cost travel (8-connected Dijkstra, binary heap)
// ---------------------------------------------------------------------------

class Heap {
  private k = new Float64Array(1024);
  private v = new Int32Array(1024);
  size = 0;
  push(key: number, val: number): void {
    if (this.size === this.k.length) {
      const k2 = new Float64Array(this.size * 2);
      k2.set(this.k);
      const v2 = new Int32Array(this.size * 2);
      v2.set(this.v);
      this.k = k2;
      this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] < key || (this.k[p] === key && this.v[p] <= val)) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop(): [number, number] {
    const key = this.k[0];
    const val = this.v[0];
    const lk = this.k[--this.size];
    const lv = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && (this.k[c + 1] < this.k[c] || (this.k[c + 1] === this.k[c] && this.v[c + 1] < this.v[c]))) c++;
      if (lk < this.k[c] || (lk === this.k[c] && lv <= this.v[c])) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = lk;
    this.v[i] = lv;
    return [key, val];
  }
}

export interface TravelGrid {
  W: number;
  D: number;
  cell: number;
  height: Float32Array;
  /** 1 = cannot be entered by a cart. */
  blocked: Uint8Array;
  /** Extra cost multiplier per cell (fords, penalties); 1 = none. */
  factor: Float32Array;
}

/** Cart step cost: distance × (1 + (grade / 0.12)²) × the cell's factor. */
function stepCost(g: TravelGrid, i: number, j: number, run: number): number {
  const grade = Math.abs(g.height[j] - g.height[i]) / run;
  const q = grade / 0.12;
  return run * (1 + q * q) * g.factor[j];
}

const OFFS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export function travelCosts(g: TravelGrid, from: number, parent?: Int32Array): Float64Array {
  const dist = new Float64Array(g.W * g.D).fill(Infinity);
  if (parent) parent.fill(-1);
  const heap = new Heap();
  dist[from] = 0;
  heap.push(0, from);
  while (heap.size > 0) {
    const [d, i] = heap.pop();
    if (d > dist[i]) continue;
    const u = i % g.W;
    const v = (i - u) / g.W;
    for (const [du, dv, len] of OFFS) {
      const uu = u + du;
      const vv = v + dv;
      if (uu < 0 || vv < 0 || uu >= g.W || vv >= g.D) continue;
      const j = vv * g.W + uu;
      if (g.blocked[j]) continue;
      // No cutting corners past a blocked cell.
      if (du !== 0 && dv !== 0 && (g.blocked[v * g.W + uu] || g.blocked[vv * g.W + u])) continue;
      const nd = d + stepCost(g, i, j, len * g.cell);
      if (nd < dist[j]) {
        dist[j] = nd;
        if (parent) parent[j] = i;
        heap.push(nd, j);
      }
    }
  }
  return dist;
}

function pathTo(parent: Int32Array, to: number): number[] {
  const out: number[] = [];
  for (let i = to; i >= 0; i = parent[i]) out.push(i);
  return out.reverse();
}

// ---------------------------------------------------------------------------

export function findOpportunities(survey: Survey, opts: OpportunityOptions = {}): OpportunityReport {
  const t = { start: performance.now() };
  const timingsMs: Record<string, number> = {};
  const lap = (name: string): void => {
    const now = performance.now();
    timingsMs[name] = Math.round((now - t.start) * 10) / 10;
    t.start = now;
  };
  const { grid, height, water, river, flow, spec } = survey;
  const W = grid.width;
  const D = grid.depth;
  const N = W * D;
  const cell = grid.cell;
  const sea = spec.land.seaLevel;
  const geo = survey.geology;
  const table = opts.table ?? DEFAULT_RESOURCE_TABLE;
  const rng = mulberry32(((opts.seed ?? spec.seed) ^ 0x0990) >>> 0);
  const xOf = (i: number): number => grid.originX + (i % W) * cell;
  const zOf = (i: number): number => grid.originZ + Math.floor(i / W) * cell;
  const at = (x: number, z: number): number => {
    const u = Math.min(W - 1, Math.max(0, Math.round((x - grid.originX) / cell)));
    const v = Math.min(D - 1, Math.max(0, Math.round((z - grid.originZ) / cell)));
    return v * W + u;
  };

  // Only the world proper (the survey grid has a margin past the edges).
  const half = (spec.sizeChunks * spec.chunkWorldSize) / 2;
  const inWorld = new Uint8Array(N);
  for (let i = 0; i < N; i++) inWorld[i] = Math.abs(xOf(i)) < half - cell && Math.abs(zOf(i)) < half - cell ? 1 : 0;

  const slope = slopeDegrees(height, W, D, cell);
  const macro = boxBlur(height, W, D, 200 / cell / 2);
  const land = (i: number): boolean => inWorld[i] === 1 && water[i] === LAND;
  const kindAt = (i: number): ProvinceKind | null => (geo ? PROVINCE_KINDS[geo.kind[i]] : null);
  const provAt = (i: number): string | null => (geo ? geo.provinces[geo.province[i]].id : null);

  // What a player sees: high, steep ground looks like ore country; low flat
  // ground by water looks like fuel country. The baseline places by this.
  const visible: Record<ResourceId, (i: number) => number> = {
    ore: (i) => smooth01((height[i] - sea - 60) / 200) * (0.5 + 0.5 * smooth01(slope[i] / 25)),
    fuel: (i) => smooth01((60 - (height[i] - sea)) / 50) * smooth01((10 - slope[i]) / 8),
  };
  const affinity = (r: ResourceId, i: number): number => {
    if (!geo) return visible[r](i);
    return table[r][PROVINCE_KINDS[geo.kind[i]]] ?? 0;
  };

  // ---- deposits -------------------------------------------------------------
  const order: number[] = [];
  for (let i = 0; i < N; i++) if (land(i) && !river[i] && slope[i] < 35) order.push(i);
  for (let k = order.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    const tmp = order[k];
    order[k] = order[j];
    order[j] = tmp;
  }
  const count = opts.deposits ?? 24;
  const spacing = opts.depositSpacingM ?? 220;
  const deposits: Deposit[] = [];
  for (const r of ["ore", "fuel"] as const) {
    const mine: Deposit[] = [];
    for (let pass = 0; pass < 6 && mine.length < count; pass++) {
      for (const i of order) {
        if (mine.length >= count) break;
        const a = affinity(r, i);
        if (a <= 0 || rng() >= a * 0.05) continue;
        const x = xOf(i);
        const z = zOf(i);
        if (mine.some((d) => (d.x - x) ** 2 + (d.z - z) ** 2 < spacing * spacing)) continue;
        mine.push({ resource: r, x, z, richness: Math.round((0.4 + 0.6 * a * (0.6 + 0.4 * rng())) * 100) / 100, province: provAt(i), kind: kindAt(i) });
      }
    }
    deposits.push(...mine);
  }
  lap("deposits");

  // ---- settlement candidates ------------------------------------------------
  const fresh = distanceTo(W, D, cell, (i) => water[i] === LAKE || river[i] === 1);
  const flatness = boxBlur(slope, W, D, 40 / cell);
  const nearest = (r: ResourceId, x: number, z: number): number => {
    let best = Infinity;
    for (const d of deposits) if (d.resource === r) best = Math.min(best, Math.sqrt((d.x - x) ** 2 + (d.z - z) ** 2));
    return best;
  };
  const near = (m: number): number => smooth01((900 - m) / 700);
  const score = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!land(i) || river[i] || slope[i] > 6 || height[i] < sea + 2) continue;
    const f = fresh[i];
    const sw = f < 15 ? 0.3 : f < 180 ? 1 : smooth01((600 - f) / 420);
    const sf = Math.max(0, 1 - flatness[i] / 8);
    score[i] = sw * sf;
  }
  // Greedy non-max suppression, then resource access.
  const minSep = opts.minSiteSeparationM ?? 700;
  const ranked: number[] = [];
  for (let i = 0; i < N; i++) if (score[i] > 0.2) ranked.push(i);
  ranked.sort((a, b) => score[b] - score[a] || a - b);
  const candidates: Site[] = [];
  for (const i of ranked) {
    if (candidates.length >= 12) break;
    const x = xOf(i);
    const z = zOf(i);
    if (candidates.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < (minSep / 2) ** 2)) continue;
    const o = nearest("ore", x, z);
    const fu = nearest("fuel", x, z);
    // Near some resources but (by design) rarely all: access counts the better one fully, the other half.
    const access = Math.max(near(o), near(fu)) + 0.5 * Math.min(near(o), near(fu));
    candidates.push({ x, z, score: Math.round(score[i] * (0.35 + 0.65 * (access / 1.5)) * 1000) / 1000, province: provAt(i), kind: kindAt(i), nearestOreM: Math.round(o), nearestFuelM: Math.round(fu) });
  }
  candidates.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
  lap("sites");

  // ---- travel grid ------------------------------------------------------------
  const barrier = (opts.barrierCatchments ?? 3) * spec.rivers.minCatchment;
  const blocked = new Uint8Array(N);
  const factor = new Float32Array(N).fill(1);
  for (let i = 0; i < N; i++) {
    if (!inWorld[i] || water[i] === SEA || water[i] === LAKE) blocked[i] = 1;
    else if (river[i]) {
      if (flow[i] >= barrier) blocked[i] = 1;
      else factor[i] = 6; // a ford: slow and wet
    }
  }
  const g: TravelGrid = { W, D, cell, height, blocked, factor };
  const baseFactor = (i: number): number => (river[i] && !blocked[i] && flow[i] < barrier ? 6 : 1);
  const penalty = new Float32Array(N).fill(1);

  // Every possible span over a cart-blocking river: bank cell -> bank cell,
  // straight, over river only, deck grade <= 12%.
  const maxSpan = Math.round((opts.maxBridgeSpanM ?? 48) / cell);
  const spans: Array<{ p: number; q: number; spanM: number; catchment: number }> = [];
  for (let p = 0; p < N; p++) {
    if (blocked[p] || river[p]) continue;
    const u = p % W;
    const v = (p - u) / W;
    for (const [du, dv, len] of OFFS) {
      let catchment = 0;
      for (let s2 = 1; s2 <= maxSpan; s2++) {
        const uu = u + du * s2;
        const vv = v + dv * s2;
        if (uu < 0 || vv < 0 || uu >= W || vv >= D) break;
        const j = vv * W + uu;
        if (river[j] && water[j] === LAND) {
          catchment = Math.max(catchment, flow[j]);
          continue;
        }
        if (s2 > 1 && catchment >= barrier && !blocked[j] && j > p) {
          const spanM = s2 * len * cell;
          if (Math.abs(height[j] - height[p]) / spanM <= 0.12) spans.push({ p, q: j, spanM, catchment });
        }
        break;
      }
    }
  }

  // Pair: two sites that specialise in different resources, preferring a
  // pair a bridge would bring closer, and never a pair only a bridge joins.
  const lean = (st: Site): number => near(st.nearestOreM) - near(st.nearestFuelM); // > 0 ore town
  const pool = candidates.slice(0, 8);
  const dist = pool.map((c) => travelCosts(g, at(c.x, c.z)));
  lap("travel");
  let sites: [Site, Site] | null = null;
  let pairBridge: { cost: number; without: number; span: (typeof spans)[number] } | null = null;
  let bestVal = -Infinity;
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      const A = pool[a];
      const B = pool[b];
      if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 < minSep * minSep) continue;
      const without = dist[a][at(B.x, B.z)];
      if (!Number.isFinite(without)) continue; // safeguard: a route must exist without the bridge
      let via = Infinity;
      let span: (typeof spans)[number] | null = null;
      for (const sp of spans) {
        const c1 = dist[a][sp.p] + sp.spanM + dist[b][sp.q];
        const c2 = dist[a][sp.q] + sp.spanM + dist[b][sp.p];
        const c = c1 < c2 ? c1 : c2;
        if (c < via) { via = c; span = sp; }
      }
      const saving = span && via < without ? 1 - via / without : 0;
      const comp = Math.max(0, -lean(A) * lean(B));
      const val = A.score * B.score * (1 + 2 * comp) * (1 + 2 * saving);
      if (val > bestVal) {
        bestVal = val;
        sites = [A, B];
        pairBridge = span && saving > 0.02 ? { cost: via, without, span } : null;
      }
    }
  }
  lap("pairing");

  let bridge: Bridge | null = null;
  const routes: Route[] = [];
  let routeWithoutBridge = false;
  if (sites) {
    const ia = at(sites[0].x, sites[0].z);
    const ib = at(sites[1].x, sites[1].z);
    routeWithoutBridge = true;
    if (pairBridge) {
      const best = pairBridge.span;
      bridge = {
        a: { x: xOf(best.p), z: zOf(best.p) },
        b: { x: xOf(best.q), z: zOf(best.q) },
        spanM: Math.round(best.spanM),
        catchmentM2: Math.round(best.catchment),
        costWith: Math.round(pairBridge.cost),
        costWithout: Math.round(pairBridge.without),
        saving: Math.round((1 - pairBridge.cost / pairBridge.without) * 1000) / 1000,
      };
      // Build it: the bridge cells become passable deck.
      const du = Math.sign(xOf(best.q) - xOf(best.p)) / cell;
      const dv = Math.sign(zOf(best.q) - zOf(best.p)) / cell;
      for (let s2 = 0, i = best.p; i !== best.q && s2 < 64; s2++) {
        i += Math.round(dv * cell) * W + Math.round(du * cell);
        blocked[i] = 0;
        factor[i] = 1;
      }
    }
    lap("bridge");

    // Alternatives: penalise the corridor of each found route and search again.
    const parent = new Int32Array(N);
    const near40 = 40 / cell;
    const firstCells = new Set<number>();
    let bestCost = Infinity;
    for (let k = 0; k < 4; k++) {
      const d = travelCosts(g, ia, parent);
      if (!Number.isFinite(d[ib])) break;
      const cells = pathTo(parent, ib);
      // True (unpenalised) cost and length.
      let cost = 0;
      let lengthM = 0;
      let maxGrade = 0;
      const save = Float32Array.from(factor);
      for (let s = 1; s < cells.length; s++) {
        const i = cells[s - 1];
        const j = cells[s];
        const run = (i % W !== j % W && Math.floor(i / W) !== Math.floor(j / W) ? Math.SQRT2 : 1) * cell;
        lengthM += run;
        maxGrade = Math.max(maxGrade, Math.abs(height[j] - height[i]) / run);
        cost += run * (1 + (Math.abs(height[j] - height[i]) / run / 0.12) ** 2) * baseFactor(j);
      }
      if (k === 0) {
        bestCost = cost;
        for (const c of cells) firstCells.add(c);
      }
      let overlap = 0;
      for (const c of cells) if (firstCells.has(c)) overlap++;
      const route: Route = {
        cost: Math.round(cost),
        lengthM: Math.round(lengthM),
        maxGrade: Math.round(maxGrade * 1000) / 1000,
        overlapWithFirst: Math.round((overlap / cells.length) * 1000) / 1000,
        points: cells.filter((_, s) => s % 4 === 0 || s === cells.length - 1).map((c) => ({ x: xOf(c), z: zOf(c) })),
      };
      if (k === 0 || (cost <= 1.6 * bestCost && route.overlapWithFirst < 0.5 && !routes.some((r) => Math.abs(r.cost - route.cost) < 1 && r.lengthM === route.lengthM))) routes.push(route);
      factor.set(save);
      // Penalise everything near every route found so far.
      for (const c of cells) {
        const cu = c % W;
        const cv = (c - cu) / W;
        for (let dv = -near40; dv <= near40; dv++) {
          for (let du = -near40; du <= near40; du++) {
            const uu = cu + du;
            const vv = cv + dv;
            if (uu >= 0 && vv >= 0 && uu < W && vv < D) penalty[vv * W + uu] = 4;
          }
        }
      }
      for (let i = 0; i < N; i++) factor[i] = baseFactor(i) * penalty[i];
    }
    for (let i = 0; i < N; i++) factor[i] = baseFactor(i);
    lap("routes");
  }

  // ---- metrics ----------------------------------------------------------------
  // Landform classes from the final terrain (same classifier for both arms).
  const cls = new Uint8Array(N);
  let landCells = 0;
  for (let i = 0; i < N; i++) {
    if (!land(i)) continue;
    landCells++;
    const above = macro[i] - sea;
    const rel = height[i] - macro[i];
    cls[i] = slope[i] > 25 || above > 220 ? 1 : above > 90 ? 2 : rel < -12 ? 3 : rel > 12 ? 4 : above < 20 ? 5 : 6;
  }
  const lbl = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (lbl[s] >= 0 || cls[s] === 0) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    lbl[s] = id;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const u = i % W;
      for (const j of [u > 0 ? i - 1 : -1, u < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= N || lbl[j] >= 0 || cls[j] !== cls[s]) continue;
        lbl[j] = id;
        stack[top++] = j;
      }
    }
    sizes.push(size);
  }
  const bigRegions = sizes.filter((s) => s >= 0.005 * landCells).sort((a, b) => b - a);
  const topSix = bigRegions.slice(0, 6).reduce((a, b) => a + b, 0) / Math.max(1, landCells);
  let landmarks = 0;
  const R = 6;
  for (let v = R; v < D - R; v++) {
    for (let u = R; u < W - R; u++) {
      const i = v * W + u;
      if (!land(i) || height[i] - macro[i] < 40) continue;
      let peak = true;
      for (let dv = -R; dv <= R && peak; dv++) for (let du = -R; du <= R; du++) if (height[i + dv * W + du] > height[i]) { peak = false; break; }
      if (peak) landmarks++;
    }
  }
  const big = boxBlur(height, W, D, 400 / cell / 2);
  let mean = 0;
  for (let i = 0; i < N; i++) if (land(i)) mean += height[i];
  mean /= Math.max(1, landCells);
  let vAll = 0;
  let vBig = 0;
  for (let i = 0; i < N; i++) {
    if (!land(i)) continue;
    vAll += (height[i] - mean) ** 2;
    vBig += (big[i] - mean) ** 2;
  }

  // Surveying: top-quarter capture by visible terrain vs survey knowledge.
  const lift = (pred: (r: ResourceId, i: number) => number): number => {
    let caught = 0;
    for (const r of ["ore", "fuel"] as const) {
      const vals: number[] = [];
      for (let i = 0; i < N; i++) if (land(i)) vals.push(pred(r, i));
      vals.sort((a, b) => b - a);
      const cut = vals[Math.floor(vals.length * 0.25)];
      // Ties at the cut count by the share of tied cells above it.
      const mine = deposits.filter((d) => d.resource === r);
      for (const d of mine) if (pred(r, at(d.x, d.z)) > cut) caught++;
    }
    return caught / Math.max(1, deposits.length) / 0.25;
  };
  const terrainLift = lift((r, i) => visible[r](i));
  const surveyLift = geo ? lift((r, i) => affinity(r, i) + 1e-3 * visible[r](i)) : terrainLift;

  const spawn = opts.spawn ?? { x: 0, z: 0 };
  const within = (r: ResourceId): number => deposits.filter((d) => d.resource === r && (d.x - spawn.x) ** 2 + (d.z - spawn.z) ** 2 <= 600 * 600).length;
  let maxProvinceShare = 0;
  for (const r of ["ore", "fuel"] as const) {
    const mine = deposits.filter((d) => d.resource === r);
    const byProv = new Map<string, number>();
    // Baseline has no provinces: use landform regions as the comparable unit.
    for (const d of mine) {
      const key = d.province ?? `L${lbl[at(d.x, d.z)]}`;
      byProv.set(key, (byProv.get(key) ?? 0) + 1);
    }
    for (const c of byProv.values()) maxProvinceShare = Math.max(maxProvinceShare, c / Math.max(1, mine.length));
  }
  const viableSites = candidates.filter((c) => c.score >= 0.7 * (candidates[0]?.score ?? 0)).length;
  lap("metrics");

  return {
    deposits,
    candidates,
    sites,
    bridge,
    routes,
    metrics: {
      landformRegions: bigRegions.length,
      topSixLandShare: Math.round(topSix * 1000) / 1000,
      landmarks,
      macroCoherence: Math.round((vBig / Math.max(1e-9, vAll)) * 1000) / 1000,
      viableSites,
      viableRoutes: routes.length,
      terrainLift: Math.round(terrainLift * 100) / 100,
      surveyLift: Math.round(surveyLift * 100) / 100,
      surveyAdvantage: Math.round((surveyLift - terrainLift) * 100) / 100,
      starterOre: within("ore"),
      starterFuel: within("fuel"),
      maxProvinceShare: Math.round(maxProvinceShare * 1000) / 1000,
      routeWithoutBridge,
    },
    timingsMs,
  };
}
