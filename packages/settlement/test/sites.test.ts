/**
 * Site selection (spec §9 to §10): where a settlement can stand, read from
 * the world bake's fields. The terrain here is small and made by hand, so
 * each test says exactly what the land is and what the selector should do
 * about it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, selectSites, type TerrainFields } from "../src/index.js";

const N = 40;
const CELL = 100;
const idx = (x: number, z: number): number => z * N + x;

/** Flat plains, a river down column 10, sea along the east edge, a steep ridge in the north-west corner. */
function land(): TerrainFields {
  const height = new Float32Array(N * N).fill(20);
  const water = new Uint8Array(N * N);
  const river = new Uint8Array(N * N);
  const biome = new Uint8Array(N * N).fill(1);
  for (let z = 0; z < N; z++) {
    river[idx(10, z)] = 1;
    for (let x = 36; x < N; x++) {
      water[idx(x, z)] = 1;
      height[idx(x, z)] = -5;
      biome[idx(x, z)] = 0;
    }
  }
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
    height[idx(x, z)] = 20 + (x + z) * 60;
    biome[idx(x, z)] = 2;
  }
  return { grid: { width: N, depth: N, cell: CELL, originX: 0, originZ: 0 }, height, water, river, ice: new Uint8Array(N * N), biome, biomeIds: ["sea", "plains", "mountains"], seaLevel: 0 };
}

const cellOf = (s: { x: number; z: number }): { cx: number; cz: number } => ({ cx: Math.round(s.x / CELL), cz: Math.round(s.z / CELL) });

describe("selectSites", () => {
  const t = land();
  const sites = selectSites(t, BUILTIN_RULES.sites, 6);

  it("finds sites on dry, flat, fertile ground and none on water, rivers or the ridge", () => {
    assert.ok(sites.length >= 3);
    for (const s of sites) {
      const { cx, cz } = cellOf(s);
      assert.equal(t.water[idx(cx, cz)], 0, "not in the sea");
      assert.equal(t.river[idx(cx, cz)], 0, "not on the river");
      assert.ok(!(cx < 8 && cz < 8), "not on the ridge");
      assert.ok(t.biomeIds[t.biome[idx(cx, cz)]!] === "plains");
    }
  });

  it("prefers land near water, but not on the bank", () => {
    const best = sites[0]!;
    assert.ok(best.waterDistanceM >= BUILTIN_RULES.sites.waterRangeM[0] && best.waterDistanceM <= BUILTIN_RULES.sites.waterRangeM[1] * 2, `water ${best.waterDistanceM} m`);
  });

  it("returns the best first, keeps the spacing, and never more than asked", () => {
    assert.ok(sites.length <= 6);
    for (let i = 1; i < sites.length; i++) assert.ok(sites[i - 1]!.pressurePermille >= sites[i]!.pressurePermille);
    for (const a of sites) for (const b of sites) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= BUILTIN_RULES.sites.minSpacingM);
  });

  it("is deterministic, and finds nothing on bare ice", () => {
    assert.deepEqual(selectSites(land(), BUILTIN_RULES.sites, 6), sites);
    const iced = land();
    iced.ice!.fill(1);
    assert.deepEqual(selectSites(iced, BUILTIN_RULES.sites, 6), []);
  });
});
