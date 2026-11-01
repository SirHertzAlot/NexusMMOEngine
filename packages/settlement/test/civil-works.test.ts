/**
 * Civil works (SG2b stand-ins): a junction pad where three streets meet, earthwork against a street's grade line, and a
 * street's fall with its outlet at the lower end.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, civilWorks, generateSettlement, settlementScene, streetCivil, type SettlementRequest } from "../src/index.js";

const edge = { id: "e", from: "a", to: "b", widthMm: 4000 };

describe("civil works", () => {
  it("a level street has no earthwork, no fall, and needs a ditch", () => {
    const c = streetCivil(edge, [
      { x: 0, z: 0, h: 2 },
      { x: 1000, z: 0, h: 2 },
      { x: 2000, z: 0, h: 2 },
    ])!;
    assert.equal(c.fillM3, 0);
    assert.equal(c.cutM3, 0);
    assert.equal(c.gradePermille, 0);
    assert.equal(c.outlet, null);
    assert.equal(c.crownPermille, 20);
  });

  it("a bulge above its grade line is fill: the profile's area times the width", () => {
    // Heights 0, 1, 0 over 2 m: the profile is 1 m² above the line, and the street is 4 m wide.
    const c = streetCivil(edge, [
      { x: 0, z: 0, h: 0 },
      { x: 1000, z: 0, h: 1 },
      { x: 2000, z: 0, h: 0 },
    ])!;
    assert.ok(Math.abs(c.fillM3 - 4) < 1e-9, `fill ${c.fillM3}`);
    assert.equal(c.cutM3, 0);
  });

  it("a dip below its grade line is cut", () => {
    const c = streetCivil(edge, [
      { x: 0, z: 0, h: 0 },
      { x: 1000, z: 0, h: -1 },
      { x: 2000, z: 0, h: 0 },
    ])!;
    assert.ok(Math.abs(c.cutM3 - 4) < 1e-9, `cut ${c.cutM3}`);
    assert.equal(c.fillM3, 0);
  });

  it("a rising street drains to its start; a falling one to its end", () => {
    const up = streetCivil(edge, [
      { x: 0, z: 0, h: 0 },
      { x: 2000, z: 0, h: 1 },
    ])!;
    assert.equal(up.gradePermille, 500);
    assert.equal(up.outlet, "a");
    const down = streetCivil(edge, [
      { x: 0, z: 0, h: 1 },
      { x: 2000, z: 0, h: 0 },
    ])!;
    assert.equal(down.outlet, "b");
  });

  it("a junction pad sits where three or more paved streets meet, wide enough for the widest of them", () => {
    const manifest = {
      roads: {
        nodes: [
          { id: "hub", x: 0, z: 0 },
          { id: "p", x: 3000, z: 0 },
          { id: "q", x: -3000, z: 0 },
          { id: "r", x: 0, z: 3000 },
        ],
        edges: [
          { id: "e1", from: "hub", to: "p", roadClass: "street", widthMm: 6000, surface: "paved" },
          { id: "e2", from: "hub", to: "q", roadClass: "street", widthMm: 4000, surface: "paved" },
          { id: "e3", from: "hub", to: "r", roadClass: "street", widthMm: 4000, surface: "paved" },
          { id: "e4", from: "p", to: "q", roadClass: "street", widthMm: 4000, surface: "dirt" },
        ],
      },
    } as unknown as Parameters<typeof civilWorks>[0];
    const w = civilWorks(manifest);
    assert.equal(w.junctions.length, 1);
    assert.equal(w.junctions[0]!.nodeId, "hub");
    assert.equal(w.junctions[0]!.arms, 3);
    assert.ok(Math.abs(w.junctions[0]!.radiusM - (3 + 0.5)) < 1e-9, "widest arm 6 m: radius 3 m plus margin");
  });

  it("a town's totals add up its streets, and every routed street has a figure", () => {
    const origin: [number, number] = [100, 200];
    const bend = (from: [number, number], to: [number, number]) => [
      { x: from[0], z: from[1], h: 0 },
      { x: (from[0] + to[0]) / 2 + 0.003, z: (from[1] + to[1]) / 2, h: 0.5 },
      { x: to[0], z: to[1], h: 1 },
    ];
    const r = generateSettlement({ settlementId: "0182", seed: 1234, population: 600, site: { origin, dry: () => true, route: bend } });
    if (!r.ok) throw new Error("the town must generate");
    const w = civilWorks(r.manifest);
    const routed = r.manifest.roads.edges.filter((e) => e.surface === "paved" && e.path);
    assert.equal(w.streets.length, routed.length);
    assert.ok(Math.abs(w.totals.fillM3 - w.streets.reduce((t, s) => t + s.fillM3, 0)) < 1e-9);
    assert.ok(w.junctions.length > 0, "the town has junctions");
    assert.ok(w.junctions.every((j) => j.radiusM >= 0.5));
    void settlementScene(r.manifest, BUILTIN_RULES, { origin });
  });
});
