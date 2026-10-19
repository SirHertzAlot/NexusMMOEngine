/**
 * The places between the towns (SG7, SG8): routes, what stands along them, and the homesteads. The land is small and
 * made by hand: plains with a lake between the two towns, so a route has to walk round it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLACE_RULES, PlaceRulesSchema, planPlaces, type TerrainFields } from "../src/index.js";

const W = 240;
const D = 120;
const CELL = 25;
const idx = (x: number, z: number): number => z * W + x;

function land(): TerrainFields {
  const height = new Float32Array(W * D).fill(20);
  const water = new Uint8Array(W * D);
  const biome = new Uint8Array(W * D).fill(1);
  // A lake in the middle, 600 m across.
  for (let z = 36; z < 84; z++) for (let x = 108; x < 132; x++) {
    water[idx(x, z)] = 1;
    height[idx(x, z)] = -3;
    biome[idx(x, z)] = 0;
  }
  return { grid: { width: W, depth: D, cell: CELL, originX: 0, originZ: 0 }, height, water, river: new Uint8Array(W * D), ice: new Uint8Array(W * D), biome, biomeIds: ["sea", "plains"], seaLevel: 0 };
}

const towns = [
  { id: "0001", x: 600, z: 1500 },
  { id: "0002", x: 5400, z: 1500 },
];
const rules = PlaceRulesSchema.parse({ version: "places-rules/1", routes: {}, roadside: { outpostSpacingM: 1000, innSpacingM: 2000, innMinTownDistM: 500, shackSpacingM: 500, campSpacingM: 1200, campClearOfGuardM: 300 }, homesteads: { perTown: 4, spacingM: 400, townClearM: 400 } });
const t = land();
const plan = planPlaces({ towns, terrain: t, seed: 7, rules });
const wet = (x: number, z: number): boolean => Boolean(t.water[idx(Math.round(x / CELL), Math.round(z / CELL))]);
const d = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

describe("planPlaces", () => {
  it("joins the towns by a route that walks round the lake", () => {
    assert.equal(plan.routes.length, 1);
    const r = plan.routes[0]!;
    assert.deepEqual(r.points[0], [600, 1500]);
    assert.deepEqual(r.points[r.points.length - 1], [5400, 1500]);
    assert.ok(r.lengthM > 4800, "longer than the straight line, which crosses the lake");
    for (let i = 1; i < r.points.length; i++) {
      const [ax, az] = r.points[i - 1]!;
      const [bx, bz] = r.points[i]!;
      for (let k = 0; k <= 20; k++) assert.ok(!wet(ax + ((bx - ax) * k) / 20, az + ((bz - az) * k) / 20), "the route stays out of the water");
    }
  });

  it("stands every roadside place on dry ground, clear of the towns, on its route", () => {
    const side = plan.places.filter((p) => p.kind !== "homestead");
    assert.ok(side.length >= 5);
    for (const p of side) {
      assert.ok(!wet(p.x, p.z), `${p.id} is dry`);
      assert.ok(towns.every((tn) => d(p.x, p.z, tn.x, tn.z) >= rules.roadside.townClearM), `${p.id} clear of the towns`);
      assert.equal(p.route, plan.routes[0]!.id);
    }
    for (const kind of ["guard_outpost", "shack", "camp_site"] as const) assert.ok(plan.counts[kind] > 0, `some ${kind}`);
  });

  it("puts an inn only beside a guard outpost", () => {
    assert.ok(plan.counts.inn > 0);
    for (const inn of plan.places.filter((p) => p.kind === "inn")) {
      const o = plan.places.find((p) => p.id === inn.guardedBy);
      assert.equal(o?.kind, "guard_outpost");
      assert.ok(d(inn.x, inn.z, o!.x, o!.z) <= rules.roadside.innBesideOutpostM + 1);
    }
  });

  it("keeps camp sites clear of the guarded places", () => {
    for (const c of plan.places.filter((p) => p.kind === "camp_site")) {
      for (const g of plan.places.filter((p) => p.kind === "inn" || p.kind === "guard_outpost")) assert.ok(d(c.x, c.z, g.x, g.z) >= rules.roadside.campClearOfGuardM, `${c.id} away from ${g.id}`);
    }
  });

  it("places homesteads of two to ten people on dry farmland between the towns, spaced apart", () => {
    const homes = plan.places.filter((p) => p.kind === "homestead");
    assert.equal(homes.length, 8);
    for (const h of homes) {
      assert.ok(h.family! >= 2 && h.family! <= 10);
      assert.ok(h.works === "farm" || h.works === "ranch");
      assert.ok(!wet(h.x, h.z));
      assert.ok(towns.every((tn) => d(h.x, h.z, tn.x, tn.z) >= rules.homesteads.townClearM));
    }
    for (const a of homes) for (const b of homes) if (a !== b) assert.ok(d(a.x, a.z, b.x, b.z) >= rules.homesteads.spacingM);
  });

  it("is the same plan for the same seed and a different one for another", () => {
    assert.equal(planPlaces({ towns: [...towns].reverse(), terrain: t, seed: 7, rules }).hash, plan.hash);
    assert.notEqual(planPlaces({ towns, terrain: t, seed: 8, rules }).hash, plan.hash);
  });

  it("makes no routes or homesteads from a single town, and takes the defaults", () => {
    const one = planPlaces({ towns: [towns[0]!], terrain: t, seed: 7 });
    assert.equal(one.routes.length, 0);
    assert.equal(one.counts.homestead, 0);
    assert.equal(DEFAULT_PLACE_RULES.homesteads.familyMax, 10);
  });
});
