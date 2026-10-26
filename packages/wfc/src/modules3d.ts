/**
 * 3D Grid Module Variation Propagator (WFC).
 *
 * Propagates module types across a 3D grid, selecting coherent, context-sensitive
 * variations (straight walls, corners, T-junctions, doorways, damaged stonework,
 * column plinths/shafts/capitals, ceiling vaults) based on 6-connected 3D neighbors
 * (+x, -x, +y, -y, +z, -z).
 *
 * Zero-allocation on hot solve evaluation where possible, deterministic per seed.
 */

import { gridProblem, type Axis, type GridProblem, type GridTile } from "./grid.js";
import { solve, type WfcSolution } from "./solver.js";

export type RotationStep = 0 | 90 | 180 | 270;

export interface FaceSockets {
  /** Face +X */
  px?: string;
  /** Face -X */
  nx?: string;
  /** Face +Y */
  py?: string;
  /** Face -Y */
  ny?: string;
  /** Face +Z (up) */
  pz?: string;
  /** Face -Z (down) */
  nz?: string;
}

export interface ModuleVariationDef {
  /** Unique base variation id (e.g. "wall_straight", "floor_cracked", "pillar_base"). */
  id: string;
  /** Base module type (e.g. "wall", "floor", "ceiling", "pillar", "doorway", "void"). */
  moduleType: string;
  /** Sockets on each of the 6 faces at rotation 0. Missing face matches anything. */
  sockets: FaceSockets;
  /** Relative frequency weight (default 1.0). */
  weight?: number;
  /** Rotations around +Z axis to generate: 1 (isotropic), 2 (0 and 90), or 4 (0, 90, 180, 270). */
  rotations?: 1 | 2 | 4;
  /** Mesh or asset identifier (Synty model name or procedural key). */
  modelId?: string;
  /** Metadata tags for classification or biome filtering. */
  tags?: readonly string[];
}

export interface ExpandedTile extends GridTile {
  baseId: string;
  moduleType: string;
  rot: RotationStep;
  modelId?: string;
}

export interface ModuleGrid3DSpec {
  width: number;
  height: number;
  depth: number;
  /** Optional base module type per cell. Index: (z * H + y) * W + x. Undefined allows all types. */
  cellTypes?: readonly (string | null | undefined)[];
  /** Variation definitions. Defaults to BUILTIN_DUNGEON_MODULES_3D if omitted. */
  variations?: readonly ModuleVariationDef[];
  /** Optional custom socket compatibility or adjacency override. */
  allow?: (a: ExpandedTile, b: ExpandedTile, axis: Axis) => boolean;
  /** Deterministic RNG seed. */
  seed?: number;
  /** Physical size of each grid cell in metres (default 2). */
  cellSize?: number;
  /** Maximum backtracks before restart (default 2000). */
  maxBacktracks?: number;
}

export interface PlacedModuleInstance {
  baseId: string;
  variationId: string;
  moduleType: string;
  x: number;
  y: number;
  z: number;
  worldPos: [number, number, number];
  rot: RotationStep;
  modelId?: string;
  sockets: FaceSockets;
}

export interface ModuleGrid3DResult {
  width: number;
  height: number;
  depth: number;
  cellSize: number;
  instances: PlacedModuleInstance[];
  solution: WfcSolution;
  get(x: number, y: number, z: number): PlacedModuleInstance | undefined;
  stats: {
    totalCells: number;
    variationCounts: Record<string, number>;
    moduleTypeCounts: Record<string, number>;
    solveMs: number;
  };
}

/**
 * Rotate horizontal sockets clockwise by 90 degrees around +Z.
 */
function rotateSockets(s: FaceSockets, rot: RotationStep): FaceSockets {
  if (rot === 0) return { ...s };
  if (rot === 90) {
    return {
      px: s.ny,
      py: s.px,
      nx: s.py,
      ny: s.nx,
      pz: s.pz,
      nz: s.nz,
    };
  }
  if (rot === 180) {
    return {
      px: s.nx,
      py: s.ny,
      nx: s.px,
      ny: s.py,
      pz: s.pz,
      nz: s.nz,
    };
  }
  // rot === 270
  return {
    px: s.py,
    py: s.nx,
    nx: s.ny,
    ny: s.px,
    pz: s.pz,
    nz: s.nz,
  };
}

/**
 * Expand variation definitions with rotations into solver GridTile options.
 */
export function expandModuleVariations(defs: readonly ModuleVariationDef[]): ExpandedTile[] {
  const result: ExpandedTile[] = [];
  for (const def of defs) {
    const rots: RotationStep[] =
      def.rotations === 4 ? [0, 90, 180, 270] : def.rotations === 2 ? [0, 90] : [0];
    const baseWeight = def.weight ?? 1;
    const weightPerRot = baseWeight / rots.length;

    for (const rot of rots) {
      const id = rot === 0 && rots.length === 1 ? def.id : `${def.id}_r${rot}`;
      result.push({
        id,
        baseId: def.id,
        moduleType: def.moduleType,
        rot,
        modelId: def.modelId,
        weight: weightPerRot,
        tags: def.tags,
        sockets: rotateSockets(def.sockets, rot),
      });
    }
  }
  return result;
}

/**
 * Canonical 3D Modular Dungeon Tileset with 6-face sockets.
 * Sockets:
 * - "rock": solid interior rock / void boundary
 * - "air": open room air / walkable corridor volume
 * - "wall_join": masonry core joining adjoining wall segments
 */
export const BUILTIN_DUNGEON_MODULES_3D: readonly ModuleVariationDef[] = [
  // VOID / SOLID ROCK
  {
    id: "void_rock",
    moduleType: "void",
    sockets: { px: "rock", nx: "rock", py: "rock", ny: "rock", pz: "rock", nz: "rock" },
    rotations: 1,
    weight: 1.0,
    modelId: "dungeon-pack/SM_Env_Dungeon_Rock_01",
  },

  // FLOOR VARIATIONS
  {
    id: "floor_plain",
    moduleType: "floor",
    sockets: { pz: "air", nz: "rock" },
    rotations: 1,
    weight: 0.7,
    modelId: "dungeon-pack/SM_Env_Dungeon_Floor_01",
  },
  {
    id: "floor_cracked",
    moduleType: "floor",
    sockets: { pz: "air", nz: "rock" },
    rotations: 4,
    weight: 0.2,
    modelId: "dungeon-pack/SM_Env_Dungeon_Floor_Cracked_01",
  },
  {
    id: "floor_drain",
    moduleType: "floor",
    sockets: { pz: "air", nz: "rock" },
    rotations: 1,
    weight: 0.1,
    modelId: "dungeon-pack/SM_Env_Dungeon_Floor_Drain_01",
  },

  // WALL VARIATIONS
  {
    id: "wall_straight",
    moduleType: "wall",
    sockets: { px: "wall_join", nx: "wall_join", py: "rock", ny: "air", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.7,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_01",
  },
  {
    id: "wall_damaged",
    moduleType: "wall",
    sockets: { px: "wall_join", nx: "wall_join", py: "rock", ny: "air", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.15,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Damaged_01",
  },
  {
    id: "wall_niche",
    moduleType: "wall",
    sockets: { px: "wall_join", nx: "wall_join", py: "rock", ny: "air", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.15,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Niche_01",
  },
  {
    id: "wall_end",
    moduleType: "wall",
    sockets: { px: "wall_join", nx: "rock", py: "rock", ny: "air", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.4,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_01",
  },
  {
    id: "wall_corner_convex",
    moduleType: "wall",
    sockets: { px: "air", nx: "wall_join", py: "wall_join", ny: "air", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.5,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Corner_Convex_01",
  },
  {
    id: "wall_corner_concave",
    moduleType: "wall",
    sockets: { px: "wall_join", nx: "rock", py: "rock", ny: "wall_join", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.5,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Corner_Concave_01",
  },
  {
    id: "wall_tee",
    moduleType: "wall",
    sockets: { px: "wall_join", nx: "wall_join", py: "rock", ny: "wall_join", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.3,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Tee_01",
  },
  {
    id: "wall_cross",
    moduleType: "wall",
    sockets: { px: "wall_join", nx: "wall_join", py: "wall_join", ny: "wall_join", pz: "rock", nz: "rock" },
    rotations: 1,
    weight: 0.1,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Cross_01",
  },
  {
    id: "wall_doorway",
    moduleType: "doorway",
    sockets: { px: "wall_join", nx: "wall_join", py: "air", ny: "air", pz: "rock", nz: "rock" },
    rotations: 4,
    weight: 0.5,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Doorway_01",
  },
  {
    id: "wall_arch",
    moduleType: "arch",
    sockets: { px: "wall_join", nx: "wall_join", py: "air", ny: "air", pz: "air", nz: "rock" },
    rotations: 4,
    weight: 0.3,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_Arch_01",
  },
  // Resilient fallback wall filler for organic/diagonal contours
  {
    id: "wall_filler",
    moduleType: "wall",
    sockets: { pz: "rock", nz: "rock" },
    rotations: 1,
    weight: 0.05,
    modelId: "dungeon-pack/SM_Env_Dungeon_Wall_01",
  },

  // PILLAR VARIATIONS
  {
    id: "pillar_single",
    moduleType: "pillar",
    sockets: { pz: "air", nz: "rock" },
    rotations: 1,
    weight: 0.5,
    modelId: "dungeon-pack/SM_Env_Dungeon_Pillar_01",
  },

  // CEILING VARIATIONS
  {
    id: "ceiling_flat",
    moduleType: "ceiling",
    sockets: { pz: "rock", nz: "air" },
    rotations: 1,
    weight: 0.7,
    modelId: "dungeon-pack/SM_Env_Dungeon_Ceiling_01",
  },
  {
    id: "ceiling_vault",
    moduleType: "ceiling",
    sockets: { pz: "rock", nz: "air" },
    rotations: 2,
    weight: 0.3,
    modelId: "dungeon-pack/SM_Env_Dungeon_Ceiling_Vault_01",
  },
];

/**
 * Propagates module variations across a 3D grid using Wave Function Collapse.
 */
export function propagateModuleGrid3D(spec: ModuleGrid3DSpec): ModuleGrid3DResult {
  const { width: W, height: H, depth: D } = spec;
  const cellSize = spec.cellSize ?? 2;
  const t0 = performance.now();

  const defs = spec.variations ?? BUILTIN_DUNGEON_MODULES_3D;
  const tiles = expandModuleVariations(defs);

  // Group tile indices by moduleType
  const typeToIndices = new Map<string, number[]>();
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    let arr = typeToIndices.get(t.moduleType);
    if (!arr) {
      arr = [];
      typeToIndices.set(t.moduleType, arr);
    }
    arr.push(i);
  }

  // Build grid problem
  const problem: GridProblem = gridProblem({
    width: W,
    height: H,
    depth: D,
    tiles,
    allow: spec.allow as any,
  });

  // Calculate domains from cellTypes if provided
  let domains: (readonly number[] | null)[] | undefined;
  if (spec.cellTypes && spec.cellTypes.length === W * H * D) {
    domains = new Array(W * H * D);
    for (let i = 0; i < W * H * D; i++) {
      const type = spec.cellTypes[i];
      if (type && typeToIndices.has(type)) {
        domains[i] = typeToIndices.get(type)!;
      } else {
        domains[i] = null;
      }
    }
  }

  // Solve WFC
  const solution = solve(
    {
      ...problem,
      domains,
    },
    {
      seed: spec.seed ?? 1337,
      maxBacktracks: spec.maxBacktracks ?? 2000,
    },
  );

  const totalCells = W * H * D;
  const instances: PlacedModuleInstance[] = new Array(totalCells);
  const variationCounts: Record<string, number> = {};
  const moduleTypeCounts: Record<string, number> = {};

  for (let z = 0; z < D; z++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const slot = problem.index(x, y, z);
        const optIdx = solution.assignment[slot];
        const tile = tiles[optIdx];

        variationCounts[tile.baseId] = (variationCounts[tile.baseId] ?? 0) + 1;
        moduleTypeCounts[tile.moduleType] = (moduleTypeCounts[tile.moduleType] ?? 0) + 1;

        instances[slot] = {
          baseId: tile.baseId,
          variationId: tile.id,
          moduleType: tile.moduleType,
          x,
          y,
          z,
          worldPos: [x * cellSize, y * cellSize, z * cellSize],
          rot: tile.rot,
          modelId: tile.modelId,
          sockets: (tile.sockets ?? {}) as FaceSockets,
        };
      }
    }
  }

  const solveMs = performance.now() - t0;

  return {
    width: W,
    height: H,
    depth: D,
    cellSize,
    instances,
    solution,
    get(x: number, y: number, z: number): PlacedModuleInstance | undefined {
      if (x < 0 || x >= W || y < 0 || y >= H || z < 0 || z >= D) return undefined;
      return instances[problem.index(x, y, z)];
    },
    stats: {
      totalCells,
      variationCounts,
      moduleTypeCounts,
      solveMs,
    },
  };
}
