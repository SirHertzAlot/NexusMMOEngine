/**
 * The scene pass: open ground loses its house parts, a building keeps its connected parts, colliders follow, and the
 * closure is reported.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SceneDoc, SceneNode } from "@mmo-engine/scene";
import { categoryOf, checkSettlementScene } from "../src/scene-check.js";

const vis = (g: string, n: number, asset: string, x: number, y: number, z: number, w: number, h: number, d: number): SceneNode[] => [
  { id: `${g}-vis-${n}`, name: asset, transform: { position: [x, y, z], rotation: [0, 0, 0] }, components: { Structure: { kind: "structure", asset: `p/${asset}`, width: w, depth: d, height: h } } },
  { id: `${g}-p${n}-col`, transform: { position: [x, y, z], rotation: [0, 0, 0] }, components: {} },
];
const group = (id: string, kind: string, kids: SceneNode[]): SceneNode => ({ id, name: `building:${kind}`, transform: { position: [0, 0, 0] }, children: kids });
const doc = (...g: SceneNode[]): SceneDoc => ({ version: 1, name: "t", kind: "world", nodes: [{ id: "root", name: "root", transform: { position: [0, 0, 0] }, children: g }] });

/** A closed 8 x 8 house: four walls, a floor, a roof. */
const house = (g: string): SceneNode[] => [
  ...vis(g, 0, "SM_Bld_Floor_01", 0, 0.1, 0, 8, 0.2, 8),
  ...vis(g, 1, "SM_Bld_Wall_01", 0, 1.2, 4, 8, 2, 0.2),
  ...vis(g, 2, "SM_Bld_Wall_01", 0, 1.2, -4, 8, 2, 0.2),
  ...vis(g, 3, "SM_Bld_Wall_02", 4, 1.2, 0, 0.2, 2, 8),
  ...vis(g, 4, "SM_Bld_Wall_02", -4, 1.2, 0, 0.2, 2, 8),
  ...vis(g, 5, "SM_Bld_Roof_01", 0, 2.4, 0, 8, 0.4, 8),
];

describe("categoryOf", () => {
  it("reads the part's role from its model name", () => {
    assert.equal(categoryOf("fantasy-kingdom/SM_Bld_House_Wall_Window_01"), "wall");
    assert.equal(categoryOf("x/SM_Bld_House_Roof_02"), "roof");
    assert.equal(categoryOf("x/SM_Bld_House_Base_Corner_02"), "floor");
    assert.equal(categoryOf("x/SM_Bld_House_Base_Wall_01"), "wall");
    assert.equal(categoryOf("x/SM_Bld_House_Roof_Tile_Window_01"), "roof");
    assert.equal(categoryOf("x/Thing"), "part");
  });
});

describe("checkSettlementScene", () => {
  it("strips the house parts an open-ground parcel was handed, colliders with them, and leaves a real building alone", () => {
    const s = doc(group("g0", "garden", house("g0")), group("h0", "house", house("h0")), group("c0", "churchyard", house("c0")));
    const { scene, report } = checkSettlementScene(s);
    const kids = (id: string) => scene.nodes[0]!.children!.find((c) => c.id === id)!.children!.length;
    assert.equal(kids("g0"), 0);
    assert.equal(kids("c0"), 0);
    assert.equal(kids("h0"), 12, "6 parts and 6 colliders, untouched");
    assert.equal(report.totals.openWithParts, 2);
    assert.equal(report.totals.closed, 1);
    assert.equal(report.buildings.find((b) => b.id === "h0")!.closed, true);
    assert.equal(s.nodes[0]!.children![0]!.children!.length, 12, "the input is not modified");
  });

  it("prunes a stray and a floating group with their colliders, and reports a missing wall", () => {
    const stray = vis("h1", 6, "SM_Bld_Wall_01", 40, 1.2, 40, 4, 2, 0.2);
    const floating = [...vis("h1", 7, "SM_Bld_Wall_01", 20, 9, 20, 4, 2, 0.2), ...vis("h1", 8, "SM_Bld_Wall_01", 24, 9, 20, 4, 2, 0.2), ...vis("h1", 9, "SM_Bld_Wall_01", 28, 9, 20, 4, 2, 0.2)];
    const noWest = house("h1").filter((n) => !n.id.includes("-vis-4") && !n.id.includes("-p4-col"));
    const { scene, report } = checkSettlementScene(doc(group("h1", "house", [...noWest, ...stray, ...floating])));
    const ids = scene.nodes[0]!.children![0]!.children!.map((c) => c.id);
    assert.ok(!ids.some((i) => /-vis-(6|7|8|9)$|-p(6|7|8|9)-col$/.test(i)), "stray and floating parts and their colliders are gone");
    const b = report.buildings[0]!;
    assert.deepEqual([b.removed.isolated, b.removed.floating], [1, 3]);
    assert.deepEqual(b.missing, ["west wall"]);
    assert.equal(report.missingCounts["west wall"], 1);
  });

  it("can keep open-ground parts when asked", () => {
    const { scene } = checkSettlementScene(doc(group("g0", "garden", house("g0"))), { stripOpen: false });
    assert.equal(scene.nodes[0]!.children![0]!.children!.length, 12);
  });
});

describe("part pivots", () => {
  // Three parts whose nodes sit far apart but whose models (centre offsets from the pivot) make one connected block.
  const withCentre = (id: string, x: number, cx: number): SceneNode => ({
    id,
    name: "p",
    transform: { position: [x, 0, 0], rotation: [0, 0, 0] },
    components: { Structure: { kind: "wall", asset: "p/SM_Bld_Wall_01", width: 2, depth: 2, height: 2, centreX: cx, centreY: 1, centreZ: 0 } },
  });
  it("judges parts by where their models are, not where their pivots are", () => {
    // Pivots at x 0, 10, 20; the models' middles are 5 m, 0 m and -5 m from them: 5, 10, 15 are 5 apart (detached),
    // so use offsets 5 / 0 / -5 on pivots 3 / 8 / 13 -> middles at 8 each: one stack.
    const g = group("g", "house", [withCentre("g-vis-0", 3, 5), withCentre("g-vis-1", 8, 0), withCentre("g-vis-2", 13, -5)]);
    const r = checkSettlementScene(doc(g));
    assert.equal(r.report.buildings[0]!.removed.isolated + r.report.buildings[0]!.removed.smallGroup, 0);
    assert.equal(r.scene.nodes[0]!.children![0]!.children!.length, 3);
  });
  it("without the offsets the same pivots are three detached parts", () => {
    const g = group("g", "house", [withCentre("g-vis-0", 3, 0), withCentre("g-vis-1", 8, 0), withCentre("g-vis-2", 13, 0)]);
    const r = checkSettlementScene(doc(g));
    assert.ok(r.report.buildings[0]!.removed.isolated > 0);
  });
});
