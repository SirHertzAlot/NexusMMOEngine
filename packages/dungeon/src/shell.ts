/**
 * A dungeon's shell: the layout's floor plan as one closed mesh, carved
 * out of rock, that an instance collides with and navigates (Jolt, Recast)
 * and a client renders from inside.
 *
 *   floor cells ──Clipper2──▶ polygons ──manifold──▶ volumes ──manifold──▶ rock − volumes
 *
 * - The walkable floor (floor and pool cells) is merged into polygons, one
 *   batch union of each row's runs, then extruded to corridor height.
 * - Each room's own cells are extruded again to its taller ceiling, by
 *   size (small, medium, large).
 * - Pool cells sink below the floor as basins.
 * - A room a laid interior walls (`laidRooms`) has no wall of its own on its
 *   closed edges: the interior's walls stand there.
 * - Everything is subtracted from a block of rock around the dungeon, and
 *   the block's outside is dropped: what remains is the inside surface,
 *   every triangle facing into the space you walk in, tagged floor, wall,
 *   ceiling or basin by where it came from and which way it faces.
 *
 * The geometry comes in as a parameter (`@mmo-engine/addon-geometry`, or
 * anything with its two calls), so this package stays plain TypeScript.
 */

import { CELL, type Dungeon } from "./generate.js";

/** Metres per layout cell. */
export const DUNGEON_CELL = 2;

export interface ShellOptions {
  /** Metres per cell (default DUNGEON_CELL). */
  cell?: number;
  /** Corridor ceiling, metres. */
  corridorHeight?: number;
  /** Room ceilings by size, metres. */
  roomHeight?: { s: number; m: number; l: number };
  /** How far pool basins sink below the floor, metres. */
  poolDepth?: number;
  /**
   * Rooms a laid interior walls (interiors.ts). Their closed edges get no shell wall, since the interior's walls stand
   * there. Absent or empty: the shell walls every room.
   */
  laidRooms?: readonly number[];
}

export const SHELL_DEFAULTS: Required<ShellOptions> = {
  cell: DUNGEON_CELL,
  corridorHeight: 4,
  roomHeight: { s: 5, m: 6, l: 8 },
  poolDepth: 1.2,
  laidRooms: [],
};

/** What each triangle is. */
export const SHELL_PARTS = ["floor", "wall", "ceiling", "basin"] as const;
export type ShellPart = (typeof SHELL_PARTS)[number];

/** The slice of `@mmo-engine/addon-geometry` the shell needs. */
export interface GeometryOps {
  cellsToPolygons(
    mask: Uint8Array,
    width: number,
    height: number,
    opts?: { cell?: number; simplify?: number },
  ): { points: Float64Array; rings: Uint32Array; area: number };
  solid(tree: unknown): { positions: Float32Array; indices: Uint32Array; tags: Uint16Array; volume: number; genus: number };
}

export interface DungeonShell {
  /** x right, y up, z down the layout's rows; cell (x, y) spans x..x+1, y..y+1 times the cell size. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Index into SHELL_PARTS, per triangle. */
  parts: Uint8Array;
  /** Metres. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  stats: {
    triangles: number;
    vertices: number;
    /** Floor area the shell was built from, m². */
    floorArea: number;
    /** Volume of the space inside, m³. */
    volume: number;
    rooms: number;
    pools: number;
    ms: number;
  };
}

// Tags the solid's leaves carry (the rock's outside is dropped).
const TAG = { rock: 1, space: 2, basin: 3 } as const;

export function dungeonShell(d: Dungeon, geo: GeometryOps, options: ShellOptions = {}): DungeonShell {
  const o = { ...SHELL_DEFAULTS, ...options, roomHeight: { ...SHELL_DEFAULTS.roomHeight, ...options.roomHeight } };
  const t0 = performance.now();
  const { width: W, height: H, cell } = { width: d.width, height: d.height, cell: o.cell };
  const n = W * H;

  // Walkable space: floor and pool cells (a pool is a basin in the floor).
  const walk = new Uint8Array(n);
  const pool = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    walk[i] = d.grid[i] === CELL.floor || d.grid[i] === CELL.pool ? 1 : 0;
    pool[i] = d.grid[i] === CELL.pool ? 1 : 0;
  }
  // The laid rooms, and the height their interior walls stand. Their cells tell closesLaidRoom which faces to leave out.
  const laidRooms = new Set(o.laidRooms);
  const laidHeight = new Map<number, number>();
  for (const r of d.rooms) if (laidRooms.has(r.id)) laidHeight.set(r.id, o.roomHeight[r.size]);
  const laid = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (walk[i] && laidHeight.has(d.roomId[i])) laid[i] = d.roomId[i];
  const floor = geo.cellsToPolygons(walk, W, H, { cell });
  if (floor.rings.length === 0) throw new Error("dungeonShell: the layout has no floor");

  const space: unknown[] = [{ op: "extrude", polygons: floor, y0: 0, height: o.corridorHeight, tag: TAG.space }];
  let top = o.corridorHeight;
  let rooms = 0;
  for (const r of d.rooms) {
    const h = o.roomHeight[r.size];
    if (h <= o.corridorHeight) continue;
    const mask = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (d.roomId[i] === r.id && walk[i]) {
        mask[i] = 1;
        any = true;
      }
    }
    if (!any) continue;
    space.push({ op: "extrude", polygons: geo.cellsToPolygons(mask, W, H, { cell }), y0: 0, height: h, tag: TAG.space });
    top = Math.max(top, h);
    rooms++;
  }
  let pools = 0;
  for (let i = 0; i < n; i++) pools += pool[i];
  if (pools > 0) {
    space.push({ op: "extrude", polygons: geo.cellsToPolygons(pool, W, H, { cell }), y0: -o.poolDepth, height: o.poolDepth, tag: TAG.basin });
  }

  // Rock a cell thick round everything, a metre under the basins and over the tallest ceiling.
  const bottom = -(pools > 0 ? o.poolDepth : 0) - 1;
  const solid = geo.solid({
    op: "difference",
    of: [
      { op: "box", min: [-cell, bottom, -cell], max: [(W + 1) * cell, top + 1, (H + 1) * cell], tag: TAG.rock },
      { op: "union", of: space },
    ],
  });

  // Keep the inside surface; name each triangle by its origin and its facing.
  const src = solid.positions;
  // A wall face on a grid line closes a laid room when, along its whole length, a laid cell of that room is on one side and
  // rock or void is on the other, and it stays under the room's height. The face is left out: the interior's wall stands there.
  const ON_LINE = 1e-4;
  const cellOf = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x);
  const laidAt = (i: number): number => (i >= 0 ? laid[i] : -1);
  const rockAt = (i: number): boolean => i < 0 || walk[i] === 0;
  const closedBy = (a: number, b: number): number => (laidAt(a) >= 0 && rockAt(b) ? laidAt(a) : laidAt(b) >= 0 && rockAt(a) ? laidAt(b) : -1);
  const gridLine = (v: number[]): number => {
    const k = Math.round(v[0] / cell);
    return v.every((u) => Math.abs(u - k * cell) < ON_LINE) ? k : NaN;
  };
  const closesLaidRoom = (a: number, b: number, c: number): boolean => {
    const xs = [src[a], src[b], src[c]], ys = [src[a + 1], src[b + 1], src[c + 1]], zs = [src[a + 2], src[b + 2], src[c + 2]];
    const kx = gridLine(xs), kz = gridLine(zs);
    if (Number.isNaN(kx) === Number.isNaN(kz)) return false; // a wall face lies on exactly one grid line
    const alongZ = !Number.isNaN(kx);
    const across = (s: number): number => (alongZ ? closedBy(cellOf(kx - 1, s), cellOf(kx, s)) : closedBy(cellOf(s, kz - 1), cellOf(s, kz)));
    const run = alongZ ? zs : xs;
    const first = Math.floor((Math.min(...run) + ON_LINE) / cell), last = Math.ceil((Math.max(...run) - ON_LINE) / cell) - 1;
    let room = -1;
    for (let s = first; s <= last; s++) {
      const r = across(s);
      if (r < 0 || (room >= 0 && r !== room)) return false;
      room = r;
    }
    return room >= 0 && Math.min(...ys) >= -ON_LINE && Math.max(...ys) <= (laidHeight.get(room) ?? 0) + ON_LINE;
  };
  const keep: number[] = [];
  const parts: number[] = [];
  for (let t = 0; t < solid.tags.length; t++) {
    const tag = solid.tags[t];
    if (tag === TAG.rock) continue;
    const a = solid.indices[t * 3] * 3, b = solid.indices[t * 3 + 1] * 3, c = solid.indices[t * 3 + 2] * 3;
    const ux = src[b] - src[a], uy = src[b + 1] - src[a + 1], uz = src[b + 2] - src[a + 2];
    const vx = src[c] - src[a], vy = src[c + 1] - src[a + 1], vz = src[c + 2] - src[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const up = ny / len;
    let part: ShellPart;
    if (tag === TAG.basin && up > 0.7) part = "basin";
    else if (up > 0.7) part = "floor";
    else if (up < -0.7) part = "ceiling";
    else part = "wall";
    if (part === "wall" && laidHeight.size > 0 && closesLaidRoom(a, b, c)) continue;
    keep.push(t);
    parts.push(SHELL_PARTS.indexOf(part));
  }

  // Compact: only the vertices the kept triangles use, in first-use order.
  const remap = new Int32Array(src.length / 3).fill(-1);
  const positions: number[] = [];
  const indices = new Uint32Array(keep.length * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  keep.forEach((t, k) => {
    for (let j = 0; j < 3; j++) {
      const v = solid.indices[t * 3 + j];
      if (remap[v] < 0) {
        remap[v] = positions.length / 3;
        for (let a = 0; a < 3; a++) {
          const x = src[v * 3 + a];
          positions.push(x);
          min[a] = Math.min(min[a], x);
          max[a] = Math.max(max[a], x);
        }
      }
      indices[k * 3 + j] = remap[v];
    }
  });

  const rockVolume = (W + 2) * cell * ((H + 2) * cell) * (top + 1 - bottom);
  return {
    positions: Float32Array.from(positions),
    indices,
    parts: Uint8Array.from(parts),
    bounds: { min, max },
    stats: {
      triangles: keep.length,
      vertices: positions.length / 3,
      floorArea: floor.area,
      volume: rockVolume - solid.volume,
      rooms,
      pools,
      ms: performance.now() - t0,
    },
  };
}
