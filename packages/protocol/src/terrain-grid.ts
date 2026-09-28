/**
 * The world heightmap and its chunk tiles.
 *
 * The world has ONE heightmap: a global grid of samples at integer
 * coordinates (gx, gz). Chunk (cx, cz) is a 16x16 window into it covering
 * gx = cx*15 .. cx*15+15 (same for z), so neighbouring chunks share their
 * border row/column — each shared sample exists once in the grid, and
 * tiles cut from it always meet exactly. Sample (gx, gz) sits at world
 * position (gx, gz) * chunkWorldSize / 15, matching the mirror's terrain
 * mesh, server grounding, scatter, and navmesh (sample i of a chunk at
 * local i * 16/15).
 *
 * Browser- and Node-safe, no dependencies: the editor edits the grid and
 * cuts tiles from it; the server validates and stores those tiles.
 */

/** Samples per tile side. */
export const TILE_SAMPLES = 16;
/** Cells per tile side (the last row/column is shared with the neighbour). */
export const TILE_CELLS = TILE_SAMPLES - 1;

/** One chunk's heights, row-major with X as the inner loop: heights[j*16 + i]. */
export interface TerrainTile {
  cx: number;
  cz: number;
  heights: Float32Array;
}

export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

export class HeightGrid {
  /** Samples not covered by any tile are NaN (see has()). */
  readonly heights: Float32Array;
  private readonly chunks = new Set<string>();
  /** See pinBorders(). */
  private pinned = false;

  private constructor(
    readonly minGX: number,
    readonly minGZ: number,
    readonly width: number,
    readonly depth: number,
  ) {
    this.heights = new Float32Array(width * depth).fill(Number.NaN);
  }

  /**
   * Assemble the grid from tiles. Throws when a tile is malformed or when
   * two tiles disagree on a shared border sample — tiles cut from one
   * heightmap never do, so a mismatch means corrupt or hand-assembled data.
   */
  static fromTiles(tiles: readonly TerrainTile[]): HeightGrid {
    if (tiles.length === 0) throw new Error("terrain: no tiles");
    let minCX = Infinity, minCZ = Infinity, maxCX = -Infinity, maxCZ = -Infinity;
    for (const t of tiles) {
      validateTile(t);
      minCX = Math.min(minCX, t.cx); maxCX = Math.max(maxCX, t.cx);
      minCZ = Math.min(minCZ, t.cz); maxCZ = Math.max(maxCZ, t.cz);
    }
    const grid = new HeightGrid(
      minCX * TILE_CELLS,
      minCZ * TILE_CELLS,
      (maxCX - minCX) * TILE_CELLS + TILE_SAMPLES,
      (maxCZ - minCZ) * TILE_CELLS + TILE_SAMPLES,
    );
    for (const t of tiles) {
      const key = chunkKey(t.cx, t.cz);
      if (grid.chunks.has(key)) throw new Error(`terrain: duplicate tile ${key}`);
      grid.chunks.add(key);
      for (let j = 0; j < TILE_SAMPLES; j++) {
        for (let i = 0; i < TILE_SAMPLES; i++) {
          const gx = t.cx * TILE_CELLS + i;
          const gz = t.cz * TILE_CELLS + j;
          const v = t.heights[j * TILE_SAMPLES + i];
          const k = grid.index(gx, gz);
          const prev = grid.heights[k];
          if (!Number.isNaN(prev) && prev !== v) {
            throw new Error(
              `terrain: tiles disagree on shared sample (${gx},${gz}) of chunk ${key}: ${prev} vs ${v}`,
            );
          }
          grid.heights[k] = v;
        }
      }
    }
    return grid;
  }

  private index(gx: number, gz: number): number {
    return (gz - this.minGZ) * this.width + (gx - this.minGX);
  }

  /** True when (gx, gz) is inside a tile of this grid. */
  has(gx: number, gz: number): boolean {
    return (
      gx >= this.minGX && gz >= this.minGZ &&
      gx < this.minGX + this.width && gz < this.minGZ + this.depth &&
      !Number.isNaN(this.heights[this.index(gx, gz)])
    );
  }

  get(gx: number, gz: number): number {
    return this.has(gx, gz) ? this.heights[this.index(gx, gz)] : Number.NaN;
  }

  set(gx: number, gz: number, v: number): void {
    if (!this.has(gx, gz)) return;
    this.heights[this.index(gx, gz)] = v;
  }

  /** Chunks covered by this grid, as [cx, cz] pairs. */
  chunkCoords(): Array<[number, number]> {
    return [...this.chunks].map((k) => k.split(",").map(Number) as [number, number]);
  }

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** Cut one chunk's tile out of the grid. */
  tile(cx: number, cz: number): TerrainTile {
    if (!this.hasChunk(cx, cz)) throw new Error(`terrain: no chunk ${chunkKey(cx, cz)}`);
    const heights = new Float32Array(TILE_SAMPLES * TILE_SAMPLES);
    for (let j = 0; j < TILE_SAMPLES; j++) {
      for (let i = 0; i < TILE_SAMPLES; i++) {
        heights[j * TILE_SAMPLES + i] = this.get(cx * TILE_CELLS + i, cz * TILE_CELLS + j);
      }
    }
    return { cx, cz, heights };
  }

  /** Every chunk of this grid that contains sample (gx, gz) — up to 4 on shared corners. */
  chunksAt(gx: number, gz: number): Array<[number, number]> {
    return chunksContaining(gx, gz).filter(([cx, cz]) => this.hasChunk(cx, cz));
  }

  /**
   * Freeze the samples this grid shares with chunks it doesn't hold. For
   * an area cut out of a larger stored world: those samples also belong to
   * tiles the editor never loaded, so changing them would open a seam (the
   * save rejects it). Brushes leave pinned samples alone.
   */
  pinBorders(): void {
    this.pinned = true;
  }

  isPinned(gx: number, gz: number): boolean {
    return this.pinned && chunksContaining(gx, gz).some(([cx, cz]) => !this.hasChunk(cx, cz));
  }
}

/** Every chunk (loaded or not) containing sample (gx, gz): 1, 2, or 4 on shared corners. */
function chunksContaining(gx: number, gz: number): Array<[number, number]> {
  const xs = [Math.floor(gx / TILE_CELLS)];
  if (gx % TILE_CELLS === 0) xs.push(gx / TILE_CELLS - 1);
  const zs = [Math.floor(gz / TILE_CELLS)];
  if (gz % TILE_CELLS === 0) zs.push(gz / TILE_CELLS - 1);
  const out: Array<[number, number]> = [];
  for (const cx of xs) for (const cz of zs) out.push([cx, cz]);
  return out;
}

function validateTile(t: TerrainTile): void {
  if (!Number.isInteger(t.cx) || !Number.isInteger(t.cz)) {
    throw new Error(`terrain: tile coords must be integers (got ${t.cx},${t.cz})`);
  }
  if (t.heights.length !== TILE_SAMPLES * TILE_SAMPLES) {
    throw new Error(`terrain: tile ${chunkKey(t.cx, t.cz)} has ${t.heights.length} samples, want 256`);
  }
  for (const v of t.heights) {
    if (!Number.isFinite(v)) throw new Error(`terrain: tile ${chunkKey(t.cx, t.cz)} has a non-finite height`);
  }
}

// ------------------------------------------------------------------ brushes

export type BrushTool = "raise" | "lower" | "smooth" | "flatten";

export interface BrushStroke {
  tool: BrushTool;
  /** Brush centre in world units. */
  x: number;
  z: number;
  /** Radius in world units. */
  radius: number;
  /**
   * raise/lower: height change at the centre, world units per application.
   * smooth/flatten: blend toward the target at the centre, 0..1.
   */
  strength: number;
  /** flatten only: the height to flatten toward. */
  target?: number;
  /** Chunk edge length in world units (default 16). */
  chunkWorldSize?: number;
}

/**
 * Apply one brush dab to the grid in world space. Returns the chunks it
 * changed (as "cx,cz" keys) — the ones to save. Because edits happen on the
 * global grid, a dab across a chunk border moves both tiles identically.
 */
export function applyBrush(grid: HeightGrid, stroke: BrushStroke): Set<string> {
  const touched = new Set<string>();
  const size = stroke.chunkWorldSize ?? 16;
  const toGrid = TILE_CELLS / size;
  const r = Math.max(0, stroke.radius);
  if (r === 0 || stroke.strength === 0) return touched;
  const gx0 = Math.floor((stroke.x - r) * toGrid);
  const gx1 = Math.ceil((stroke.x + r) * toGrid);
  const gz0 = Math.floor((stroke.z - r) * toGrid);
  const gz1 = Math.ceil((stroke.z + r) * toGrid);

  // Smooth reads the pre-dab neighbourhood so the result doesn't depend on
  // iteration order.
  const updates: Array<[number, number, number]> = [];
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      if (!grid.has(gx, gz) || grid.isPinned(gx, gz)) continue;
      const d = Math.hypot(gx / toGrid - stroke.x, gz / toGrid - stroke.z);
      if (d >= r) continue;
      const falloff = 0.5 * (1 + Math.cos((Math.PI * d) / r));
      const h = grid.get(gx, gz);
      let next = h;
      switch (stroke.tool) {
        case "raise":
          next = h + stroke.strength * falloff;
          break;
        case "lower":
          next = h - stroke.strength * falloff;
          break;
        case "flatten": {
          const target = stroke.target ?? h;
          next = h + (target - h) * clamp01(stroke.strength * falloff);
          break;
        }
        case "smooth": {
          let sum = 0;
          let n = 0;
          for (const [dx, dz] of NEIGHBOURS) {
            if (grid.has(gx + dx, gz + dz)) {
              sum += grid.get(gx + dx, gz + dz);
              n++;
            }
          }
          if (n > 0) next = h + (sum / n - h) * clamp01(stroke.strength * falloff);
          break;
        }
      }
      if (next !== h) updates.push([gx, gz, next]);
    }
  }
  for (const [gx, gz, v] of updates) {
    grid.set(gx, gz, v);
    for (const [cx, cz] of grid.chunksAt(gx, gz)) touched.add(chunkKey(cx, cz));
  }
  return touched;
}

/** Height of the sample nearest to world (x, z); NaN outside the grid. */
export function sampleNearest(grid: HeightGrid, x: number, z: number, chunkWorldSize = 16): number {
  const toGrid = TILE_CELLS / chunkWorldSize;
  return grid.get(Math.round(x * toGrid), Math.round(z * toGrid));
}

const NEIGHBOURS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
