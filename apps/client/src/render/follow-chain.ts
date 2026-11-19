/**
 * Follow-chains (roadmap CF4): secondary motion for hair, capes, tails,
 * tabards, charms. A chain is points: the first is the anchor (a bone), each
 * other point is pulled toward "one leash from the one before it" by a
 * spring-damper (F = -k x - c v) with gravity and wind, then held within the
 * leash. The recipe is data; the chain never touches the server.
 *
 * The cost risk is entity count, so the recipe carries its own `lod` block
 * and a global budget admits only the nearest chains:
 *   within `full`  all points;  within `mid`  `midPoints`;  beyond `far`  hidden.
 * Pure (no three.js): render/follow-chain-layer.ts draws it.
 */

export interface ChainRecipe {
  /** Points including the anchor. */
  points: number;
  /** Segment length, metres (the leash). */
  leash: number;
  /** Spring stiffness and damping toward the rest pose. */
  k: number;
  c: number;
  /** Downward acceleration, m/s^2, and a constant wind acceleration. */
  gravity: number;
  wind: [number, number, number];
  /** Ribbon width at the root and the tip, metres. */
  width: [number, number];
  color: string;
  lod: { full: number; mid: number; far: number; midPoints: number };
}

export const CHAIN_RECIPES: Record<string, ChainRecipe> = {
  hair: { points: 5, leash: 0.07, k: 120, c: 14, gravity: 6, wind: [0, 0, 0], width: [0.07, 0.02], color: "#3b2a20", lod: { full: 14, mid: 30, far: 50, midPoints: 3 } },
  cape: { points: 6, leash: 0.18, k: 60, c: 9, gravity: 5, wind: [0, 0, 0], width: [0.42, 0.55], color: "#7a1f2b", lod: { full: 16, mid: 34, far: 55, midPoints: 3 } },
  tail: { points: 6, leash: 0.14, k: 90, c: 10, gravity: 3, wind: [0, 0, 0], width: [0.09, 0.02], color: "#8a6a4a", lod: { full: 18, mid: 36, far: 60, midPoints: 4 } },
};

/** Points to simulate and draw at `dist` metres (0: hidden). */
export function lodPoints(r: ChainRecipe, dist: number): number {
  if (dist < r.lod.full) return r.points;
  if (dist < r.lod.mid) return Math.min(r.points, r.lod.midPoints);
  return 0;
}

export class Chain {
  readonly pos: Float64Array;
  readonly vel: Float64Array;
  constructor(readonly max: number) {
    this.pos = new Float64Array(max * 3);
    this.vel = new Float64Array(max * 3);
  }

  /** Lay the chain straight along `rest` from the anchor, at rest. */
  reset(r: ChainRecipe, a: ArrayLike<number>, rest: ArrayLike<number>): void {
    for (let i = 0; i < this.max; i++) {
      this.pos[i * 3] = a[0]! + rest[0]! * r.leash * i;
      this.pos[i * 3 + 1] = a[1]! + rest[1]! * r.leash * i;
      this.pos[i * 3 + 2] = a[2]! + rest[2]! * r.leash * i;
    }
    this.vel.fill(0);
  }
}

/**
 * Advance `n` points by `dt` seconds. `rest` is the unit direction the chain
 * hangs or trails along when nothing moves it. Substepped for stability.
 */
export function stepChain(ch: Chain, r: ChainRecipe, n: number, a: ArrayLike<number>, rest: ArrayLike<number>, dt: number): void {
  const sub = Math.min(4, Math.max(1, Math.ceil(dt * 90)));
  const h = Math.min(dt, 0.05) / sub;
  const p = ch.pos;
  const v = ch.vel;
  const l = r.leash;
  for (let s = 0; s < sub; s++) {
    p[0] = a[0]!;
    p[1] = a[1]!;
    p[2] = a[2]!;
    for (let i = 1; i < n; i++) {
      const j = i * 3;
      const q = j - 3;
      const tx = p[q]! + rest[0]! * l;
      const ty = p[q + 1]! + rest[1]! * l;
      const tz = p[q + 2]! + rest[2]! * l;
      v[j] = v[j]! + (-r.k * (p[j]! - tx) - r.c * v[j]! + r.wind[0]) * h;
      v[j + 1] = v[j + 1]! + (-r.k * (p[j + 1]! - ty) - r.c * v[j + 1]! + r.wind[1] - r.gravity) * h;
      v[j + 2] = v[j + 2]! + (-r.k * (p[j + 2]! - tz) - r.c * v[j + 2]! + r.wind[2]) * h;
      p[j] = p[j]! + v[j]! * h;
      p[j + 1] = p[j + 1]! + v[j + 1]! * h;
      p[j + 2] = p[j + 2]! + v[j + 2]! * h;
      // The leash: never farther than one segment from the point before.
      const dx = p[j]! - p[q]!;
      const dy = p[j + 1]! - p[q + 1]!;
      const dz = p[j + 2]! - p[q + 2]!;
      const d = Math.hypot(dx, dy, dz);
      if (d > l) {
        const k = l / d;
        p[j] = p[q]! + dx * k;
        p[j + 1] = p[q + 1]! + dy * k;
        p[j + 2] = p[q + 2]! + dz * k;
        // Drop the velocity that was carrying it outward.
        const out = (v[j]! * dx + v[j + 1]! * dy + v[j + 2]! * dz) / (d * d);
        if (out > 0) {
          v[j] = v[j]! - dx * out;
          v[j + 1] = v[j + 1]! - dy * out;
          v[j + 2] = v[j + 2]! - dz * out;
        }
      }
    }
  }
}

/**
 * A camera-facing ribbon along the first `n` points, tapering root to tip:
 * two vertices per point into `out` (6 floats per point). Returns the
 * vertex count.
 */
export function buildRibbon(out: Float32Array, ch: Chain, n: number, width: [number, number], cam: ArrayLike<number>): number {
  const p = ch.pos;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1) * 3;
    const b = Math.min(n - 1, i + 1) * 3;
    const tx = p[b]! - p[a]!;
    const ty = p[b + 1]! - p[a + 1]!;
    const tz = p[b + 2]! - p[a + 2]!;
    const j = i * 3;
    const vx = cam[0]! - p[j]!;
    const vy = cam[1]! - p[j + 1]!;
    const vz = cam[2]! - p[j + 2]!;
    // side = tangent x view
    let sx = ty * vz - tz * vy;
    let sy = tz * vx - tx * vz;
    let sz = tx * vy - ty * vx;
    const len = Math.hypot(sx, sy, sz) || 1;
    const w = (width[0] + (width[1] - width[0]) * (n > 1 ? i / (n - 1) : 0)) / 2 / len;
    sx *= w;
    sy *= w;
    sz *= w;
    const o = i * 6;
    out[o] = p[j]! - sx;
    out[o + 1] = p[j + 1]! - sy;
    out[o + 2] = p[j + 2]! - sz;
    out[o + 3] = p[j]! + sx;
    out[o + 4] = p[j + 1]! + sy;
    out[o + 5] = p[j + 2]! + sz;
  }
  return n * 2;
}

/** Triangle indices for a ribbon of up to `maxPoints` points. */
export function ribbonIndices(maxPoints: number): Uint16Array {
  const idx = new Uint16Array((maxPoints - 1) * 6);
  for (let i = 0; i < maxPoints - 1; i++) {
    const a = i * 2;
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  return idx;
}

/**
 * The global budget: chains offer their distance each frame and only the
 * nearest `maxActive` are admitted (the rest are treated as far: hidden).
 * Selection is a quickselect for the k-th nearest distance, O(n), not a sort.
 */
export class ChainBudget {
  private ids: number[] = [];
  private dist: number[] = [];
  private scratch = new Float64Array(256);
  /** Offers refused for the budget in the last admit(), for the perf overlay. */
  shed = 0;

  begin(): void {
    this.ids.length = 0;
    this.dist.length = 0;
  }

  offer(id: number, dist: number): void {
    this.ids.push(id);
    this.dist.push(dist);
  }

  /** Calls `take` for each of the `maxActive` nearest offers. */
  admit(maxActive: number, take: (id: number) => void): void {
    const n = this.ids.length;
    const keep = Math.min(n, maxActive);
    this.shed = n - keep;
    if (keep === n) {
      for (let i = 0; i < n; i++) take(this.ids[i]!);
      return;
    }
    if (keep <= 0) return;
    if (this.scratch.length < n) this.scratch = new Float64Array(n * 2);
    const a = this.scratch;
    for (let i = 0; i < n; i++) a[i] = this.dist[i]!;
    // Quickselect: afterwards a[keep - 1] is the keep-th smallest distance.
    let lo = 0;
    let hi = n - 1;
    const k = keep - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1]!;
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (a[i]! < pivot) i++;
        while (a[j]! > pivot) j--;
        if (i <= j) {
          const t = a[i]!;
          a[i] = a[j]!;
          a[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else break;
    }
    const thr = a[k]!;
    let taken = 0;
    for (let i = 0; i < n; i++) if (this.dist[i]! < thr) {
      take(this.ids[i]!);
      taken++;
    }
    // Ties at the threshold fill the rest.
    for (let i = 0; i < n && taken < keep; i++) if (this.dist[i] === thr) {
      take(this.ids[i]!);
      taken++;
    }
  }
}
