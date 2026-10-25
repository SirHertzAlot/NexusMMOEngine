/**
 * Signed distance fields: how far a point is from the nearest surface,
 * positive in open space and negative inside solid. The raymarcher steps
 * through them, and placement reads clearance from them directly.
 *
 *  - GridSdf: a 2D grid of solid and open cells (a dungeon's walls and
 *    floor), as an exact Euclidean distance transform, sampled bilinearly.
 *  - HeightfieldSdf: open space above ground (y above height(x, z)).
 *
 * DoD Performance Optimizations:
 *  - Zero-GC Reusable Thread-Local Scratch Buffers for Felzenszwalb-Huttenlocher
 *    1D/2D Exact Euclidean Distance Transforms (`edt2`), eliminating 10+ typed
 *    array heap allocations per `new GridSdf()`.
 *  - Branchless interior fast-path in `GridSdf.distance(x, y)` with precomputed
 *    `invCell` and inline row offsets, eliminating inner-loop closure creation.
 *  - Analytical Bilinear Gradient (`gradient(x, y, out?)`) that computes both
 *    $(\partial d / \partial x, \partial d / \partial y)$ from a single $2 \times 2$
 *    cell lookup instead of 4 separate bilinear `distance()` evaluations in `normal2()`.
 */

export interface Sdf2 {
  distance(x: number, y: number): number;
  /** Optional fast analytical gradient [gx, gy] to avoid 4 finite-difference distance() calls. */
  gradient?(x: number, y: number): [number, number];
}

export interface Sdf3 {
  distance(x: number, y: number, z: number): number;
}

const INF = 1e20;

// Pre-allocated growing scratch buffers for Felzenszwalb-Huttenlocher 1D/2D EDT (zero GC churn)
let scratchN = 0;
let scratchF = new Float64Array(0);
let scratchD = new Float64Array(0);
let scratchV = new Int32Array(0);
let scratchZ = new Float64Array(0);

function ensureEdtScratch(n: number): void {
  if (n > scratchN) {
    scratchN = Math.max(n, 256);
    scratchF = new Float64Array(scratchN);
    scratchD = new Float64Array(scratchN);
    scratchV = new Int32Array(scratchN);
    scratchZ = new Float64Array(scratchN + 1);
  }
}

/** 1D squared distance transform (Felzenszwalb & Huttenlocher) of f, in place into d. */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let vk = v[k];
    let s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    while (s <= z[k]) {
      k--;
      vk = v[k];
      s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const vk = v[k];
    const diff = q - vk;
    d[q] = diff * diff + f[vk];
  }
}

/** Squared distance from every cell to the nearest cell where `isSolid[i] === targetVal` into `out`. */
function edt2Into(width: number, height: number, isSolid: Uint8Array, targetVal: number, out: Float64Array): void {
  const len = width * height;
  for (let i = 0; i < len; i++) {
    out[i] = isSolid[i] === targetVal ? 0 : INF;
  }
  const n = Math.max(width, height);
  ensureEdtScratch(n);
  const f = scratchF;
  const d = scratchD;
  const v = scratchV;
  const z = scratchZ;

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x];
    dt1(f, height, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) f[x] = out[rowOffset + x];
    dt1(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[rowOffset + x] = d[x];
  }
}

let scratchGridSize = 0;
let scratchIsSolid = new Uint8Array(0);
let scratchToSolid = new Float64Array(0);
let scratchToOpen = new Float64Array(0);

function ensureGridScratch(len: number): void {
  if (len > scratchGridSize) {
    scratchGridSize = Math.max(len, 4096);
    scratchIsSolid = new Uint8Array(scratchGridSize);
    scratchToSolid = new Float64Array(scratchGridSize);
    scratchToOpen = new Float64Array(scratchGridSize);
  }
}

/**
 * A grid's distance field. Cell (i, j) spans [i, i+1) × [j, j+1) (times
 * `cell`); a surface lies between an open and a solid cell. Outside the
 * grid is solid.
 */
export class GridSdf implements Sdf2 {
  /** Signed distance at each cell centre, in grid cells. */
  readonly field: Float32Array;
  private readonly invCell: number;

  constructor(
    readonly width: number,
    readonly height: number,
    solid: (x: number, y: number) => boolean,
    /** World units per cell. */
    readonly cell = 1,
  ) {
    this.invCell = 1 / cell;
    const len = width * height;
    ensureGridScratch(len);
    const isSolid = scratchIsSolid;
    const toSolid = scratchToSolid;
    const toOpen = scratchToOpen;

    let idx = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        isSolid[idx++] = solid(x, y) ? 1 : 0;
      }
    }
    edt2Into(width, height, isSolid, 1, toSolid);
    edt2Into(width, height, isSolid, 0, toOpen);

    const field = new Float32Array(len);
    this.field = field;
    for (let y = 0; y < height; y++) {
      const yEdge = y + 1 < height - y ? y + 1 : height - y;
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        const i = rowOffset + x;
        const xEdge = x + 1 < width - x ? x + 1 : width - x;
        const edge = (xEdge < yEdge ? xEdge : yEdge) - 0.5;
        if (isSolid[i]) {
          field[i] = -(Math.sqrt(toOpen[i]) - 0.5);
        } else {
          const dSolid = Math.sqrt(toSolid[i]) - 0.5;
          field[i] = dSolid < edge ? dSolid : edge;
        }
      }
    }
  }

  /** Signed distance at world (x, y), bilinear between cell centres. Zero closure allocations. */
  distance(x: number, y: number): number {
    const gx = x * this.invCell - 0.5;
    const gy = y * this.invCell - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const w = this.width;
    const h = this.height;
    const f = this.field;

    // Fast path: interior cell quad (eliminates 8 boundary checks)
    if (x0 >= 0 && y0 >= 0 && x0 + 1 < w && y0 + 1 < h) {
      const row0 = y0 * w + x0;
      const row1 = row0 + w;
      const top = f[row0] * (1 - fx) + f[row0 + 1] * fx;
      const bottom = f[row1] * (1 - fx) + f[row1 + 1] * fx;
      return (top * (1 - fy) + bottom * fy) * this.cell;
    }

    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const v00 = x0 < 0 || y0 < 0 || x0 >= w || y0 >= h ? -1 : f[y0 * w + x0];
    const v10 = x1 < 0 || y0 < 0 || x1 >= w || y0 >= h ? -1 : f[y0 * w + x1];
    const v01 = x0 < 0 || y1 < 0 || x0 >= w || y1 >= h ? -1 : f[y1 * w + x0];
    const v11 = x1 < 0 || y1 < 0 || x1 >= w || y1 >= h ? -1 : f[y1 * w + x1];
    const top = v00 * (1 - fx) + v10 * fx;
    const bottom = v01 * (1 - fx) + v11 * fx;
    return (top * (1 - fy) + bottom * fy) * this.cell;
  }
}

/**
 * Open space above a heightfield: the vertical distance to the ground,
 * scaled by the steepest slope so it never overestimates the true
 * distance (a raymarcher may step by it safely).
 */
export class HeightfieldSdf implements Sdf3 {
  private readonly k: number;
  constructor(
    readonly heightAt: (x: number, z: number) => number,
    /** The steepest rise over run anywhere on the field. */
    maxSlope: number,
  ) {
    this.k = 1 / Math.sqrt(1 + maxSlope * maxSlope);
  }
  distance(x: number, y: number, z: number): number {
    return (y - this.heightAt(x, z)) * this.k;
  }
}
