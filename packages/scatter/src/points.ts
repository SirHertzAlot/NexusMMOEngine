/**
 * Point data model — the universal intermediate (UE PCG "points").
 *
 * Data-oriented SoA: one Float32Array per field, indexed by point.
 * A point = transform (position / euler rotation / scale) + density
 * (existence probability 0–1) + per-point seed + a dynamic attribute
 * table (named float columns, e.g. `biome`, `slope`, `moisture`).
 *
 * Points are transient: produced by samplers, threaded through
 * filters/modifiers, consumed by spawners. They are never persisted —
 * chunk point data is regenerable from (seed, cx, cz, plan). Only the
 * *cooked plan* is a versioned artifact.
 *
 * Canonical ordering: before any stochastic branch, points are sorted
 * by seed ascending (stable). This is the UE "normalize point ordering"
 * discipline, and it is what makes same-seed runs agree bit-for-bit.
 */

export interface PointList {
  count: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  /** Euler radians, authoring-friendly (yaw around Y). */
  yaw: Float32Array;
  pitch: Float32Array;
  roll: Float32Array;
  sx: Float32Array;
  sy: Float32Array;
  sz: Float32Array;
  /** Existence probability in [0, 1]. */
  density: Float32Array;
  /** Per-point u32 seed (stable identity for stochastic decisions). */
  seed: Uint32Array;
  /** Dynamic attributes: name -> float column of length `count`. */
  attrs: Map<string, Float32Array>;
}

/** Allocate a PointList with room for `capacity` points (count starts 0). */
export function createPointList(capacity: number): PointList {
  const f = (n: number) => new Float32Array(Math.max(0, n));
  return {
    count: 0,
    px: f(capacity),
    py: f(capacity),
    pz: f(capacity),
    yaw: f(capacity),
    pitch: f(capacity),
    roll: f(capacity),
    sx: f(capacity),
    sy: f(capacity),
    sz: f(capacity),
    density: f(capacity),
    seed: new Uint32Array(Math.max(0, capacity)),
    attrs: new Map(),
  };
}

/** Ensure every dynamic attribute column has room for `capacity` points. */
export function ensureAttrCapacity(pts: PointList, capacity: number): void {
  for (const [name, col] of pts.attrs) {
    if (col.length < capacity) {
      const grown = new Float32Array(capacity);
      grown.set(col.subarray(0, pts.count));
      pts.attrs.set(name, grown);
    }
  }
}

/** Append one point; grows nothing (caller sizes via createPointList). */
export function pushPoint(
  pts: PointList,
  p: {
    x: number;
    y: number;
    z: number;
    seed: number;
    density?: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
    sx?: number;
    sy?: number;
    sz?: number;
  },
): number {
  const i = pts.count++;
  pts.px[i] = p.x;
  pts.py[i] = p.y;
  pts.pz[i] = p.z;
  pts.yaw[i] = p.yaw ?? 0;
  pts.pitch[i] = p.pitch ?? 0;
  pts.roll[i] = p.roll ?? 0;
  pts.sx[i] = p.sx ?? 1;
  pts.sy[i] = p.sy ?? 1;
  pts.sz[i] = p.sz ?? 1;
  pts.density[i] = p.density ?? 1;
  pts.seed[i] = p.seed >>> 0;
  return i;
}

/**
 * Compact points in place, keeping indices where `keep[i]` is true.
 * Preserves relative order (stable).
 */
export function compactPoints(pts: PointList, keep: Uint8Array): void {
  let w = 0;
  const n = pts.count;
  for (let r = 0; r < n; r++) {
    if (!keep[r]) continue;
    if (w !== r) {
      pts.px[w] = pts.px[r];
      pts.py[w] = pts.py[r];
      pts.pz[w] = pts.pz[r];
      pts.yaw[w] = pts.yaw[r];
      pts.pitch[w] = pts.pitch[r];
      pts.roll[w] = pts.roll[r];
      pts.sx[w] = pts.sx[r];
      pts.sy[w] = pts.sy[r];
      pts.sz[w] = pts.sz[r];
      pts.density[w] = pts.density[r];
      pts.seed[w] = pts.seed[r];
      for (const col of pts.attrs.values()) col[w] = col[r];
    }
    w++;
  }
  pts.count = w;
}

/**
 * Sort points by seed ascending (stable insertion order on ties).
 * Canonical ordering — call before any stochastic branch.
 */
export function sortBySeedCanonical(pts: PointList): void {
  const n = pts.count;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const seeds = pts.seed;
  const idx = Array.from(order);
  idx.sort((a, b) => seeds[a] - seeds[b] || a - b);
  const copy = (src: Float32Array) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < n; i++) out[i] = src[idx[i]];
    return out;
  };
  pts.px = copy(pts.px);
  pts.py = copy(pts.py);
  pts.pz = copy(pts.pz);
  pts.yaw = copy(pts.yaw);
  pts.pitch = copy(pts.pitch);
  pts.roll = copy(pts.roll);
  pts.sx = copy(pts.sx);
  pts.sy = copy(pts.sy);
  pts.sz = copy(pts.sz);
  pts.density = copy(pts.density);
  const newSeeds = new Uint32Array(seeds.length);
  for (let i = 0; i < n; i++) newSeeds[i] = seeds[idx[i]];
  pts.seed = newSeeds;
  for (const [name, col] of pts.attrs) {
    const out = new Float32Array(col.length);
    for (let i = 0; i < n; i++) out[i] = col[idx[i]];
    pts.attrs.set(name, out);
  }
}

/** Get (or create, zero-filled) a dynamic attribute column. */
export function attrColumn(pts: PointList, name: string): Float32Array {
  let col = pts.attrs.get(name);
  if (!col) {
    col = new Float32Array(pts.px.length);
    pts.attrs.set(name, col);
  }
  return col;
}

/** Deep-compare two point lists (for golden tests). */
export function pointsEqual(a: PointList, b: PointList): boolean {
  if (a.count !== b.count) return false;
  const fa: Array<[Float32Array, Float32Array]> = [
    [a.px, b.px],
    [a.py, b.py],
    [a.pz, b.pz],
    [a.yaw, b.yaw],
    [a.pitch, b.pitch],
    [a.roll, b.roll],
    [a.sx, b.sx],
    [a.sy, b.sy],
    [a.sz, b.sz],
    [a.density, b.density],
  ];
  for (const [x, y] of fa) {
    for (let i = 0; i < a.count; i++) if (x[i] !== y[i]) return false;
  }
  for (let i = 0; i < a.count; i++) if (a.seed[i] !== b.seed[i]) return false;
  if (a.attrs.size !== b.attrs.size) return false;
  for (const [name, colA] of a.attrs) {
    const colB = b.attrs.get(name);
    if (!colB) return false;
    for (let i = 0; i < a.count; i++) if (colA[i] !== colB[i]) return false;
  }
  return true;
}
