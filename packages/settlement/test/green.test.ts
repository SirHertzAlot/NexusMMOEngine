/**
 * Green squares in the settlement baker: sites lie inside them, a town is sized by the room its square leaves, and
 * too few farm plots cap the farms and food instead of failing the town.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, capDemand, fitHouseholds, selectSites, townHalfExtentM, type Demand, type TerrainFields } from "../src/index.js";

const N = 60;
const CELL = 20;

/** Flat plains all over, with two squares marked green: a big one and one too small for a town. */
function land(): TerrainFields {
  const height = new Float32Array(N * N).fill(20);
  const water = new Uint8Array(N * N);
  const biome = new Uint8Array(N * N).fill(1);
  // Sea down the east edge: towns want water in reach.
  for (let z = 0; z < N; z++) for (let x = 56; x < N; x++) {
    height[z * N + x] = -5;
    water[z * N + x] = 1;
    biome[z * N + x] = 0;
  }
  return {
    grid: { width: N, depth: N, cell: CELL, originX: 0, originZ: 0 },
    height,
    water,
    river: new Uint8Array(N * N),
    ice: new Uint8Array(N * N),
    biome,
    biomeIds: ["sea", "plains"],
    seaLevel: 0,
    squares: [{ cx: 5, cz: 5, cells: 30 }, { cx: 45, cz: 45, cells: 6 }],
  };
}

describe("sites in green squares", () => {
  const rules = { ...BUILTIN_RULES.sites, minPressurePermille: 1, minSpacingM: 0 };
  const sites = selectSites(land(), rules, 50, 100);

  it("lie inside a square, and say how much room it leaves", () => {
    assert.ok(sites.length > 0);
    for (const s of sites) {
      const cx = Math.round(s.x / CELL);
      const cz = Math.round(s.z / CELL);
      const inBig = cx >= 5 && cx < 35 && cz >= 5 && cz < 35;
      const inSmall = cx >= 45 && cx < 51 && cz >= 45 && cz < 51;
      assert.ok(inBig || inSmall, `(${cx}, ${cz}) is in a square`);
      assert.ok(s.fitM! > 0 && s.fitM! <= (inBig ? 15 : 3) * CELL, `fit ${s.fitM} m`);
    }
  });

  it("keep the whole footprint in the square where the square is big enough", () => {
    for (const s of sites.filter((x) => x.x < 700)) assert.ok(s.fitM! >= 100, `fit ${s.fitM} m for a 100 m footprint`);
  });

  it("rank a square the town fits in above one it does not", () => {
    assert.ok(sites[0]!.x < 700, "the big square's centre first");
  });
});

describe("fitHouseholds", () => {
  it("is the most households whose town fits, and never more than wanted", () => {
    for (const half of [60, 120, 200, 400]) {
      const n = fitHouseholds(1000, half, BUILTIN_RULES);
      if (n > 0) assert.ok(townHalfExtentM(n, BUILTIN_RULES) <= half, `${n} households fit ${half} m`);
      if (n < 1000) assert.ok(townHalfExtentM(n + 1, BUILTIN_RULES) > half, `${n + 1} households do not`);
    }
    assert.equal(fitHouseholds(5, 10_000, BUILTIN_RULES), 5);
    assert.ok(fitHouseholds(1000, 400, BUILTIN_RULES) >= fitHouseholds(1000, 200, BUILTIN_RULES), "a bigger square holds no fewer");
  });
});

describe("capDemand", () => {
  const demand: Demand = { foodDemand: 600, housingDemand: 100, laborPool: 300, required: { market: 2, farmstead: 8, master_farmstead: 2 }, max: {} };
  const parcels = [{ kind: "agriculture" }, { kind: "housing" }, { kind: "shopping" }];

  it("caps the farms and food to the farm plots there are, and says how much food is imported", () => {
    const { demand: capped, importedFood } = capDemand(demand, parcels, BUILTIN_RULES);
    assert.equal(capped.required.market, 2, "town needs stay");
    assert.ok(capped.required.farmstead! <= 1 && capped.required.master_farmstead! <= 1);
    assert.ok(capped.foodDemand < demand.foodDemand);
    assert.equal(importedFood, demand.foodDemand - capped.foodDemand);
  });

  it("leaves the demand alone when the plots are enough", () => {
    const plots = [...parcels, ...Array.from({ length: 30 }, () => ({ kind: "agriculture" }))];
    const { demand: capped, importedFood } = capDemand(demand, plots, BUILTIN_RULES);
    assert.deepEqual(capped, demand);
    assert.equal(importedFood, 0);
  });
});
