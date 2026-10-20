/**
 * Road vertical profile + terrain-conformant routing (SETTLEMENTS.md §28 / ROADMAP
 * SG2b, `feat/roads-grading`).
 *
 * A straight spline between two junctions will cut through a lake or carve a
 * mountainside. `routeEdge` walks a single edge with A* over a corridor-bounded
 * heightfield grid, blocking cells at/below the water level and steps steeper than
 * a cart grade, so the spine bends around a water body or ridge instead of
 * through it. `routeRoads` runs it for a whole junction graph. When no gradeable
 * route exists within the detour budget, it falls back to the straight spine so
 * the road still connects (a steep switchback is better than a cliff-cut).
 *
 * The grid is a window of the world survey: `heights` is a row-major Float32Array
 * of metres over `grid` (cell = metres/cell, origin). This mirrors the route
 * walker in `@mmo-engine/settlement`'s `planPlaces` (`walkRoute`): same 8-connected
 * A* with no cutting past a blocked cell, same slope-as-rise-over-run test, same
 * Douglas-Peucker simplify. The slope limit is a `maxGrade` (rise/run, default
 * 0.08 = ~4.6°) because a road must carry carts, not hikers; `planPlaces` uses
 * `walkSlopeDeg` (25°) for footpaths.
 *
 * Pure math, no three.js / no node:crypto. `splineRoads` (roads.ts) stays as the
 * smoothing/drape stage over whatever spine this produces.
 */

export interface Grid {
  /** Row-major heights in metres, [z * width + u]. */
  readonly heights: Float32Array;
  readonly width: number;
  readonly depth: number;
  /** metres per cell. */
  readonly cell: number;
  /** World metres of the grid's origin (grid cell 0,0). */
  readonly originX: number;
  readonly originZ: number;
}

export interface RouteOptions {
  /** Steepest rise/run a cart may climb (default 0.08 ≈ 4.6°). */
  maxGrade?: number;
  /** Sea level in metres; cells at/below this are water and blocked. */
  seaLevel?: number;
  /** Blocked terrain flags by source grid index (rivers, ice, etc.). */
  blocked?: (i: number) => boolean;
  /** Widest the search corridor may reach from the straight edge, in metres. */
  maxDetourM?: number;
  /** Simplify tolerance in metres. */
  simplifyTolM?: number;
  /** Coarsen the search grid by this many source cells (stride). */
  stride?: number;
}

const DEFAULTS: Required<RouteOptions> = {
  maxGrade: 0.08,
  seaLevel: 0,
  blocked: () => false,
  maxDetourM: 600,
  simplifyTolM: 4,
  stride: 4,
};

type Pt = [number, number];

const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** World (x,z) metres of the centre of coarsened-node (u,v). */
const nodeCenter = (u: number, v: number, origin: number, cell: number): Pt => {
  // nodeCenter is used for both x and z via the origin/cell of the coarsened grid
  return [origin + (u + 0.5) * cell, 0] as Pt; // placeholder, corrected below
};

// The above helper is too generic; use two explicit helpers instead.

/**
 * Build a coarsened search grid: stride source cells per node. Returns node
 * counts, the node-cell size, and a cost array where blocked cells are -1 and
 * others carry a base cost weighted by how close the local slope is to the
 * limit. This is the cart-grade analogue of the walk grid in `planPlaces`.
 */
interface Coarsened {
  WN: number;
  DN: number;
  cell: number; // metres per node = source cell * stride
  cost: Float32Array; // WN*DN, -1 blocked
}

function buildCoarse(g: Grid, opt: Required<RouteOptions>): Coarsened {
  const stride = opt.stride;
  const WN = Math.ceil(g.width / stride);
  const DN = Math.ceil(g.depth / stride);
  const cell = g.cell * stride;
  const tan = opt.maxGrade;
  const sea = opt.seaLevel;
  const isBlocked = opt.blocked;
  const gw = g.width;
  const cost = new Float32Array(WN * DN);
  for (let v = 0; v < DN; v++) {
    for (let u = 0; u < WN; u++) {
      const k = v * WN + u;
      const su = Math.min(gw - 1, u * stride + (stride >> 1));
      const sv = Math.min(g.depth - 1, v * stride + (stride >> 1));
      const gi = sv * gw + su;
      const h = g.heights[gi]!;
      let blocked = h <= sea || isBlocked(gi);
      let rise = 0;
      if (!blocked) {
        for (const [du, dv] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nu = su + du;
          const nv = sv + dv;
          if (nu < 0 || nv < 0 || nu >= gw || nv >= g.depth) continue;
          rise = Math.max(rise, Math.abs(g.heights[nv * gw + nu]! - h));
        }
        if (rise / g.cell > tan) blocked = true;
      }
      cost[k] = blocked ? -1 : 1 + (rise / cell) / 10;
    }
  }
  return { WN, DN, cell, cost };
}

/** (x,z) metres of coarsened-node (u,v). */
const nodeXZ = (u: number, v: number, ox: number, oz: number, cell: number): Pt => [
  ox + (u + 0.5) * cell,
  oz + (v + 0.5) * cell,
];

/** Coarsened-node index of world (x,z), clamped to the node grid. */
const nodeOf = (x: number, z: number, c: Coarsened, g: Grid): number => {
  const u = Math.max(0, Math.min(c.WN - 1, Math.floor((x - g.originX) / c.cell)));
  const v = Math.max(0, Math.min(c.DN - 1, Math.floor((z - g.originZ) / c.cell)));
  return v * c.WN + u;
};

/**
 * A binary min-heap of [priority, value]. Mirrors the one in `planPlaces`.
 */
class Heap {
  private readonly a: Array<[number, number]> = [];
  get size(): number {
    return this.a.length;
  }
  push(p: number, v: number): void {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (a[up]![0] <= a[i]![0]) break;
      [a[up], a[i]] = [a[i]!, a[up]!];
      i = up;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** Douglas-Peucker: drop points within `tol` metres of the line between neighbours. */
function simplify(p: Pt[], tol: number): Pt[] {
  if (p.length < 3) return p;
  const len = dist(p[0]!, p[p.length - 1]!);
  if (len === 0) return [p[0]!, p[p.length - 1]!];
  let far = 0;
  let at = -1;
  const [ax, az] = p[0]!;
  const [bx, bz] = p[p.length - 1]!;
  for (let i = 1; i < p.length - 1; i++) {
    const [px, pz] = p[i]!;
    const d = Math.abs((bx - ax) * (az - pz) - (ax - px) * (bz - az)) / len;
    if (d > far) (far = d), (at = i);
  }
  if (far <= tol) return [p[0]!, p[p.length - 1]!];
  return [...simplify(p.slice(0, at + 1), tol).slice(0, -1), ...simplify(p.slice(at), tol)];
}

/** Nearest walkable node within `r` steps of `n` (8-connected ring-out). */
function nearestWalkable(n: number, cost: Float32Array, WN: number, DN: number, r: number): number {
  const ci = n % WN;
  const cj = Math.floor(n / WN);
  for (let rr = 1; rr < r; rr++) {
    for (let dj = -rr; dj <= rr; dj++) {
      for (let di = -rr; di <= rr; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i >= 0 && j >= 0 && i < WN && j < DN && cost[j * WN + i] >= 0) return j * WN + i;
      }
    }
  }
  return -1;
}

/**
 * A* over the coarsened cost grid, 8-connected with no corner-cutting. Returns
 * the spine as world-metre points, or null if the goal is unreachable.
 */
function aStar(start: number, goal: number, c: Coarsened, g: Grid, goalPt: Pt): Pt[] | null {
  const best = new Float32Array(c.WN * c.DN).fill(Infinity);
  const from = new Int32Array(c.WN * c.DN).fill(-1);
  const heap = new Heap();
  best[start] = 0;
  heap.push(0, start);
  const cap = c.WN * c.DN * 2;
  let popped = 0;
  while (heap.size) {
    const top = heap.pop();
    if (!top) break;
    const [, n] = top;
    if (++popped > cap) break;
    if (n === goal) break;
    const ni = n % c.WN;
    const nj = Math.floor(n / c.WN);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i = ni + di;
        const j = nj + dj;
        if (i < 0 || j < 0 || i >= c.WN || j >= c.DN) continue;
        const m = j * c.WN + i;
        if (c.cost[m] < 0) continue;
        // No cutting a corner past a blocked cell.
        if (di && dj && (c.cost[nj * c.WN + i] < 0 || c.cost[j * c.WN + ni] < 0)) continue;
        const step = (di && dj ? Math.SQRT2 : 1) * c.cell * (c.cost[m] + c.cost[n]) * 0.5;
        const next = best[n] + step;
        if (next < best[m]) {
          best[m] = next;
          from[m] = n;
          const [gx, gz] = nodeXZ(i, j, g.originX, g.originZ, c.cell);
          heap.push(next + dist([gx, gz], goalPt), m);
        }
      }
    }
  }
  if (!Number.isFinite(best[goal])) return null;
  const line: Pt[] = [];
  for (let n = goal; n !== -1; n = from[n]) {
    const u = n % c.WN;
    const v = Math.floor(n / c.WN);
    line.push(nodeXZ(u, v, g.originX, g.originZ, c.cell));
  }
  line.reverse();
  return line;
}

/** Pin the first/last spine point to the real junction coords and simplify. */
function stitch(a: Pt, spine: Pt[] | null, b: Pt, tol: number): Pt[] {
  if (!spine || spine.length === 0) return [a, b];
  if (spine.length === 1) return simplify([a, spine[0]!, b], tol);
  spine[0] = a;
  spine[spine.length - 1] = b;
  return simplify(spine, tol);
}

/**
 * Walk a single edge from `a` to `b` over the heightfield. Blocks water / sea /
 * steep cells, stays within `maxDetourM` of the straight line, and returns a
 * simplified corridor line. Falls back to the straight spine when no gradeable
 * route exists within the detour budget (so the road still connects).
 */
export function routeEdge(g: Grid, a: Pt, b: Pt, opts?: RouteOptions): Pt[] {
  const opt = { ...DEFAULTS, ...opts };
  const c = buildCoarse(g, opt);
  // Bounding the corridor: only search nodes whose world position is within
  // maxDetourM of the straight edge a->b. This keeps an A* pass O(corridor)
  // on a 16-32 km world instead of O(grid).
  const maxDetourSq = opt.maxDetourM * opt.maxDetourM;
  const inCorridor = (x: number, z: number): boolean => {
    // distance from point to segment a-b
    const [ax, az] = a;
    const [bx, bz] = b;
    const lenSq = dist(a, b) ** 2;
    if (lenSq === 0) return dist([x, z], a) <= opt.maxDetourM;
    let t = ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * (bx - ax);
    const cz = az + t * (bz - az);
    return (x - cx) ** 2 + (z - cz) ** 2 <= maxDetourSq;
  };

  // Block corridor-exceeding nodes in place so aStar never leaves the corridor.
  for (let k = 0; k < c.cost.length; k++) {
    if (c.cost[k] >= 0) {
      const u = k % c.WN;
      const v = Math.floor(k / c.WN);
      const [x, z] = nodeXZ(u, v, g.originX, g.originZ, c.cell);
      if (!inCorridor(x, z)) c.cost[k] = -1;
    }
  }

  const startNode = nodeOf(a[0], a[1], c, g);
  const goalNode = nodeOf(b[0], b[1], c, g);
  if (c.cost[startNode] < 0) {
    const near = nearestWalkable(startNode, c.cost, c.WN, c.DN, 12);
    if (near < 0) return [a, b];
    return stitch(a, aStar(near, goalNode, c, g, b), b, opt.simplifyTolM);
  }
  if (c.cost[goalNode] < 0) {
    const near = nearestWalkable(goalNode, c.cost, c.WN, c.DN, 12);
    if (near < 0) return [a, b];
    return stitch(a, aStar(startNode, near, c, g, b), b, opt.simplifyTolM);
  }
  return stitch(a, aStar(startNode, goalNode, c, g, b), b, opt.simplifyTolM);
}

/**
 * Route every edge of a road graph over the heightfield.
 * Each returned spine is already pinned to its two junction coordinates, so the
 * result can be draped directly by `splineRoads` (see roads.ts §CATMULLROM).
 */
export function routeRoads(
  graph: { nodes: Array<{ id: string; x: number; z: number }>; edges: Array<{ from: string; to: string }> },
  g: Grid,
  opts?: RouteOptions,
): Array<{ from: string; to: string; points: Pt[] }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const out: Array<{ from: string; to: string; points: Pt[] }> = [];
  for (const e of graph.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    out.push({ from: e.from, to: e.to, points: routeEdge(g, [a.x, a.z], [b.x, b.z], opts) });
  }
  return out;
}
