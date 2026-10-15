/**
 * The instance's walkable grid (pool.ts readLayout, what DungeonWallSystem
 * enforces) and the prebaked shell clients draw (@mmo-engine/dungeon
 * dungeonShell) come from the same baked file and must agree cell by cell:
 * floor under every walkable cell, none under a wall, and the same cell
 * size, so nobody stands on a floor the shell does not draw or walks
 * through a wall it does.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BUILTIN_DRESSING, BUILTIN_THEMES, DUNGEON_CELL, SHELL_PARTS, dressDungeon, dungeonShell, encodeDungeon, generateDungeon, type GeometryOps } from "@mmo-engine/dungeon";
import { CELL_M, readLayout, walkableAt } from "../../src/dungeons/pool.js";

const geo = createRequire(import.meta.url)("@mmo-engine/addon-geometry") as GeometryOps;
const FLOOR = SHELL_PARTS.indexOf("floor");
const BASIN = SHELL_PARTS.indexOf("basin");

/** Is there a shell triangle of `part` straight above or below (x, z)? */
function hasSurface(s: ReturnType<typeof dungeonShell>, part: number, x: number, z: number): boolean {
  const p = s.positions, idx = s.indices;
  for (let t = 0; t < s.parts.length; t++) {
    if (s.parts[t] !== part) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const d = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / d;
    const l2 = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / d;
    if (l1 >= -1e-9 && l2 >= -1e-9 && 1 - l1 - l2 >= -1e-9) return true;
  }
  return false;
}

describe("instance walkable grid and prebaked shell", () => {
  it("use the same cell size", () => assert.equal(CELL_M, DUNGEON_CELL));

  for (const theme of ["grim", "molten", "frost"]) {
    it(`agree on every cell (${theme}, with pools where the theme has them)`, () => {
      const d = generateDungeon({ seed: 77, rooms: 14, loopChance: 0.15, decorDensity: 0.6, theme }, BUILTIN_THEMES[theme]);
      const layout = readLayout(JSON.parse(JSON.stringify(encodeDungeon(d, dressDungeon(d, BUILTIN_DRESSING, 2)))));
      const shell = dungeonShell(d, geo);
      let walk = 0;
      for (let y = 0; y < d.height; y++) {
        for (let x = 0; x < d.width; x++) {
          const cx = (x + 0.5) * DUNGEON_CELL, cz = (y + 0.5) * DUNGEON_CELL;
          const drawn = hasSurface(shell, FLOOR, cx, cz) || hasSurface(shell, BASIN, cx, cz);
          assert.equal(walkableAt(layout, cx, cz), drawn, `cell ${x},${y}: walkable vs shell floor`);
          if (drawn) walk++;
        }
      }
      assert.ok(walk > 50);
    });
  }
});
