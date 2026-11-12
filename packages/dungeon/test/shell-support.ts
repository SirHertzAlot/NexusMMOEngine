/** Shared helpers for the shell tests: heights of a part's triangles above a point, and the triangles' vertical ranges. */

import type { DungeonShell } from "../src/index.js";

/** Distinct heights of the shell's triangles of `part` straight above or below (x, z) (a point on a shared edge hits both triangles). */
export function heightsAt(s: DungeonShell, part: number, x: number, z: number): number[] {
  const p = s.positions, idx = s.indices;
  const out: number[] = [];
  for (let t = 0; t < s.parts.length; t++) {
    if (s.parts[t] !== part) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    // Barycentric in x-z.
    const d = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / d;
    const l2 = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const h = Math.round((l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1]) * 1e6) / 1e6;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** The vertical range [lowest, highest] of every triangle of `part`. */
export function yRanges(s: DungeonShell, part: number): Array<[number, number]> {
  const p = s.positions, idx = s.indices;
  const out: Array<[number, number]> = [];
  for (let t = 0; t < s.parts.length; t++) {
    if (s.parts[t] !== part) continue;
    const ys = [p[idx[t * 3] * 3 + 1], p[idx[t * 3 + 1] * 3 + 1], p[idx[t * 3 + 2] * 3 + 1]];
    out.push([Math.min(...ys), Math.max(...ys)]);
  }
  return out;
}
