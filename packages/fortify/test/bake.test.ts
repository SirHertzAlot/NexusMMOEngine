/**
 * The bake chain: survey → adapter → fortify → emit → decorate, on a
 * synthetic survey shaped exactly like engine-core's. World-coordinate
 * correctness is the point: a placement must land where the tile is.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROFILES,
  DOCTRINES,
  decorateBake,
  emitSettlementBake,
  findSite,
  fortify,
  makeTransform,
  settlementFromSurvey,
  tileToWorld,
  tilesFromSurvey,
  type SurveyLike,
} from "../src/index.js";

/** 60×60 survey: a lake down the west side, flat land to the east. */
function fakeSurvey(): SurveyLike {
  const width = 60;
  const depth = 60;
  const n = width * depth;
  const height = new Float32Array(n).fill(12);
  const water = new Uint8Array(n); // 0 = LAND everywhere…
  const moisture = new Float32Array(n).fill(0.3);
  const roughness = new Float32Array(n).fill(0.2);
  const river = new Uint8Array(n);
  for (let y = 0; y < depth; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x < 18) {
        water[i] = 1; // SEA
        height[i] = 2;
      }
      if (x >= 18 && x < 24) moisture[i] = 0.85; // wet shore
    }
  }
  return { grid: { width, depth, cell: 16, originX: -480, originZ: -480 }, height, water, moisture, roughness, river, landCode: 0 };
}

describe("survey adapter", () => {
  it("finds a pond-side site: mostly land, water at its edge", () => {
    const s = fakeSurvey();
    const site = findSite(s, 25);
    assert.ok(site, "a site exists");
    assert.ok(site.score.landFraction >= 0.45, `land ${site.score.landFraction}`);
    assert.ok(site.score.waterAdjacent > 0, "water at the edge — the pond-village situation");
  });

  it("derives diggability and water table from the survey, not a fixture", () => {
    const s = fakeSurvey();
    const site = findSite(s, 25)!;
    const grid = tilesFromSurvey(s, site);
    // A cell over the lake is water; a far-inland dry cell has a deep table.
    let sawWater = false;
    let sawDeep = false;
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        const t = grid.tiles[y * grid.w + x];
        if (t.terrain === "water") sawWater = true;
        if (t.terrain === "land" && t.waterDepth > 5) sawDeep = true;
        if (t.terrain === "land") assert.ok(t.diggable, "soft lowland digs");
      }
    }
    assert.ok(sawWater && sawDeep);
  });

  it("a real water-table map overrides the derivation", () => {
    const s = fakeSurvey();
    s.waterTable = new Float32Array(60 * 60).fill(3.3);
    const site = findSite(s, 25)!;
    const grid = tilesFromSurvey(s, site);
    const land = grid.tiles.find((t) => t.terrain === "land" || t.terrain === "marsh");
    assert.ok(land);
    assert.ok(Math.abs(land.waterDepth - 3.3) < 1e-6, `waterDepth ${land.waterDepth} (float32 of 3.3)`);
  });

  it("tileToWorld puts tile centres at origin + (cell + 0.5) × cellSize", () => {
    const s = fakeSurvey();
    const site = findSite(s, 25)!;
    const t = makeTransform(s, site);
    const [wx, wz] = tileToWorld(t, 0, 0);
    assert.equal(wx, -480 + (site.u0 + 0.5) * 16);
    assert.equal(wz, -480 + (site.v0 + 0.5) * 16);
  });
});

describe("emit + decorate", () => {
  function baked() {
    const s = fakeSurvey();
    const site = findSite(s, 25)!;
    const settlement = settlementFromSurvey(s, site, "test-hamlet");
    const result = fortify(settlement, { budget: 40, seed: 5 });
    return emitSettlementBake(result.settlement, result, makeTransform(s, site));
  }

  it("emits wall polylines, towers, gate, keep — in world coordinates", () => {
    const bake = baked();
    const runs = bake.placements.filter((p) => p.kind === "wall-run");
    assert.equal(runs.length, 4, "one run per face");
    for (const r of runs) assert.ok((r.polyline?.length ?? 0) >= 10, "a run is a real polyline");
    for (const kind of ["tower", "gate", "keep"] as const) {
      const p = bake.placements.find((x) => x.kind === kind);
      assert.ok(p?.world, `${kind} has a world position`);
      const [wx, wz] = p.world!;
      assert.ok(wx >= -480 && wx <= 480 && wz >= -480 && wz <= 480, "inside the surveyed world");
    }
    assert.ok(bake.buildLog.length > 0, "the build log ships with the bake");
    assert.ok(bake.approach.polyline.length > 0, "the final approach ships as a polyline");
    assert.equal(bake.version, 1);
  });

  it("decoration attaches era materials: turf-and-timber at era 1, stone at era 2", () => {
    const e1 = decorateBake(baked(), DEFAULT_PROFILES.pondlands, 1);
    const wall1 = e1.placements.find((p) => p.kind === "wall-run")!;
    assert.equal(wall1.decoration?.material, "turf-and-timber");
    assert.equal(wall1.decoration?.heightM, 6);
    assert.deepEqual(wall1.decoration?.dressing, [], "walls take no dressing in this profile pass");
    const tower = e1.placements.find((p) => p.kind === "tower")!;
    assert.ok((tower.decoration?.dressing.length ?? 0) > 0, "towers take the profile dressing");

    const e2 = decorateBake(baked(), DEFAULT_PROFILES.pondlands, 2);
    assert.equal(e2.placements.find((p) => p.kind === "wall-run")!.decoration?.material, "stone");
  });

  it("a doctrine enters the build log as step 0, at no budget cost", () => {
    const s = fakeSurvey();
    const site = findSite(s, 25)!;
    const settlement = settlementFromSurvey(s, site, "doctrine-hamlet");
    const r = fortify(settlement, { budget: 40, seed: 5, doctrine: DOCTRINES.roman });
    const stamped = r.log.filter((l) => l.step === 0);
    assert.ok(stamped.length >= 2, `stamped: ${stamped.map((l) => l.counter).join(",")}`);
    assert.ok(stamped.every((l) => l.cost === 0));
    assert.equal(r.analysis.exposures.siege, 0, "the doctrine's well + granary are in from birth");
  });
});
