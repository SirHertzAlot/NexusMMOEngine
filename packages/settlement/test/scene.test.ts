/**
 * A baked settlement as a scene: one group at the chosen origin with a
 * Structure node per structure, so the server's scene spawner can put the
 * town in the world. The scene is plain data the editor can open.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScene, worldNodes } from "@mmo-engine/scene";
import { BUILTIN_RULES, generateSettlement, PROP_KINDS, settlementScene } from "../src/index.js";

const r = generateSettlement({ settlementId: "0182", seed: 1234, population: 600 });
if (!r.ok) throw new Error(r.error.message);
const manifest = r.manifest;

describe("settlementScene", () => {
  const scene = settlementScene(manifest, BUILTIN_RULES, { origin: [100, 200] });

  it("is a valid world scene named for the settlement, with a node per structure under one group", () => {
    assert.deepEqual(validateScene(scene), []);
    assert.equal(scene.name, "settlement-0182");
    assert.equal(scene.kind, "world");
    assert.equal(scene.nodes.length, 1);
    const steps = manifest.props.filter((p) => p.kind === "stairs").reduce((a, p) => a + p.sizeMm[1] / BUILTIN_RULES.props!.terraces.stepTreadMm, 0);
    const props = manifest.props.filter((p) => p.kind !== "stairs").length + steps;
    const paved = manifest.roads.edges.filter((e) => e.surface === "paved").length;
    assert.equal(scene.nodes[0]!.children!.length, manifest.structures.length + manifest.fortifications.length + 2 + manifest.parcels.filter((p) => p.holding).length + paved + props, "buildings, wall pieces, the square and its well, the farms' fields, the paved streets, the props (a node per step)");
  });

  it("paves the town square (walk-through) with a well at its centre, clear of every building", () => {
    const kids = scene.nodes[0]!.children!;
    const square = kids.find((n) => n.components!.Structure!.kind === "town_square")!;
    const well = kids.find((n) => n.components!.Structure!.kind === "town_well")!;
    assert.equal(square.components!.Collider?.shape, "none");
    assert.deepEqual(well.transform!.position, square.transform!.position);
    assert.equal(well.components!.Collider, undefined, "the well blocks");
    const [sq] = boxes((k) => k === "town_square");
    for (const b of boxes((k) => !isWall(k) && !isSquare(k) && !isProp(k) && k !== "town_well")) assert.ok(gapOf(sq!, b) > 1, `${b.id} stands on the square`);
  });

  it("gives each structure its kind and a footprint that fits inside its parcel", () => {
    const [pw, pd] = BUILTIN_RULES.layout.parcelSizeMm;
    const byId = new Map(manifest.structures.map((s) => [s.id, s]));
    for (const n of scene.nodes[0]!.children!.filter((k) => byId.has(k.id))) {
      const c = n.components!.Structure!;
      assert.equal(c.kind, byId.get(n.id)!.archetype);
      assert.ok((c.width as number) < pw / 1000 && (c.depth as number) < pd / 1000);
      assert.ok((c.height as number) > 0);
    }
  });

  // A footprint's half extents along world x and z: a node turned a quarter has its width along z.
  const boxes = (filter: (kind: string) => boolean) =>
    worldNodes(scene)
      .filter((w) => w.node.components?.Structure && filter(w.node.components.Structure.kind as string))
      .map((w) => {
        const s = w.node.components!.Structure!;
        const across = Math.round(w.yawDeg) % 180 !== 0;
        const [hw, hd] = [(s.width as number) / 2, (s.depth as number) / 2];
        return { id: w.node.id, kind: s.kind as string, x: w.position[0], z: w.position[2], hw: across ? hd : hw, hd: across ? hw : hd };
      });
  const isWall = (k: string) => ["town_wall", "wall_tower", "town_gate"].includes(k);
  // Ground layers: the square's paving and the farms' fields (each farmstead stands in its own).
  const isSquare = (k: string) => k === "town_square" || k === "farm_field";
  // Street furniture, paving, terraces and steps: they stand in the streets, on the square and at the doors (the props gate keeps them clear).
  const isProp = (k: string) => (PROP_KINDS as readonly string[]).includes(k) || ["paved_road", "terrace", "stair_step"].includes(k);
  const gapOf = (a: { x: number; z: number; hw: number; hd: number }, b: typeof a) => Math.max(Math.abs(a.x - b.x) - a.hw - b.hw, Math.abs(a.z - b.z) - a.hd - b.hd);

  it("leaves a walkable street between buildings and never overlaps two footprints", () => {
    const CAPSULE_WIDTH_M = 0.7; // CHARACTER_CAPSULE.radius * 2 (engine-core)
    const box = boxes((k) => !isWall(k) && !isSquare(k) && !isProp(k));
    let minGap = Infinity;
    for (let i = 0; i < box.length; i++) {
      for (let j = i + 1; j < box.length; j++) {
        const gap = gapOf(box[i]!, box[j]!);
        assert.ok(gap > 0, `${box[i]!.id} and ${box[j]!.id} overlap (${gap} m)`);
        minGap = Math.min(minGap, gap);
      }
    }
    assert.ok(minGap >= CAPSULE_WIDTH_M, `the narrowest street is ${minGap} m, a character is ${CAPSULE_WIDTH_M} m wide`);
  });

  it("turns every building to face its street", () => {
    const parcels = new Map(manifest.parcels.map((p) => [p.id, p]));
    const structures = new Map(manifest.structures.map((s) => [s.id, s]));
    for (const n of scene.nodes[0]!.children!) {
      const s = structures.get(n.id);
      if (s) assert.equal(n.transform!.rotation![1], parcels.get(s.parcel)!.facing, n.id);
    }
  });

  it("builds the wall from Structure nodes: wall pieces, towers, and walk-through gates, clear of every building", () => {
    const kids = scene.nodes[0]!.children!;
    const walls = kids.filter((n) => isWall(n.components!.Structure!.kind as string));
    assert.equal(walls.length, manifest.fortifications.length);
    assert.ok(walls.length > 0, "a town of 600 is walled");
    for (const n of walls) {
      const kind = n.components!.Structure!.kind as string;
      assert.equal(n.components!.Collider?.shape === "none", kind === "town_gate", `${n.id}: only a gate is walk-through`);
      assert.equal(n.components!.Structure!.height, { town_wall: BUILTIN_RULES.fortification.heightM, wall_tower: BUILTIN_RULES.fortification.towerHeightM, town_gate: BUILTIN_RULES.fortification.gateHeightM }[kind]);
    }
    const buildings = boxes((k) => !isWall(k) && !isSquare(k) && !isProp(k));
    for (const w of boxes(isWall)) for (const b of buildings) assert.ok(gapOf(w, b) > 1, `${w.id} touches ${b.id}`);
  });

  it("centres the town on the origin, in metres", () => {
    const at = worldNodes(scene).filter((w) => w.node.components?.Structure && w.node.components.Structure.kind !== "town_well" && !isProp(w.node.components.Structure.kind as string));
    const mean = (f: (p: number[]) => number): number => at.reduce((a, w) => a + f(w.position), 0) / at.length;
    assert.ok(Math.abs(mean((p) => p[0]!) - 100) < 40, "x centred near 100");
    assert.ok(Math.abs(mean((p) => p[2]!) - 200) < 40, "z centred near 200");
    assert.equal(new Set(at.map((w) => `${w.position[0]},${w.position[2]}`)).size, at.length, "no two on the same spot");
  });

  it("paves the streets (walk-through), raises the grand buildings on terraces with steps up, and keeps the props clear of the buildings", () => {
    const kids = scene.nodes[0]!.children!;
    const paving = kids.filter((n) => n.components!.Structure!.kind === "paved_road");
    assert.ok(paving.length > 0, "a walled town's streets are paved");
    for (const n of paving) assert.equal(n.components!.Collider?.shape, "none", `${n.id} is walked on`);
    const t = BUILTIN_RULES.props!.terraces;
    const terraces = manifest.props.filter((p) => p.kind === "terrace");
    assert.ok(terraces.length > 0, "the town hall and the church stand on terraces");
    const byParcel = new Map(manifest.structures.map((s) => [s.parcel, s.id]));
    for (const p of terraces) {
      const building = kids.find((n) => n.id === byParcel.get(p.parcel!))!;
      assert.equal(building.transform!.position![1], t.heightMm / 1000, `${building.id} stands on its terrace`);
      const steps = kids.filter((n) => n.id.startsWith(`${manifest.props.find((q) => q.kind === "stairs" && q.parcel === p.parcel)!.id}-step`));
      assert.equal(steps.length, Math.ceil(t.heightMm / t.stepRiseMm) - 1, "a flight of steps, the terrace the top one");
      const heights = steps.map((n) => n.components!.Structure!.height as number);
      assert.ok(heights.every((h, i) => i === 0 || h < heights[i - 1]!), "each step lower than the one before it, going out");
      assert.ok(heights.every((h) => h < t.heightMm / 1000));
    }
    const gate = manifest.validation.find((g) => g.gate === "props")!;
    assert.ok(gate.ok, gate.detail);
    const buildings = boxes((k) => !isWall(k) && !isSquare(k) && !isProp(k) && k !== "park" && k !== "empty_lot");
    for (const p of boxes((k) => (PROP_KINDS as readonly string[]).includes(k) || k === "stair_step")) for (const b of buildings) assert.ok(gapOf(p, b) >= 0, `${p.id} stands in ${b.id}`);
  });

  it("is the same document for the same settlement", () => {
    assert.deepEqual(settlementScene(manifest, BUILTIN_RULES, { origin: [100, 200] }), scene);
  });

  it("refuses an id a scene cannot be named for", () => {
    const bad = generateSettlement({ settlementId: "Keep One", seed: 1, population: 600 });
    assert.ok(bad.ok);
    assert.throws(() => settlementScene(bad.manifest, BUILTIN_RULES, { origin: [0, 0] }), /name/);
  });

  it("names an art model per structure when given a map, picking among a kind's models by the structure's id", () => {
    const art = { house: ["pack/House_A", "pack/House_B"], smithy: ["pack/Smithy_01"] };
    const withArt = settlementScene(manifest, BUILTIN_RULES, { origin: [100, 200], art });
    const kids = withArt.nodes[0]!.children!;
    for (const n of kids) {
      const c = n.components!.Structure!;
      const models = (art as Record<string, string[]>)[c.kind as string];
      if (models) assert.ok(models.includes(c.asset as string), `${c.kind} -> ${String(c.asset)}`);
      else assert.equal(c.asset, "", `${c.kind} has no model, so it stays a box`);
    }
    const houses = kids.filter((n) => n.components!.Structure!.kind === "house").map((n) => n.components!.Structure!.asset);
    assert.ok(houses.includes("pack/House_A") && houses.includes("pack/House_B"), "variants are used");
    assert.deepEqual(settlementScene(manifest, BUILTIN_RULES, { origin: [100, 200], art }), withArt, "the same pick every time");
  });
});
