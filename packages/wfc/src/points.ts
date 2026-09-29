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
}

const hasTag = (o: WfcOption, tag: string): boolean => o.tags?.includes(tag) ?? false;

/** Pairs of points within `r` of each other (a uniform-grid hash; each pair once). */
export function pairsWithin(points: readonly Point[], r: number): [number, number][] {
  const cell = Math.max(r, 1e-9);
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const buckets = new Map<string, number[]>();
  points.forEach((p, i) => {
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell), Math.floor((p.z ?? 0) / cell));
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  });
  const out: [number, number][] = [];
  const r2 = r * r;
  points.forEach((p, i) => {
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor((p.z ?? 0) / cell);
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of buckets.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            if (j <= i) continue;
            const q = points[j];
            const ex = q.x - p.x, ey = q.y - p.y, ez = (q.z ?? 0) - (p.z ?? 0);
            if (ex * ex + ey * ey + ez * ez <= r2) out.push([i, j]);
          }
        }
  });
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function pointsProblem(spec: PointsSpec): WfcProblem {
  const { points, options } = spec;
  const K = options.length;
  // One edge set per distinct distance, under its own rule.
  const distances = [...new Set([...(spec.avoid ?? []).map((a) => a.distance), ...(spec.needs ?? []).map((n) => n.distance)])].sort((a, b) => a - b);
  const ruleName = (d: number): string => `within:${d}`;
  const rules: Record<string, WfcRule> = {};
  const edges: { a: number; b: number; rule: string }[] = [];
  for (const d of distances) {
    const avoids = (spec.avoid ?? []).filter((a) => a.distance === d);
    rules[ruleName(d)] = (x, y) =>
      !avoids.some((a) => (hasTag(x, a.a) && hasTag(y, a.b)) || (hasTag(x, a.b) && hasTag(y, a.a)));
    for (const [a, b] of pairsWithin(points, d)) edges.push({ a, b, rule: ruleName(d) });
  }
  const tagged = (tag: string): number[] => options.flatMap((o, i) => (hasTag(o, tag) ? [i] : []));
  const needs: WfcNeed[] = [];
  for (const n of spec.needs ?? []) {
    const from = tagged(n.near);
    for (const option of tagged(n.tag)) needs.push({ option, from, count: n.count ?? 1, rule: ruleName(n.distance) });
  }
  const counts: WfcCount[] = (spec.counts ?? []).map((c) => ({ options: tagged(c.tag), min: c.min, max: c.max }));
  let weights: Float64Array | undefined;
  if (spec.weight) {
    weights = new Float64Array(points.length * K);
    for (let p = 0; p < points.length; p++) for (let o = 0; o < K; o++) weights[p * K + o] = spec.weight(p, o);
  }
  return { options, slots: points.length, edges, rules, needs, counts, weights };
}
