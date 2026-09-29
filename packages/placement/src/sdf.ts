/**
 * Signed distance fields: how far a point is from the nearest surface,
 * positive in open space and negative inside solid. The raymarcher steps
 * through them, and placement reads clearance from them directly.
 *
 *  - GridSdf: a 2D grid of solid and open cells (a dungeon's walls and
 *    floor), as an exact Euclidean distance transform, sampled bilinearly.
 *  - HeightfieldSdf: open space above ground (y above height(x, z)).
 */

export interface Sdf2 {
  distance(x: number, y: number): number;
}

export interface Sdf3 {
  distance(x: number, y: number, z: number): number;
}

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb & Huttenlocher) of f, in place into d. */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared distance from every cell to the nearest cell where `target` is set. */
function edt2(width: number, height: number, target: (i: number) => boolean): Float64Array {
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = target(i) ? 0 : INF;
  const n = Math.max(width, height);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x];
    dt1(f, height, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = out[y * width + x];
    dt1(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[y * width + x] = d[x];
  }
  return out;
}

/**
 * A grid's distance field. Cell (i, j) spans [i, i+1) × [j, j+1) (times
 * `cell`); a surface lies between an open and a solid cell. Outside the
 * grid is solid.
 */
export class GridSdf implements Sdf2 {
  /** Signed distance at each cell centre, in grid cells. */
  readonly field: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    solid: (x: number, y: number) => boolean,
    /** World units per cell. */
    readonly cell = 1,
  ) {
    const isSolid = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) isSolid[y * width + x] = solid(x, y) ? 1 : 0;
    const toSolid = edt2(width, height, (i) => isSolid[i] === 1);
    const toOpen = edt2(width, height, (i) => isSolid[i] === 0);
    this.field = new Float32Array(width * height);
    for (let i = 0; i < this.field.length; i++) {
      // The surface is half a cell from a cell centre; the grid's own edge is solid.
      const x = i % width, y = (i / width) | 0;
      const edge = Math.min(x + 1, y + 1, width - x, height - y) - 0.5;
      this.field[i] = isSolid[i] ? -(Math.sqrt(toOpen[i]) - 0.5) : Math.min(Math.sqrt(toSolid[i]) - 0.5, edge);
    }
  }

  /** Signed distance at world (x, y), bilinear between cell centres. */
  distance(x: number, y: number): number {
    const gx = x / this.cell - 0.5, gy = y / this.cell - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const at = (i: number, j: number): number =>
      i < 0 || j < 0 || i >= this.width || j >= this.height ? -1 : this.field[j * this.width + i];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
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
