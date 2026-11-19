/**
 * Collision matches the shell: every walkable cell is covered by a floor
 * triangle, no floor triangle covers rock, and the collision mesh is exactly the
 * shell's solid triangles (basins excluded).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { bakeCrypt, CRYPT_THEMES, parseLayoutMask, SHELL_PARTS, shellCollision, DUNGEON_CELL, type GeometryOps } from "../src/index.js";

const geo = createRequire(import.meta.url)("@mmo-engine/addon-geometry") as GeometryOps;
const LAYOUT = parseLayoutMask({
  version: 1,
  rows: ["#####", "#...#", "#.#.#", "#...#", "#####"],
  entrance: { x: 1, y: 1 },
  portals: [],
});

/** Is the point (px, pz) inside the triangle's footprint (x, z)? */
function inTri(px: number, pz: number, a: number[], b: number[], c: number[]): boolean {
  const s = (p: number[], q: number[]) => (px - q[0]) * (p[2] - q[2]) - (p[0] - q[0]) * (pz - q[2]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

describe("shell collision matches the shell", () => {
  const bake = bakeCrypt(LAYOUT, CRYPT_THEMES["dry-crypt"], geo);
  const col = shellCollision(bake.shell);
  const P = col.positions;
  const floorTris: number[][][] = [];
  for (let t = 0; t < col.triangles; t++) {
    const tri = [0, 1, 2].map((k) => {
      const v = col.indices[t * 3 + k];
      return [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    });
    if (tri.every((v) => v[1] === 0)) floorTris.push(tri);
  }
  const floorCovered = (x: number, z: number): boolean => floorTris.some((tri) => inTri(x, z, tri[0], tri[1], tri[2]));

  it("every walkable cell centre is covered by a floor triangle", () => {
    const walkable: Array<[number, number]> = [];
    for (let y = 0; y < LAYOUT.rows.length; y++) for (let x = 0; x < LAYOUT.rows[0].length; x++) {
      if (LAYOUT.rows[y][x] === ".") walkable.push([(x + 0.5) * DUNGEON_CELL, (y + 0.5) * DUNGEON_CELL]);
    }
    assert.ok(walkable.length > 0);
    for (const [x, z] of walkable) assert.ok(floorCovered(x, z), `walkable (${x}, ${z}) has floor`);
  });

  it("no floor triangle covers a rock cell", () => {
    for (let y = 0; y < LAYOUT.rows.length; y++) for (let x = 0; x < LAYOUT.rows[0].length; x++) {
      if (LAYOUT.rows[y][x] !== "#") continue;
      assert.ok(!floorCovered((x + 0.5) * DUNGEON_CELL, (y + 0.5) * DUNGEON_CELL), `rock (${x}, ${y}) has no floor`);
    }
  });

  it("the collision mesh is exactly the shell's floor, wall and ceiling triangles", () => {
    const solid = bake.shell.parts.filter((p) => SHELL_PARTS[p] !== "basin").length;
    assert.equal(col.triangles, solid);
  });
});
