/**
 * Dungeon 3D Module Grid Propagation (WFC).
 *
 * Lifts a 2D dungeon layout into a 3D grid of module types (floor, wall,
 * doorway, pillar, ceiling, void) and solves for fluid, context-sensitive
 * module variations using 3D Wave Function Collapse.
 */

import {
  propagateModuleGrid3D,
  type ModuleGrid3DResult,
  type PlacedModuleInstance,
  type ModuleVariationDef,
  BUILTIN_DUNGEON_MODULES_3D,
} from "@mmo-engine/wfc";
import { CELL, type Dungeon } from "./generate.js";
import { DUNGEON_CELL } from "./shell.js";

export interface DungeonModuleOptions {
  /** Metres per cell (default DUNGEON_CELL = 2). */
  cellSize?: number;
  /** Vertical depth / layers (default 2: z=0 floor/walls, z=1 ceiling/rock). */
  depth?: number;
  /** Custom module variation definitions if overriding defaults. */
  variations?: readonly ModuleVariationDef[];
  /** RNG seed (default d.seed). */
  seed?: number;
}

export interface Dungeon3DModules {
  result: ModuleGrid3DResult;
  /** Placed non-void module instances suitable for scene rendering / instancing. */
  activeInstances: PlacedModuleInstance[];
  stats: {
    totalPlaced: number;
    floors: number;
    walls: number;
    doorways: number;
    ceilings: number;
    solveMs: number;
  };
}

/**
 * Propagate 3D module variations across a dungeon layout.
 */
export function propagateDungeonModules(
  d: Dungeon,
  options: DungeonModuleOptions = {},
): Dungeon3DModules {
  const W = d.width;
  const H = d.height;
  const D = options.depth ?? 2;
  const cellSize = options.cellSize ?? DUNGEON_CELL;
  const seed = options.seed ?? d.seed;

  const totalSlots = W * H * D;
  const cellTypes: (string | null)[] = new Array(totalSlots).fill("void");

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx2d = y * W + x;
      const cell = d.grid[idx2d];

      const slotZ0 = (0 * H + y) * W + x; // Ground plane (floors, walls, doorways)
      const slotZ1 = (1 * H + y) * W + x; // Overhead plane (ceilings, rock overburden)

      if (cell === CELL.floor || cell === CELL.pool) {
        cellTypes[slotZ0] = "floor";
        if (D > 1) cellTypes[slotZ1] = "ceiling";
      } else if (cell === CELL.wall) {
        const isDoorway = d.doorway && d.doorway[idx2d] === 1;
        if (isDoorway) {
          cellTypes[slotZ0] = "doorway";
          if (D > 1) cellTypes[slotZ1] = "ceiling";
        } else {
          // Check if wall borders floor
          const hasFloorNeighbor =
            (x > 0 && d.grid[idx2d - 1] === CELL.floor) ||
            (x + 1 < W && d.grid[idx2d + 1] === CELL.floor) ||
            (y > 0 && d.grid[idx2d - W] === CELL.floor) ||
            (y + 1 < H && d.grid[idx2d + W] === CELL.floor);

          if (hasFloorNeighbor) {
            cellTypes[slotZ0] = "wall";
          } else {
            cellTypes[slotZ0] = "void";
          }
          if (D > 1) cellTypes[slotZ1] = "void";
        }
      } else {
        cellTypes[slotZ0] = "void";
        if (D > 1) cellTypes[slotZ1] = "void";
      }
    }
  }

  const result = propagateModuleGrid3D({
    width: W,
    height: H,
    depth: D,
    cellTypes,
    variations: options.variations ?? BUILTIN_DUNGEON_MODULES_3D,
    seed,
    cellSize,
  });

  const activeInstances = result.instances.filter((inst) => inst.moduleType !== "void");

  return {
    result,
    activeInstances,
    stats: {
      totalPlaced: activeInstances.length,
      floors: result.stats.moduleTypeCounts["floor"] ?? 0,
      walls: result.stats.moduleTypeCounts["wall"] ?? 0,
      doorways: result.stats.moduleTypeCounts["doorway"] ?? 0,
      ceilings: result.stats.moduleTypeCounts["ceiling"] ?? 0,
      solveMs: result.stats.solveMs,
    },
  };
}
