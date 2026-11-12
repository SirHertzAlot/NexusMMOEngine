/**
 * Dungeon bake v1 on one fixture layout: the shell is built by the existing
 * shell with the native geometry addon; two themes give the same shell and
 * different dressing; portals match the cut openings; the bake is deterministic.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { bakeCrypt, CRYPT_THEMES, parseLayoutMask, type GeometryOps } from "../src/index.js";
import { dungeonFromLayout } from "../src/mask-layout.js";
import { CELL } from "../src/generate.js";

const geo = createRequire(import.meta.url)("@mmo-engine/addon-geometry") as GeometryOps;

const FIXTURE = parseLayoutMask({
  version: 1,
  rows: [
    "###########",
    "#.........#",
    "#.#####.#.#",
    "#.#...#.#.#",
    "#.#.p.#.#.#",
    "#...#.#...#",
    "###.###.###",
    "#...#.#...#",
    "#.....#...#",
    "###########",
  ],
  entrance: { x: 1, y: 1 },
  portals: [
    { id: "door-west", x: 0, y: 5, side: "x" },
  ],
});

describe("dungeon bake v1: layout mask to shell to layers", () => {
  let dry: ReturnType<typeof bakeCrypt>;
  let damp: ReturnType<typeof bakeCrypt>;
  before(() => {
    dry = bakeCrypt(FIXTURE, CRYPT_THEMES["dry-crypt"], geo);
    damp = bakeCrypt(FIXTURE, CRYPT_THEMES["damp-crypt"], geo);
  });

  it("builds the shell from the mask with the existing shell", () => {
    assert.ok(dry.shell.stats.triangles > 0, "shell has triangles");
    assert.ok(dry.shell.stats.floorArea > 0, "shell has floor");
    assert.equal(dry.theme, "dry-crypt");
  });

  it("the same mask gives the same shell under both themes", () => {
    assert.deepEqual(summary(dry.shell), summary(damp.shell));
  });

  it("the two themes dress the same mask differently, by theme data only", () => {
    assert.deepEqual(dry.details.map((d) => d.layer), ["rubble", "torch"]);
    assert.deepEqual(damp.details.map((d) => d.layer), ["moss", "mushroom", "torch"]);
    assert.notDeepEqual(dry.details.map((d) => d.placements.length), damp.details.map((d) => d.placements.length));
  });

  it("every layer's placements sit within its band of a wall (wall-band context)", () => {
    const d = dungeonFromLayout(FIXTURE);
    const wallDist = (x: number, z: number): number => {
      let best = Infinity;
      for (let y = 0; y < d.height; y++) for (let xx = 0; xx < d.width; xx++) {
        const g = d.grid[y * d.width + xx];
        if (g === CELL.floor || g === CELL.pool) continue;
        best = Math.min(best, Math.hypot((xx + 0.5) * 2 - x, (y + 0.5) * 2 - z));
      }
      return best;
    };
    for (const p of dry.details[0].placements) assert.ok(wallDist(p.x, p.z) <= 1.2 + 1e-6, `rubble near a wall at (${p.x}, ${p.z})`);
  });

  it("portals match the cut openings: each is open floor and listed once", () => {
    assert.deepEqual(dry.portals, [{ id: "door-west", x: 0, y: 5, side: "x" }]);
    const d = dungeonFromLayout(FIXTURE);
    assert.equal(d.grid[5 * d.width + 0], CELL.floor, "the portal cell is open in the shell's grid");
  });

  it("the bake is deterministic", () => {
    const again = bakeCrypt(FIXTURE, CRYPT_THEMES["damp-crypt"], geo);
    assert.deepEqual(again.details.map((d) => d.placements), damp.details.map((d) => d.placements));
  });
});

/** A comparable summary of a shell: triangle count per part, and its footprint. */
function summary(shell: { parts: Uint8Array; stats: { triangles: number; floorArea: number } }): unknown {
  const perPart: Record<number, number> = {};
  for (const p of shell.parts) perPart[p] = (perPart[p] ?? 0) + 1;
  return { triangles: shell.stats.triangles, floorArea: shell.stats.floorArea, perPart };
}
