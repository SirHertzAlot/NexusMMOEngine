import { test } from "node:test";
import assert from "node:assert/strict";
import { greenSquares } from "../src/terrain/green.js";

const grid = { width: 8, depth: 6, cell: 10, originX: -40, originZ: -30 };

test("greenSquares: largest first, disjoint, all green, in metres", () => {
  // 1 = green. A 4x4 block at (0,0), a 2x2 block at (5,3), one stray cell at (7,0).
  const rows = ["11110001", "11110000", "11110000", "11110110", "00000110", "00000000"];
  const mask = Uint8Array.from(rows.join("").split("").map(Number));
  const sq = greenSquares(mask, grid, 2);
  assert.deepEqual(sq.map((s) => [s.cx, s.cz, s.cells]), [[0, 0, 4], [5, 3, 2]]);
  assert.deepEqual([sq[0]!.x0, sq[0]!.z0, sq[0]!.x1, sq[0]!.z1, sq[0]!.areaM2], [-40, -30, 0, 10, 1600]);
  for (const s of sq) for (let z = s.cz; z < s.cz + s.cells; z++) for (let x = s.cx; x < s.cx + s.cells; x++) assert.equal(mask[z * 8 + x], 1);
});

test("greenSquares: nothing under the minimum side", () => {
  assert.deepEqual(greenSquares(new Uint8Array(48).fill(1), grid, 7), []);
  assert.equal(greenSquares(new Uint8Array(48).fill(1), grid, 6).length, 1);
});
