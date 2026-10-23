/**
 * The prototype settlement: a walled pond village.
 *
 * One geometry, three terrain profiles — terrain is an input to the
 * generator, exactly as the real bake will take it from the terrain /
 * hydrology stage:
 *
 *  - "pond":     the water castle. The island sits in a pond; the water
 *                table is at the surface, so mining is a non-starter
 *                (every sap floods) and the fight is about the causeway
 *                and the wall faces.
 *  - "dry":      the same village on dry, diggable ground with a deep
 *                water table: mining is live, and no moat can be flooded
 *                (no water to divert), so towers must go round.
 *  - "riverside": dry diggable ground, but a river runs along the west
 *                edge — moats are feasible for the structures near it.
 *
 * The starting layout deliberately commits the classic sins: a straight
 * causeway to the gate, square towers only on the north corners, and long
 * wall faces nothing can shoot along.
 */

import { idx, type Grid, type Settlement, type TerrainKind, type Tile } from "./model.js";

export type TerrainProfile = "pond" | "dry" | "riverside";

export const GRID_W = 25;
export const GRID_H = 25;
/** Wall ring rectangle (inclusive). */
export const WALL = { x0: 5, y0: 5, x1: 19, y1: 19 };
export const GATE_X = 12;

function tile(terrain: TerrainKind, waterDepth: number): Tile {
  return { terrain, diggable: terrain === "land" || terrain === "marsh", waterDepth };
}

export function generatePondVillage(profile: TerrainProfile): Settlement {
  const w = GRID_W;
  const h = GRID_H;
  const tiles: Tile[] = new Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let t: Tile;
      const onIsland = x >= WALL.x0 - 1 && x <= WALL.x1 + 1 && y >= WALL.y0 - 1 && y <= WALL.y1 + 1;
      if (profile === "pond") {
        if (onIsland) t = tile("land", 1.0);
        else if (x >= WALL.x0 - 2 && x <= WALL.x1 + 2 && y >= WALL.y0 - 2 && y <= WALL.y1 + 2)
          t = tile("marsh", 0.6);
        else t = tile("water", 0);
      } else {
        // dry / riverside: diggable land, deep water table.
        t = tile("land", 4.5);
        if (profile === "riverside" && x <= 2) t = tile("water", 0);
      }
      tiles[idx({ w, h, tiles }, x, y)] = t;
    }
  }
  const grid: Grid = { w, h, tiles };

  // The causeway: a dead-straight road from the south edge to the gate.
  for (let y = WALL.y1 + 1; y < h; y++) {
    const i = idx(grid, GATE_X, y);
    grid.tiles[i] = { terrain: "road", diggable: true, waterDepth: profile === "pond" ? 0.8 : 4.5 };
  }

  // Wall ring.
  const walls = new Set<number>();
  for (let x = WALL.x0; x <= WALL.x1; x++) {
    walls.add(idx(grid, x, WALL.y0));
    walls.add(idx(grid, x, WALL.y1));
  }
  for (let y = WALL.y0; y <= WALL.y1; y++) {
    walls.add(idx(grid, WALL.x0, y));
    walls.add(idx(grid, WALL.x1, y));
  }

  const gate = idx(grid, GATE_X, WALL.y1);
  const core = idx(grid, 12, 12);

  return {
    name: `pond-village (${profile})`,
    grid,
    walls,
    gate,
    core,
    // Square towers on the north corners only — the classic mistake.
    towers: [
      { x: WALL.x0, y: WALL.y0, form: "square" },
      { x: WALL.x1, y: WALL.y0, form: "square" },
    ],
    barbican: null,
    moat: new Set(),
    islands: new Set(),
    obstacles: new Set(),
    // The village as generated keeps its well and grain outside the
    // walls — a siege ends it. The loop will fix that.
    stores: { well: false, granary: false },
  };
}
