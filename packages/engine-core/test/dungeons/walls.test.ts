/**
 * Dungeon walls and prop colliders (physics pass): a body that moves in an
 * instance ends every tick on a walkable cell, however it got there
 * (corner clips, thin walls at speed), and baked props block it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import * as C from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { readLayout, walkableAt } from "../../src/dungeons/pool.js";
import { DungeonWallSystem } from "../../src/dungeons/walls.js";

/** A W x H layout from rows of "#" (wall) and "." (floor); cell (x, y) spans [2x, 2x+2) x [2y, 2y+2) metres. */
function layoutOf(rows: string[], colliders: { x: number; y: number; r: number }[] = []) {
  const H = rows.length, W = rows[0].length;
  const grid = new Uint8Array(W * H);
  rows.forEach((row, y) => [...row].forEach((ch, x) => (grid[y * W + x] = ch === "." ? 1 : 2)));
  return readLayout({
    format: "mmo-dungeon/1", id: "t", name: "t", params: { theme: "grim" }, width: W, height: H,
    rooms: [{ id: 0, cx: 1, cy: 1 }], entrance: 0, boss: 0, spawns: [], colliders,
    grids: { grid: Buffer.from(grid).toString("base64") },
  });
}

function mover(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  addComponent(sim.ecs, C.Transform, e);
  addComponent(sim.ecs, C.Velocity, e);
  C.Transform.px[e] = x;
  C.Transform.pz[e] = z;
  return e;
}
const at = (e: number): [number, number] => [C.Transform.px[e], C.Transform.pz[e]];

function run(rows: string[], from: [number, number], to: [number, number], colliders: { x: number; y: number; r: number }[] = []) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const layout = layoutOf(rows, colliders);
  const walls = new DungeonWallSystem(layout);
  const e = mover(sim, ...from);
  walls.step(sim);
  C.Transform.px[e] = to[0];
  C.Transform.pz[e] = to[1];
  walls.step(sim);
  return { layout, pos: at(e) };
}

describe("dungeon walls: swept moves", () => {
  it("a diagonal move between two wall cells does not clip the corner", () => {
    // Floor at cells (1,1) and (2,2); (2,1) and (1,2) are wall: the diagonal slips between them.
    const rows = ["####", "#.##", "##.#", "####"];
    const { layout, pos } = run(rows, [3, 3], [5, 5]);
    assert.ok(walkableAt(layout, ...pos));
    assert.deepEqual(pos, [3, 3], "the move through the corner is refused");
  });

  it("a fast step does not skip over a thin wall", () => {
    // Floor, one wall cell, floor: a 4 m step from the left room lands in the right one.
    const rows = ["#####", "#.#.#", "#####"];
    const { pos } = run(rows, [3, 3], [7, 3]);
    assert.deepEqual(pos, [3, 3]);
  });

  it("a fast step along a corridor that stays on the floor is not blocked", () => {
    const rows = ["#######", "#.....#", "#######"];
    assert.deepEqual(run(rows, [3, 3], [9, 3]).pos, [9, 3]);
  });

  it("walks through a one-cell doorway", () => {
    const rows = ["#####", "#.#.#", "#...#", "#####"];
    // Left chamber down into the gap row, across the door, no wall in between.
    assert.deepEqual(run(rows, [3, 5], [7, 5]).pos, [7, 5]);
  });

  it("slides along a wall: the blocked axis stays, the free one moves", () => {
    const rows = ["####", "#..#", "#..#", "####"];
    assert.deepEqual(run(rows, [3, 3], [1, 5]).pos, [3, 5]);
  });

  it("a long jump (a respawn at the entrance) lands where it was sent", () => {
    const rows = ["#####################", "#.#################.#", "#####################"];
    assert.deepEqual(run(rows, [3, 3], [39, 3]).pos, [39, 3]);
  });
});

describe("dungeon walls: prop colliders", () => {
  const room = ["######", "#....#", "#....#", "#....#", "######"];
  // A pillar of radius 0.5 cell at the cell-grid point (3, 2.5): world (6, 5).
  const pillar = [{ x: 3, y: 2.5, r: 0.5 }];

  it("a pillar blocks a body walking into it, which slides round", () => {
    const { pos, layout } = run(room, [3, 5], [5.6, 5], pillar);
    assert.ok(walkableAt(layout, ...pos));
    assert.ok(Math.hypot(pos[0] - 6, pos[1] - 5) >= 1 - 1e-6, `clear of the pillar (${pos})`);
  });

  it("a body well clear of the pillar is left alone", () => {
    assert.deepEqual(run(room, [3, 3], [4, 3], pillar).pos, [4, 3]);
  });

  it("a pillar does not push a body out through a wall", () => {
    const { pos, layout } = run(room, [3, 3], [2.2, 3], [{ x: 1, y: 1.5, r: 0.5 }]);
    assert.ok(walkableAt(layout, ...pos));
  });

  it("a noclip body passes through a pillar", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const walls = new DungeonWallSystem(layoutOf(room, pillar));
    const e = mover(sim, 3, 5);
    addComponent(sim.ecs, C.Noclip, e);
    walls.step(sim);
    C.Transform.px[e] = 6;
    walls.step(sim);
    assert.deepEqual(at(e), [6, 5]);
  });
});
