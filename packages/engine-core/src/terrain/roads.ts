/**
 * Road horizontal alignment (SETTLEMENTS.md §28 / ROADMAP SG2b).
 *
 * Settlement roads arrive as a graph: `nodes` (junctions, x/z in mm) and
 * `edges` (from→to with roadClass, widthMm, surface). This module turns that
 * graph into smooth, terrain-draped Catmull-Rom spline ribbons — the alignment
 * layer that replaces the straight `paved_road` slabs the scene baker currently
 * lays along each edge (see `content/settlements/0003.settlement.json`).
 *
 * Pure math: no three.js, no node:crypto, so it runs in the server bake, the
 * client renderer, and a browser preview. Re-use this repo's content-addressing
 * at the call site, the same way `chunk-baker.ts` keys on a sha256:
 *   import { createHash } from "node:crypto";
 *   const hash = createHash("sha256").update(canonicalRoads(nodes, edges, opts)).digest("hex");
 */

export interface RoadNode {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

export interface RoadEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly roadClass: string;
  readonly widthMm: number;
  readonly surface: string;
}

export interface RoadPath {
  /** Junctions along this continuous chain, in traversal order, [x, z] in mm. */
  readonly nodes: Array<[number, number]>;
  readonly roadClass: string;
  readonly widthMm: number;
}

export interface RoadRibbon {
  /** Centerline samples (draped): x, y, z, x, y, z, … (length a multiple of 3). */
  readonly center: number[];
  /** Left and right rails: x, y, z, … — one sample per centerline point. */
  readonly left: number[];
  readonly right: number[];
  readonly roadClass: string;
  readonly widthMm: number;
}

export interface RoadNetworkOptions {
  /** Samples per millimetre of path length. Default ~2/m. */
  samplesPerMm?: number;
  /** Catmull-Rom tension: 0 = standard smooth, 1 = linear. Default 0. */
  tension?: number;
  /**
   * Identity of the terrain the ribbons are draped against — e.g. the chunk
   * survey hash from `chunk-source.ts`. Because `splineRoads` derives its
   * y-values from `height`, the cached *draped* ribbon is stale when terrain
   * changes even if the road graph is identical, so the terrain version is part
   * of the content key. Defaults to "" (graph-only key).
   */
  terrainVersion?: string;
}

const DEFAULTS: Required<RoadNetworkOptions> = {
  samplesPerMm: 1 / 500,
  tension: 0,
  terrainVersion: "",
};

type Pt = number[];

const sub = (a: Pt, b: Pt): Pt => a.map((v, i) => v - b[i]);
const add = (a: Pt, b: Pt): Pt => a.map((v, i) => v + b[i]);
const scale = (a: Pt, s: number): Pt => a.map((v) => v * s);
const len = (a: Pt): number => Math.hypot(...a);

/** Adjacency: for each junction, the edges leaving it (each edge counted both ways). */
function adjacency(edges: RoadEdge[]): Map<string, Array<{ to: string; edge: RoadEdge }>> {
  const adj = new Map<string, Array<{ to: string; edge: RoadEdge }>>();
  const push = (from: string, to: string, edge: RoadEdge) => {
    let a = adj.get(from);
    if (!a) { a = []; adj.set(from, a); }
    a.push({ to, edge });
  };
  for (const e of edges) { push(e.from, e.to, e); push(e.to, e.from, e); }
  return adj;
}

/** Degree (number of incident edges) per junction. */
function degrees(edges: RoadEdge[]): Map<string, number> {
  const d = new Map<string, number>();
  const bump = (k: string) => d.set(k, (d.get(k) ?? 0) + 1);
  for (const e of edges) { bump(e.from); bump(e.to); }
  return d;
}

/**
 * Chain the road graph into continuous paths. Each path is a maximal run of
 * edges linked through degree-2 junctions; endpoints sit at junctions whose
 * degree isn't 2 (dead ends, corners, T-junctions, crossings). Long straight
 * runs become one spline that curves only through real turns, while every grid
 * edge still appears exactly once.
 */
export function buildPaths(nodes: RoadNode[], edges: RoadEdge[]): RoadPath[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const adj = adjacency(edges);
  const deg = degrees(edges);
  const used = new Set<string>();
  const pos = (id: string): [number, number] | undefined => {
    const n = byId.get(id);
    return n ? [n.x, n.z] : undefined;
  };
  const paths: RoadPath[] = [];

  /**
   * Extend `out` from `start`, through degree-2 junctions, recording each
   * junction stepped TO. The chain ends at a degree-≠2 junction, a dead end,
   * an already-used edge, or — so each ribbon is one roadClass/widthMm — any
   * edge whose class or width differs from the path's initiating edge.
   */
  const walk = (start: string, came: string, klass: string, width: number, out: string[]): void => {
    let cur = start;
    let prev = came;
    for (;;) {
      const nbrs = adj.get(cur);
      if (!nbrs) break;
      const nxt = nbrs.find((n) => n.to !== prev);
      if (!nxt) break; // dead end
      if (nxt.edge.roadClass !== klass || nxt.edge.widthMm !== width) break;
      if (used.has(nxt.edge.id)) break;
      used.add(nxt.edge.id);
      out.push(nxt.to);
      prev = cur;
      cur = nxt.to;
      if ((deg.get(cur) ?? 0) !== 2) break; // stop at the junction where this chain ends
    }
  };

  for (const e of edges) {
    if (used.has(e.id)) continue;
    used.add(e.id);
    const fwd: string[] = [];
    const back: string[] = [];
    walk(e.to, e.from, e.roadClass, e.widthMm, fwd);
    walk(e.from, e.to, e.roadClass, e.widthMm, back);
    // Junction-ordered chain: [..reverse(back), e.from, e.to, ..fwd].
    const ids = [...back.reverse(), e.from, e.to, ...fwd];
    const chain: Array<[number, number]> = [];
    for (const id of ids) {
      const p = pos(id);
      if (p) chain.push(p);
    }
    paths.push({ nodes: chain, roadClass: e.roadClass, widthMm: e.widthMm });
  }
  return paths;
}

/** A 3-axis Hermite (Catmull-Rom) segment. `tension` 0 = smooth, 1 = linear. */
function hermiteSeg(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number, tension: number): Pt {
  const s = 1 - tension;
  const m0 = scale(sub(p2, p0), 0.5 * s);
  const m1 = scale(sub(p3, p1), 0.5 * s);
  const tt = t * t;
  const t3 = tt * t;
  const h00 = 2 * t3 - 3 * tt + 1;
  const h10 = t3 - 2 * tt + t;
  const h01 = -2 * t3 + 3 * tt;
  const h11 = t3 - tt;
  const d = p0.length;
  const r = new Array(d);
  for (let i = 0; i < d; i++) r[i] = p1[i] * h00 + m0[i] * h10 + p2[i] * h01 + m1[i] * h11;
  return r;
}

/** Mirror endpoints so an open curve leaves its first/last point with a natural tangent. */
const endMirror = (path: Pt[], i: number): Pt => {
  if (i < 0) return add(scale(path[0], 2), scale(path[1], -1));
  if (i > path.length - 1) return add(scale(path[path.length - 1], 2), scale(path[path.length - 2], -1));
  return path[i];
};

/**
 * Catmull-Rom spline through `path`, sampled at `samplesPerMm` per mm of chord.
 * Open curves; endpoints are exact. Works on [x,z] or [x,y,z] points.
 */
export function catmullRom(path: Pt[], samplesPerMm?: number, tension?: number): Pt[] {
  const s = samplesPerMm ?? DEFAULTS.samplesPerMm;
  const t = tension ?? DEFAULTS.tension;
  const n = path.length;
  if (n === 0) return [];
  if (n === 1) return [path[0].slice()];
  const out: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = endMirror(path, i);
    const p1 = path[i];
    const p2 = path[i + 1];
    const p3 = endMirror(path, i + 2);
    const segLen = len(sub(p1, p2));
    const ns = Math.max(1, Math.ceil(segLen * s));
    for (let k = 0; k < ns; k++) out.push(hermiteSeg(p0, p1, p2, p3, k / ns, t));
    out.push(p2.slice()); // hold the seam exact
  }
  return out;
}

/** Height above the road surface at world (x, z) mm, or null where unknown. */
export type HeightFn = (x: number, z: number) => number | null;

/**
 * Spline every junction path, drape each sample to `height`, and build a
 * ribbon (centerline + left/right rails at half the road width). Returns one
 * ribbon per road path, in stable order.
 */
export function splineRoads(
  nodes: RoadNode[],
  edges: RoadEdge[],
  height: HeightFn,
  opts?: RoadNetworkOptions,
): RoadRibbon[] {
  const samplesPerMm = opts?.samplesPerMm ?? DEFAULTS.samplesPerMm;
  const tension = opts?.tension ?? DEFAULTS.tension;
  const paths = buildPaths(nodes, edges);
  const ribbons: RoadRibbon[] = [];
  for (const path of paths) {
    const curve = catmullRom(path.nodes as Pt[], samplesPerMm, tension);
    const center: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    const half = path.widthMm / 2;
    for (let i = 0; i < curve.length; i++) {
      const [x, z] = curve[i];
      const y = height(x, z) ?? 0;
      const prev = i > 0 ? curve[i - 1] : curve[i];
      const next = i < curve.length - 1 ? curve[i + 1] : curve[i];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const L = Math.hypot(dx, dz) || 1;
      const tx = -dz / L; // horizontal normal (perpendicular to the tangent)
      const tz = dx / L;
      const ly = height(x + tx * half, z + tz * half) ?? y;
      const ry = height(x - tx * half, z - tz * half) ?? y;
      center.push(x, y, z);
      left.push(x + tx * half, ly, z + tz * half);
      right.push(x - tx * half, ry, z - tz * half);
    }
    ribbons.push({ center, left, right, roadClass: path.roadClass, widthMm: path.widthMm });
  }
  return ribbons;
}

/** Stable, canonical form of (nodes, edges, options) for content-addressing. */
export function canonicalRoads(nodes: RoadNode[], edges: RoadEdge[], opts?: RoadNetworkOptions): string {
  const nodesKey = nodes
    .map((n) => ({ id: n.id, x: n.x, z: n.z }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id === b.id ? 0 : 1));
  const edgesKey = edges
    .map((e) => ({ id: e.id, from: e.from, to: e.to, roadClass: e.roadClass, widthMm: e.widthMm, surface: e.surface }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const o = {
    samplesPerMm: opts?.samplesPerMm ?? DEFAULTS.samplesPerMm,
    tension: opts?.tension ?? DEFAULTS.tension,
    terrainVersion: opts?.terrainVersion ?? DEFAULTS.terrainVersion,
  };
  return JSON.stringify({ v: 1, nodes: nodesKey, edges: edgesKey, opts: o });
}

/**
 * sha256 of the canonical roads spec — the content-address key a baker/cacher
 * recomputes unchanged when the network is unchanged. Pass the repo's
 * `createHash("sha256").update(s).digest("hex")` as `hashHex`.
 */
export function roadNetworkHash(
  nodes: RoadNode[],
  edges: RoadEdge[],
  opts: RoadNetworkOptions,
  hashHex: (s: string) => string,
): string {
  return hashHex(canonicalRoads(nodes, edges, opts));
}
