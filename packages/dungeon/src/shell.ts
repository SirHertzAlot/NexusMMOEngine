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
 * - Levels: a cell on level L has its floor at L × levelStep metres. Level
 *   −1 is a pit, level +1 a dais; where two levels meet, the step's face is
 *   a wall of the shell.
 * - Corners: a chamfer or a pillar (`cornerMode`) is rock left standing in
 *   the corner, so its faces are walls of the shell like any other.
 * - A room a laid interior walls (`laidRooms`) has no wall of its own on its
 *   closed edges: the interior's walls stand there.
 * - Everything is subtracted from a block of rock around the dungeon, and
 *   the block's outside is dropped: what remains is the inside surface,
 *   every triangle facing into the space you walk in, tagged floor, wall,
 *   ceiling or basin by where it came from and which way it faces.
 * - Wall thickness (`wallThickness` above 0): the rock is no longer a block
 *   round the whole dungeon. It is the space grown outwards by the thickness,
 *   on every side, under every floor and over every ceiling, so the dungeon
 *   is a walled body standing free. The body's outside faces are kept and
 *   tagged outer: the shell is then a closed mesh with an inside and an
 *   outside. The body reaches past the painted cells by the thickness.
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
  /** Corridor ceiling, metres above the floor it stands on. */
  corridorHeight?: number;
  /** Room ceilings by size, metres above the floor they stand on. */
  roomHeight?: { s: number; m: number; l: number };
  /** How far pool basins sink below the floor, metres. */
  poolDepth?: number;
  /**
   * Rooms a laid interior walls (interiors.ts). Their closed edges get no shell wall, since the interior's walls stand
   * there. Absent or empty: the shell walls every room. A room on more than one level is never closed.
   */
  laidRooms?: readonly number[];
  /** Floor level per cell, row-major (y * width + x): 0 ground, negative a pit, positive a dais. Absent: all ground. */
  levels?: Int8Array;
  /** Metres per level (default LEVEL_STEP). */
  levelStep?: number;
  /** Wall-line simplification tolerance, cells (0: none). The polygon step's own reduction. */
  simplifyTolerance?: number;
  /** flat: a ceiling over every space. open: no ceiling triangles (the space is open to the sky). */
  ceilingMode?: "flat" | "open";
  /**
   * What stands in the floor plan's corners. square: nothing (the walls meet at a right angle). chamfered: each corner
   * where two walls close in on the room is cut at 45 degrees. pillared: a square column stands on every corner, a
   * quarter of it showing where the walls close in and three quarters where a wall turns out into the room.
   */
  cornerMode?: "square" | "chamfered" | "pillared";
  /** The chamfer's leg, or the pillar's side, metres (default 0.5; at most half a cell). */
  cornerSize?: number;
  /**
   * How thick the walls, floor slab and roof slab are, metres (default 0; at most one cell). 0: the shell is the inside
   * surface only. Above 0: the shell also carries the outside faces of a wall body that thick, tagged outer. Rock between
   * two spaces that is thinner than twice the thickness stays solid; wider, and each space gets its own wall with a gap
   * between. With an open ceiling there is no roof slab: the walls end level with the space's top, and the only ceiling
   * triangles left are the undersides of a taller neighbour's wall where it overhangs a lower space.
   */
  wallThickness?: number;
}

/** Metres between floor levels: one cell's height, a ledge a stair would climb. */
export const LEVEL_STEP = 2;

export const SHELL_DEFAULTS: Required<Omit<ShellOptions, "levels">> = {
  cell: DUNGEON_CELL,
  corridorHeight: 4,
  roomHeight: { s: 5, m: 6, l: 8 },
  poolDepth: 1.2,
  laidRooms: [],
  levelStep: LEVEL_STEP,
  simplifyTolerance: 0,
  ceilingMode: "flat",
  cornerMode: "square",
  cornerSize: 0.5,
  wallThickness: 0,
};

/** What each triangle is. */
export const SHELL_PARTS = ["floor", "wall", "ceiling", "basin", "outer"] as const;
export type ShellPart = (typeof SHELL_PARTS)[number];

/** The slice of `@mmo-engine/addon-geometry` the shell needs. */
export interface GeometryOps {
  cellsToPolygons(
    mask: Uint8Array,
    width: number,
    height: number,
    opts?: { cell?: number; simplify?: number; offset?: number; join?: "miter" | "round" | "square" | "bevel" },
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
    /** Volume of the wall body, m³ (0 when wallThickness is 0: the rock has no outside). */
    wallVolume: number;
    rooms: number;
    pools: number;
    ms: number;
  };
}

// Tags the solid's leaves carry (the rock's outside is dropped, unless the walls have a thickness).
const TAG = { rock: 1, space: 2, basin: 3 } as const;
const OUTER = SHELL_PARTS.indexOf("outer");

export function dungeonShell(d: Dungeon, geo: GeometryOps, options: ShellOptions = {}): DungeonShell {
  const o = { ...SHELL_DEFAULTS, ...options, roomHeight: { ...SHELL_DEFAULTS.roomHeight, ...options.roomHeight } };
  const t0 = performance.now();
  const { width: W, height: H, cell } = { width: d.width, height: d.height, cell: o.cell };
  const n = W * H;
  const step = o.levelStep;
  if (o.levels && o.levels.length !== n) throw new Error(`dungeonShell: levels has ${o.levels.length} cells, the layout has ${n}`);
  const levelOf = (i: number): number => (o.levels ? o.levels[i] : 0);

  // Walkable space: floor and pool cells (a pool is a basin in the floor).
  const walk = new Uint8Array(n);
  const pool = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    walk[i] = d.grid[i] === CELL.floor || d.grid[i] === CELL.pool ? 1 : 0;
    pool[i] = d.grid[i] === CELL.pool ? 1 : 0;
  }
  // The levels the walkable space stands on, lowest first.
  const levelSet = new Set<number>();
  for (let i = 0; i < n; i++) if (walk[i]) levelSet.add(levelOf(i));
  const levelList = [...levelSet].sort((a, b) => a - b);
  const levelMask = (level: number, keep: (i: number) => boolean): Uint8Array => {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (levelOf(i) === level && keep(i)) m[i] = 1;
    return m;
  };

  // The laid rooms, the height their interior walls stand, and the floor they stand on. Their cells tell closesLaidRoom which
  // faces to leave out. A room on more than one level has no single floor, so it is never closed.
  const laidRooms = new Set(o.laidRooms);
  const laidHeight = new Map<number, number>();
  const laidBase = new Map<number, number>();
  for (const r of d.rooms) {
    if (!laidRooms.has(r.id)) continue;
    let level: number | null = null;
    let mixed = false;
    for (let i = 0; i < n; i++) {
      if (!walk[i] || d.roomId[i] !== r.id) continue;
      if (level === null) level = levelOf(i);
      else if (levelOf(i) !== level) mixed = true;
    }
    if (level === null || mixed) continue;
    laidHeight.set(r.id, o.roomHeight[r.size]);
    laidBase.set(r.id, level * step);
  }
  const laid = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (walk[i] && laidHeight.has(d.roomId[i])) laid[i] = d.roomId[i];
  const polyOpts = { cell, ...(o.simplifyTolerance > 0 ? { simplify: o.simplifyTolerance } : {}) };
  const thick = o.wallThickness;
  if (!(thick >= 0) || thick > cell) throw new Error(`dungeonShell: wallThickness ${thick} must be from 0 to one cell (${cell})`);
  // With a wall thickness, every piece of space gets a piece of rock round it: the same cells grown outwards by the
  // thickness (square corners), from that far under its floor to that far over its ceiling. An open ceiling gets no slab.
  const grown = { ...polyOpts, offset: thick, join: "miter" as const };
  const roof = o.ceilingMode === "open" ? 0 : thick;
  const body: unknown[] = [];
  const wrap = (mask: Uint8Array, y0: number, height: number): void => {
    if (thick > 0) body.push({ op: "extrude", polygons: geo.cellsToPolygons(mask, W, H, grown), y0: y0 - thick, height: height + thick + roof, tag: TAG.rock });
  };
  const floor = geo.cellsToPolygons(walk, W, H, polyOpts);
  if (floor.rings.length === 0) throw new Error("dungeonShell: the layout has no floor");

  // Each level's floor, extruded to corridor height above its own floor.
  const space: unknown[] = [];
  let top = -Infinity;
  for (const L of levelList) {
    const mask = levelMask(L, (i) => walk[i] === 1);
    space.push({ op: "extrude", polygons: geo.cellsToPolygons(mask, W, H, polyOpts), y0: L * step, height: o.corridorHeight, tag: TAG.space });
    wrap(mask, L * step, o.corridorHeight);
    top = Math.max(top, L * step + o.corridorHeight);
  }
  let rooms = 0;
  for (const r of d.rooms) {
    const h = o.roomHeight[r.size];
    if (h <= o.corridorHeight) continue;
    let any = false;
    for (const L of levelList) {
      const mask = levelMask(L, (i) => walk[i] === 1 && d.roomId[i] === r.id);
      if (!mask.includes(1)) continue;
      any = true;
      space.push({ op: "extrude", polygons: geo.cellsToPolygons(mask, W, H, polyOpts), y0: L * step, height: h, tag: TAG.space });
      wrap(mask, L * step, h);
      top = Math.max(top, L * step + h);
    }
    if (any) rooms++;
  }
  let pools = 0;
  for (let i = 0; i < n; i++) pools += pool[i];
  if (pools > 0) {
    for (const L of levelList) {
      const mask = levelMask(L, (i) => pool[i] === 1);
      if (!mask.includes(1)) continue;
      space.push({ op: "extrude", polygons: geo.cellsToPolygons(mask, W, H, polyOpts), y0: L * step - o.poolDepth, height: o.poolDepth, tag: TAG.basin });
      // The slab under a basin only: its top is the floor's own slab.
      if (thick > 0) body.push({ op: "extrude", polygons: geo.cellsToPolygons(mask, W, H, grown), y0: L * step - o.poolDepth - thick, height: o.poolDepth + thick, tag: TAG.rock });
    }
  }

  // Rock a cell thick round everything, a metre under the basins, the lowest floor and the tallest ceiling.
  const bottom = levelList[0] * step - (pools > 0 ? o.poolDepth : 0) - 1;

  // Corners: rock left standing in the space. Each is a full-height prism on a grid corner, kept inside the cells that
  // touch that corner, so it only ever takes space out of them. Its faces carry the space tag: they are walls.
  const corners: unknown[] = [];
  if (o.cornerMode !== "square") {
    const size = o.cornerSize;
    if (!(size > 0) || size > cell / 2) throw new Error(`dungeonShell: cornerSize ${size} must be above 0 and at most half a cell (${cell / 2})`);
    const walkAt = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && walk[y * W + x] === 1;
    const tall = top + 1 - bottom;
    const chamfers: number[] = [];
    for (let vy = 0; vy <= H; vy++) {
      for (let vx = 0; vx <= W; vx++) {
        // The four cells round this grid corner; open counts the walkable ones.
        const around: Array<[number, number]> = [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]];
        const open = around.filter(([x, y]) => walkAt(x, y));
        if (open.length !== 1 && open.length !== 3) continue; // a straight wall, open floor, or solid rock
        const px = vx * cell, pz = vy * cell;
        if (o.cornerMode === "pillared") {
          corners.push({ op: "box", min: [px - size / 2, bottom, pz - size / 2], max: [px + size / 2, top + 1, pz + size / 2], tag: TAG.space });
        } else if (open.length === 1) {
          // A triangle in the one open cell, its right angle on the corner.
          const [cx, cy] = open[0];
          const sx = cx === vx ? 1 : -1, sz = cy === vy ? 1 : -1;
          chamfers.push(px, pz, px + sx * size, pz, px, pz + sz * size);
        }
      }
    }
    if (chamfers.length > 0) {
      const rings = new Uint32Array(chamfers.length / 6).fill(3);
      corners.push({ op: "extrude", polygons: { points: Float64Array.from(chamfers), rings }, y0: bottom, height: tall, tag: TAG.space });
    }
  }
  const carved = corners.length > 0 ? { op: "difference", of: [{ op: "union", of: space }, ...corners] } : { op: "union", of: space };
  const rock = thick > 0 ? { op: "union", of: body } : { op: "box", min: [-cell, bottom, -cell], max: [(W + 1) * cell, top + 1, (H + 1) * cell], tag: TAG.rock };
  const solid = geo.solid({ op: "difference", of: [rock, carved] });

  // Keep the inside surface; name each triangle by its origin and its facing.
  const src = solid.positions;
  // A wall face on a grid line closes a laid room when, along its whole length, a laid cell of that room is on one side and
  // rock or void is on the other, and it stays under the room's height above its floor. The face is left out: the interior's
  // wall stands there.
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
    if (room < 0) return false;
    const base = laidBase.get(room) ?? 0;
    return Math.min(...ys) >= base - ON_LINE && Math.max(...ys) <= base + (laidHeight.get(room) ?? 0) + ON_LINE;
  };
  const keep: number[] = [];
  const parts: number[] = [];
  for (let t = 0; t < solid.tags.length; t++) {
    const tag = solid.tags[t];
    if (tag === TAG.rock) {
      // The rock's own faces: dropped when the rock is the block round everything, kept as the wall body's outside.
      if (thick > 0) {
        keep.push(t);
        parts.push(OUTER);
      }
      continue;
    }
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
    // Open to the sky: no ceilings. With a wall body the space's top is cut through the rock's top, so no ceiling stands
    // over it; any down-facing face left is the underside of a taller neighbour's wall, and it stays so the body is closed.
    if (part === "ceiling" && o.ceilingMode === "open" && thick === 0) continue;
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
  // The block's volume less what is left of it is the space. A wall body has no block to measure against, so the space is
  // measured on its own.
  const spaceVolume = thick > 0 ? geo.solid(carved).volume : rockVolume - solid.volume;
  return {
    positions: Float32Array.from(positions),
    indices,
    parts: Uint8Array.from(parts),
    bounds: { min, max },
    stats: {
      triangles: keep.length,
      vertices: positions.length / 3,
      floorArea: floor.area,
      volume: spaceVolume,
      wallVolume: thick > 0 ? solid.volume : 0,
      rooms,
      pools,
      ms: performance.now() - t0,
    },
  };
}
