/**
 * Points: scatter candidates are the slots, linked to every other point
 * within reach. WFC then decides what each point becomes given what's
 * around it, where scatter alone only decides where things may go:
 *
 *   - `avoid`: two kinds that mustn't be within a distance (no two camp
 *     fires within 20 m, no shrine by a gallows);
 *   - `needs`: a kind that needs some of another kind within a distance
 *     (tents need a fire within 8 m, a vein needs a vein beside it: they
 *     cluster);
 *   - `counts`: how many of a kind overall (one shrine per clearing);
 *   - `weight(point, option)`: how well an option suits a point (the
 *     biome, the slope, the depth), multiplying the option's weight;
 *   - an option with the tag "empty" (or any option) may be allowed so a
 *     point can stay unused.
 *
 * Kinds are option tags: a rule on "fire" applies to every option tagged
 * "fire".
 */

import type { WfcCount, WfcNeed, WfcOption, WfcProblem, WfcRule } from "./solver.js";

export interface Point {
  x: number;
  y: number;
  z?: number;
}

export interface PointsSpec {
  points: readonly Point[];
  options: readonly WfcOption[];
  /** No `a` within `distance` of a `b` (and vice versa). */
  avoid?: readonly { a: string; b: string; distance: number }[];
  /** Every `tag` needs at least `count` (default 1) `near` within `distance`. */
  needs?: readonly { tag: string; near: string; distance: number; count?: number }[];
  counts?: readonly { tag: string; min?: number; max?: number }[];
  /** Suitability of option `o` at point `p` (default 1; 0 forbids it there). */
  weight?: (p: number, o: number) => number;
  /**
   * Points already decided elsewhere (a neighbouring tile's border), as
   * point → option: fixed context whose own needs aren't rechecked and
   * which don't count toward `counts`.
   */
  settled?: ReadonlyMap<number, number>;
}

const hasTag = (o: WfcOption, tag: string): boolean => o.tags?.includes(tag) ?? false;

/** Pairs of points within `r` of each other, as arrays (i < j, sorted), with squared distances. */
export function pairArraysWithin(points: readonly Point[], r: number): { a: Int32Array; b: Int32Array; d2: Float64Array } {
  const n = points.length;
  const cell = Math.max(r, 1e-9);
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    xs[i] = p.x; ys[i] = p.y; zs[i] = p.z ?? 0;
    minX = Math.min(minX, xs[i]); minY = Math.min(minY, ys[i]); minZ = Math.min(minZ, zs[i]);
    maxX = Math.max(maxX, xs[i]); maxY = Math.max(maxY, ys[i]); maxZ = Math.max(maxZ, zs[i]);
  }
  const empty = { a: new Int32Array(0), b: new Int32Array(0), d2: new Float64Array(0) };
  if (n < 2) return empty;
  // A grid of r-sized cells, points bucketed into it (counting sort, ascending index per cell).
  const gx = Math.floor((maxX - minX) / cell) + 1, gy = Math.floor((maxY - minY) / cell) + 1, gz = Math.floor((maxZ - minZ) / cell) + 1;
  const cellOf = new Int32Array(n);
  const cx = new Int32Array(n), cy = new Int32Array(n), cz = new Int32Array(n);
  const start = new Int32Array(gx * gy * gz + 1);
  for (let i = 0; i < n; i++) {
    cx[i] = Math.floor((xs[i] - minX) / cell); cy[i] = Math.floor((ys[i] - minY) / cell); cz[i] = Math.floor((zs[i] - minZ) / cell);
    cellOf[i] = (cz[i] * gy + cy[i]) * gx + cx[i];
    start[cellOf[i] + 1]++;
  }
  for (let c = 0; c < gx * gy * gz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, gx * gy * gz);
  const members = new Int32Array(n);
  for (let i = 0; i < n; i++) members[fill[cellOf[i]]++] = i;

  let cap = 1024, len = 0;
  let a = new Int32Array(cap), b = new Int32Array(cap), d2 = new Float64Array(cap);
  const r2 = r * r;
  const found: number[] = [];
  for (let i = 0; i < n; i++) {
    found.length = 0;
    for (let z = Math.max(0, cz[i] - 1); z <= Math.min(gz - 1, cz[i] + 1); z++)
      for (let y = Math.max(0, cy[i] - 1); y <= Math.min(gy - 1, cy[i] + 1); y++)
        for (let x = Math.max(0, cx[i] - 1); x <= Math.min(gx - 1, cx[i] + 1); x++) {
          const c = (z * gy + y) * gx + x;
          for (let m = start[c]; m < start[c + 1]; m++) {
            const j = members[m];
            if (j <= i) continue;
            const ex = xs[j] - xs[i], ey = ys[j] - ys[i], ez = zs[j] - zs[i];
            if (ex * ex + ey * ey + ez * ez <= r2) found.push(j);
          }
        }
    found.sort((p, q) => p - q);
    for (const j of found) {
      if (len === cap) {
        cap *= 2;
        const a2 = new Int32Array(cap), b2 = new Int32Array(cap), d22 = new Float64Array(cap);
        a2.set(a); b2.set(b); d22.set(d2);
        a = a2; b = b2; d2 = d22;
      }
      const ex = xs[j] - xs[i], ey = ys[j] - ys[i], ez = zs[j] - zs[i];
      a[len] = i; b[len] = j; d2[len] = ex * ex + ey * ey + ez * ez; len++;
    }
  }
  return { a: a.subarray(0, len), b: b.subarray(0, len), d2: d2.subarray(0, len) };
}

/** Pairs of points within `r` of each other (each pair once, sorted). */
export function pairsWithin(points: readonly Point[], r: number): [number, number][] {
  const { a, b } = pairArraysWithin(points, r);
  return Array.from(a, (i, k) => [i, b[k]] as [number, number]);
}

export function pointsProblem(spec: PointsSpec): WfcProblem {
  const { points, options } = spec;
  const K = options.length;
  const tagged = (tag: string): number[] => options.flatMap((o, i) => (hasTag(o, tag) ? [i] : []));

  // Needs read neighbours through edges: one per pair within the longest
  // need distance, under the rule of its distance band (band k: farther
  // than need distance k-1, no farther than distance k).
  const distances = [...new Set((spec.needs ?? []).map((n) => n.distance))].sort((a, b) => a - b);
  const band = (k: number): string => `band:${distances[k]}`;
  const rules: Record<string, WfcRule> = {};
  distances.forEach((_, k) => (rules[band(k)] = () => true));
  const none = new Int32Array(0);
  const pairs = distances.length > 0 ? pairArraysWithin(points, distances[distances.length - 1]) : { a: none, b: none, d2: new Float64Array(0) };
  const rule = new Int32Array(pairs.a.length);
  const limits = distances.map((d) => d * d);
  for (let i = 0; i < rule.length; i++) {
    let k = 0;
    while (k < limits.length - 1 && pairs.d2[i] > limits[k]) k++;
    rule[i] = k;
  }
  // Rules are band 0, 1, … in insertion order: an edge's rule index is its band.
  const edges = { a: pairs.a, b: pairs.b, rule };
  const needs: WfcNeed[] = [];
  for (const n of spec.needs ?? []) {
    const from = tagged(n.near);
    const within = distances.flatMap((d, k) => (d <= n.distance ? [band(k)] : []));
    for (const option of tagged(n.tag)) needs.push({ option, from, count: n.count ?? 1, rule: within });
  }

  // Avoids are a propagator on a spatial grid, not edges: when a point is
  // decided, what it forbids is removed from the points within reach.
  const avoidsOf: { distance2: number; forbid: number[] }[][] = Array.from({ length: K }, () => []);
  for (const a of spec.avoid ?? []) {
    const A = tagged(a.a), B = tagged(a.b);
    for (const x of A) avoidsOf[x].push({ distance2: a.distance * a.distance, forbid: B });
    for (const x of B) avoidsOf[x].push({ distance2: a.distance * a.distance, forbid: A });
  }
  const reach = Math.max(0, ...(spec.avoid ?? []).map((a) => a.distance));
  const grid = reach > 0 ? spatialGrid(points, reach) : null;
  const onDecided = grid
    ? (slot: number, option: number): number[] | null => {
        const rulesHere = avoidsOf[option];
        if (rulesHere.length === 0) return null;
        const out: number[] = [];
        const p = points[slot];
        grid.near(slot, (t) => {
          const q = points[t];
          const ex = q.x - p.x, ey = q.y - p.y, ez = (q.z ?? 0) - (p.z ?? 0);
          const dd = ex * ex + ey * ey + ez * ez;
          for (const r of rulesHere) if (dd <= r.distance2) for (const y of r.forbid) out.push(t, y);
        });
        return out;
      }
    : undefined;

  const own = spec.settled ? points.flatMap((_, i) => (spec.settled?.has(i) ? [] : [i])) : undefined;
  const counts: WfcCount[] = (spec.counts ?? []).map((c) => ({ options: tagged(c.tag), min: c.min, max: c.max, slots: own }));
  let weights: Float64Array | undefined;
  if (spec.weight) {
    weights = new Float64Array(points.length * K);
    for (let p = 0; p < points.length; p++) for (let o = 0; o < K; o++) weights[p * K + o] = spec.weight(p, o);
  }
  const settled = spec.settled ? [...spec.settled.keys()] : undefined;
  return { options, slots: points.length, edges, rules, needs, counts, weights, pins: spec.settled, settled, onDecided };
}

/** Points bucketed into cells of side `r`: `near(i, f)` visits every other point in i's and the neighbouring cells. */
function spatialGrid(points: readonly Point[], r: number): { near(i: number, f: (j: number) => void): void } {
  const n = points.length;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); minZ = Math.min(minZ, p.z ?? 0);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxZ = Math.max(maxZ, p.z ?? 0);
  }
  const gx = Math.floor((maxX - minX) / r) + 1, gy = Math.floor((maxY - minY) / r) + 1, gz = Math.floor((maxZ - minZ) / r) + 1;
  const cx = new Int32Array(n), cy = new Int32Array(n), cz = new Int32Array(n);
  const start = new Int32Array(gx * gy * gz + 1);
  const cell = new Int32Array(n);
  points.forEach((p, i) => {
    cx[i] = Math.floor((p.x - minX) / r); cy[i] = Math.floor((p.y - minY) / r); cz[i] = Math.floor(((p.z ?? 0) - minZ) / r);
    cell[i] = (cz[i] * gy + cy[i]) * gx + cx[i];
    start[cell[i] + 1]++;
  });
  for (let c = 0; c < gx * gy * gz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, gx * gy * gz);
  const members = new Int32Array(n);
  for (let i = 0; i < n; i++) members[fill[cell[i]]++] = i;
  return {
    near(i, f) {
      for (let z = Math.max(0, cz[i] - 1); z <= Math.min(gz - 1, cz[i] + 1); z++)
        for (let y = Math.max(0, cy[i] - 1); y <= Math.min(gy - 1, cy[i] + 1); y++)
          for (let x = Math.max(0, cx[i] - 1); x <= Math.min(gx - 1, cx[i] + 1); x++) {
            const c = (z * gy + y) * gx + x;
            for (let m = start[c]; m < start[c + 1]; m++) if (members[m] !== i) f(members[m]);
          }
    },
  };
}
