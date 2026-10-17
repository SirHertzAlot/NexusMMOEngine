/**
 * Buildings at architectural scale: a storey is 1.5x the 1.8 m human (2.7 m), the
 * ground ceiling is 8 ft, every floor adds a storey, tall halls set their own
 * storey; and the per-model fit brings art to that height without overflowing a parcel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCALE, resolveScale } from "@mmo-engine/scene";
import { BUILTIN_RULES, SettlementRulesSchema, buildingHeightM, fitScale, scaleReport, settlementScene, generateSettlement, type CatalogModel } from "../src/index.js";

const A = BUILTIN_RULES.architecture;

describe("architecture rules", () => {
  it("carries the human, storey, ground ceiling and roof", () => {
    assert.equal(A.characterM, 1.8);
    assert.equal(A.storeyM, 2.7);
    assert.equal(A.groundCeilingM, 2.44);
    assert.ok(A.roofM > 0);
    assert.ok(Math.abs(A.storeyM / A.characterM - 1.5) < 1e-9);
  });
  it("buildingHeightM = ground storey + (floors-1) storeys + roof", () => {
    const base = { kinds: ["housing"], weight: 1, households: 1, workers: 0, feeds: 0, role: "", shop: false } as const;
    assert.equal(buildingHeightM({ ...base, floors: 1 }, A), A.groundCeilingM + A.roofM);
    assert.ok(Math.abs(buildingHeightM({ ...base, floors: 2 }, A) - (A.groundCeilingM + A.storeyM + A.roofM)) < 1e-9);
    // a storey override makes every storey that tall, ground included
    assert.ok(Math.abs(buildingHeightM({ ...base, floors: 2, storeyM: 6 }, A) - (6 + 6 + A.roofM)) < 1e-9);
  });
  it("a two-storey house is about 5.1 m of walls plus roof, not 5 m flat", () => {
    const h = buildingHeightM(BUILTIN_RULES.archetypes.house!, A);
    assert.ok(h > 6.5 && h < 8, String(h));
  });
  it("every archetype has floors, halls are tall, and the schema rejects floors 0, the old heightM and a missing architecture", () => {
    const ar = BUILTIN_RULES.archetypes;
    for (const a of Object.values(ar)) assert.ok(Number.isInteger(a.floors) && a.floors >= 1);
    assert.equal(ar.house!.floors, 2);
    assert.equal(ar.mill!.floors, 3);
    assert.ok(buildingHeightM(ar.chapel!, A) >= 8);
    const ok = (mut: (r: any) => void) => {
      const r = structuredClone(BUILTIN_RULES) as any;
      mut(r);
      return SettlementRulesSchema.safeParse(r).success;
    };
    assert.equal(ok(() => {}), true);
    assert.equal(ok((r) => (r.archetypes.house.floors = 0)), false);
    assert.equal(ok((r) => (r.archetypes.house.heightM = 5)), false);
    assert.equal(ok((r) => delete r.architecture), false);
  });
  it("the scene's Structure height is the architectural height", () => {
    const r = generateSettlement({ settlementId: "0182", seed: 1234, population: 300 });
    if (!r.ok) throw new Error(r.error.message);
    for (const n of settlementScene(r.manifest, BUILTIN_RULES, { origin: [0, 0] }).nodes[0]!.children!) {
      const c = n.components!.Structure!;
      const a = BUILTIN_RULES.archetypes[c.kind as string];
      if (a) assert.equal(c.height, buildingHeightM(a, A));
      else assert.ok(["town_wall", "wall_tower", "town_gate"].includes(c.kind as string), `${String(c.kind)} is a building or a wall piece`);
    }
  });
});

describe("fitScale", () => {
  const models: CatalogModel[] = [
    { id: "p/Tall_House", name: "Tall_House", skinned: false, size: [6, 13, 6] }, // height-limited
    { id: "p/Wide_House", name: "Wide_House", skinned: false, size: [40, 8, 10] }, // footprint-limited
    { id: "p/Mini_House", name: "Mini_House", skinned: false, size: [3, 3, 3] }, // grows to full height
    { id: "p/Flat_Shed", name: "Flat_Shed", skinned: false }, // no size: skipped
    { id: "p/Hall", name: "Hall", skinned: false, size: [8, 10, 8] },
  ];
  const patterns = { house: ["_House$"], chapel: ["^Hall$"], tavern: ["_Shed$"] };
  const house = buildingHeightM(BUILTIN_RULES.archetypes.house!, A);
  const chapel = buildingHeightM(BUILTIN_RULES.archetypes.chapel!, A);

  it("brings each model to its archetype's height, or as far as the parcel allows", () => {
    const doc = fitScale(models, patterns, BUILTIN_RULES);
    assert.equal(doc.version, 1);
    assert.ok(Math.abs(13 * doc.assets["p/Tall_House"]! - house) < 1e-3);
    assert.ok(Math.abs(3 * doc.assets["p/Mini_House"]! - house) < 1e-3);
    const wide = doc.assets["p/Wide_House"]!;
    assert.ok(8 * wide < house, "limited by the footprint");
    assert.ok(40 * wide <= 12 - 2 + 1e-9);
    assert.ok(!("p/Flat_Shed" in doc.assets));
    assert.ok(Math.abs(10 * doc.assets["p/Hall"]! - chapel) < 1e-3);
  });
  it("is relative to the building factor already in the doc", () => {
    const base = { ...DEFAULT_SCALE, categories: { building: 0.5 } };
    const doc = fitScale(models, patterns, BUILTIN_RULES, base);
    // the parcel halves too, so the tall house still reaches its height? no: 6 m wide x 0.5 fits a 6 m parcel
    assert.ok(Math.abs(13 * resolveScale(doc, "building", "p/Tall_House") - house) < 1e-3);
    assert.deepEqual(doc.categories, { building: 0.5 });
  });
  it("brings a wall model to the wall's height within its piece, and a gate within its opening", () => {
    const walls: CatalogModel[] = [
      { id: "p/Castle_Wall_01", name: "Castle_Wall_01", skinned: false, size: [3, 3, 1] },
      { id: "p/Castle_Gate_01", name: "Castle_Gate_01", skinned: false, size: [20, 8, 3] },
    ];
    const doc = fitScale(walls, { town_wall: ["_Wall_"], town_gate: ["_Gate_"] }, BUILTIN_RULES);
    const F = BUILTIN_RULES.fortification;
    assert.ok(Math.abs(3 * doc.assets["p/Castle_Wall_01"]! - F.heightM) < 1e-3, "a short wall model grows to the wall's height");
    assert.ok(3 * doc.assets["p/Castle_Wall_01"]! <= F.pieceMm / 1000 + 1e-9, "and still fits its piece");
    const gate = doc.assets["p/Castle_Gate_01"]!;
    assert.ok(20 * gate <= (BUILTIN_RULES.layout.streetWidthMm + 2000) / 1000 + 1e-9, "a wide gate model shrinks to the opening");
    assert.equal(scaleReport(walls, { town_wall: ["_Wall_"], town_gate: ["_Gate_"] }, doc, BUILTIN_RULES).filter((r) => r.overflow).length, 0);
  });
  it("leaves the report with 0 overflows", () => {
    for (const bf of [1, 0.5, 2]) {
      const base = { ...DEFAULT_SCALE, categories: { building: bf } };
      const doc = fitScale(models, patterns, BUILTIN_RULES, base);
      const rows = scaleReport(models, patterns, doc, BUILTIN_RULES);
      assert.ok(rows.length >= 4);
      assert.equal(rows.filter((r) => r.overflow).length, 0);
    }
  });
});
