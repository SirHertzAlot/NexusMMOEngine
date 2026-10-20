/**
 * Sea level in placement: below the water is for aquatic content only. A land
 * layer (the default habitat) needs its ground a margin above the water
 * surface (the sea, or the lake's level); "shore" layers keep to their own band
 * round the water line; "water" layers (coral, kelp) are the only ones placed
 * below it, on the floor between their depths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LAND_MARGIN_M, landDry, surfaceAt } from "../../src/procgen/habitat.js";
import { parseEcologyPlan, planChunk, type EcologyContext, type EcologyPlan } from "../../src/procgen/ecology.js";

const SIDE = 16;
const W = 16;
const flat = (y: number): Float32Array => new Float32Array(SIDE * SIDE).fill(y);

const ctx = (ground: number, extra: Partial<EcologyContext> = {}): EcologyContext => ({ worldSeed: 1234n, cx: 0, cz: 0, heights: flat(ground), chunkWorldSize: W, ...extra });

const plan = (layers: unknown[]): EcologyPlan => parseEcologyPlan({ version: 1, name: "t", fields: {}, biomes: {}, layers });
const field = (id: string, extra: Record<string, unknown> = {}) => ({ id, place: { kind: "field", spacing: 4 }, chance: 1, assets: [{ asset: id, weight: 1 }], scale: [1, 1], ...extra });

describe("habitat: land stays above the water", () => {
  it("a land tree below sea level is not placed; the same tree on dry ground is", () => {
    const p = plan([field("tree")]);
    assert.equal(planChunk(p, ctx(-2, { seaLevel: 0 })).length, 0);
    assert.equal(planChunk(p, ctx(-2, { seaLevel: 0, waterAt: () => null })).length, 0, "even where the water lookup finds no water near");
    assert.equal(planChunk(p, ctx(5, { seaLevel: 0 })).length, 16);
  });

  it("a lake's level counts, not only the sea's", () => {
    const p = plan([field("tree")]);
    assert.equal(planChunk(p, ctx(40, { seaLevel: 0, waterAt: () => 41 })).length, 0);
    assert.equal(planChunk(p, ctx(40, { seaLevel: 0, waterAt: () => 20 })).length, 16);
  });

  it("the margin is exact: at the margin is placed, a hair under is not", () => {
    const p = plan([field("prop")]);
    assert.equal(planChunk(p, ctx(LAND_MARGIN_M, { seaLevel: 0 })).length, 16);
    assert.equal(planChunk(p, ctx(LAND_MARGIN_M - 0.01, { seaLevel: 0 })).length, 0);
    // The plan can ask for more (data).
    const wide = parseEcologyPlan({ version: 1, name: "t", fields: {}, biomes: {}, landMarginM: 1, layers: [field("prop")] });
    assert.equal(planChunk(wide, ctx(0.9, { seaLevel: 0 })).length, 0);
    assert.equal(planChunk(wide, ctx(1, { seaLevel: 0 })).length, 16);
  });

  it("satellite layers obey it too", () => {
    const p = plan([field("parent", { place: { kind: "field", spacing: 16 } }), { id: "kids", place: { kind: "around", parent: "parent", chance: 1, count: [3, 3], radius: [1, 2] }, assets: [{ asset: "k", weight: 1 }], scale: [1, 1] }]);
    assert.equal(planChunk(p, ctx(-3, { seaLevel: 0 })).length, 0);
  });
});

describe("habitat: shore and water", () => {
  it("a shore layer keeps to its band round the water line", () => {
    const p = plan([field("reed", { habitat: "shore", aboveWater: [-0.5, 0.5] })]);
    assert.equal(planChunk(p, ctx(0.2, { seaLevel: 0 })).length, 16);
    assert.equal(planChunk(p, ctx(-2, { seaLevel: 0 })).length, 0);
    assert.equal(planChunk(p, ctx(3, { seaLevel: 0 })).length, 0);
  });

  it("a coral at -2 m is placed on the sea floor; deeper or shallower than its range is not; a tree is not", () => {
    const p = plan([field("coral", { habitat: "water", aboveWater: [-6, -1] }), field("tree")]);
    const pts = planChunk(p, ctx(-2, { seaLevel: 0 }));
    assert.equal(pts.filter((q) => q.layer === "tree").length, 0);
    const coral = pts.filter((q) => q.layer === "coral");
    assert.equal(coral.length, 16);
    assert.ok(coral.every((q) => Math.abs(q.y + 2) < 1e-6), "on the floor, not on the surface");
    assert.equal(planChunk(p, ctx(-8, { seaLevel: 0 })).filter((q) => q.layer === "coral").length, 0, "too deep");
    assert.equal(planChunk(p, ctx(-0.5, { seaLevel: 0 })).filter((q) => q.layer === "coral").length, 0, "too shallow");
  });

  it("a water or shore layer without its band is refused when the plan loads", () => {
    assert.throws(() => plan([field("coral", { habitat: "water" })]), /coral.*depth range/);
    assert.throws(() => plan([field("coral", { habitat: "water", aboveWater: [-6, 1] })]), /coral.*below the water/);
    assert.throws(() => plan([field("reed", { habitat: "shore" })]), /reed.*aboveWater/);
    assert.throws(() => plan([field("x", { habitat: "sky" })]), /habitat/);
  });

  it("is deterministic: the same seed grows the same entities", () => {
    const p = plan([field("coral", { habitat: "water", aboveWater: [-6, -1], chance: 0.5 }), field("tree", { chance: 0.5 })]);
    assert.deepEqual(planChunk(p, ctx(-2, { seaLevel: 0 })), planChunk(p, ctx(-2, { seaLevel: 0 })));
  });
});

describe("habitat helpers", () => {
  it("the surface is the highest of the sea and the lookup; landDry wants the margin over it", () => {
    assert.equal(surfaceAt(undefined, 0, 1, 1), 0);
    assert.equal(surfaceAt(() => null, 0, 1, 1), 0);
    assert.equal(surfaceAt(() => 7, 0, 1, 1), 7);
    assert.equal(surfaceAt(undefined, undefined, 1, 1), null);
    assert.equal(landDry(1, null, 0.3), true, "no water anywhere");
    assert.equal(landDry(0.3, 0, 0.3), true);
    assert.equal(landDry(0.29, 0, 0.3), false);
  });
});
