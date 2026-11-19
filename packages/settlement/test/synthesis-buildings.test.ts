import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScene } from "@mmo-engine/scene";
import {
  decomposeUnityScene,
  type CatalogModelBounds,
  type UnityRawNode,
} from "@mmo-engine/synthesis";
import { BUILTIN_RULES } from "../src/rules.js";
import { generateSettlement } from "../src/generate.js";
import { settlementScene } from "../src/scene.js";

function makeTestLibrary() {
  const catalog = new Map<string, CatalogModelBounds>();
  const reg = (id: string, min: [number, number, number], max: [number, number, number]) => {
    catalog.set(id, {
      partId: id,
      assetRef: `test-kit/${id}`,
      pack: "test-kit",
      catalogCategory: "Buildings",
      bounds: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    });
  };
  reg("Kit_Floor_01", [0, -0.07, 0], [2.5, 0.07, 2.5]);
  reg("Kit_Wall_01", [0, 0, -0.12], [2.5, 2.5, 0.12]);
  reg("Kit_Wall_Door_01", [0, 0, -0.15], [2.5, 2.5, 0.15]);
  reg("Kit_Roof_01", [0, 0, 0], [2.5, 1.2, 2.5]);
  reg("Kit_Prop_Table_01", [-0.7, 0, -0.5], [0.7, 0.8, 0.5]);
  reg("Kit_Prop_Chair_01", [-0.3, 0, -0.3], [0.3, 0.85, 0.3]);
  reg("Kit_Prop_Bar_01", [-0.9, 0, -0.45], [0.9, 1.05, 0.45]);

  const q0: [number, number, number, number] = [0, 0, 0, 1];
  const qNeg90: [number, number, number, number] = [0, -0.7071, 0, 0.7071];
  const n = (grp: string, partId: string, pos: [number, number, number], rot = q0): UnityRawNode => ({
    partId,
    name: partId,
    rootGroup: grp,
    groupPath: `${grp}/Interior`,
    isInteriorHint: true,
    transform: { pos, rot, scale: [1, 1, 1] },
  });

  const nodes: UnityRawNode[] = [
    n("Preset_House_A", "Kit_Floor_01", [0, 0, 0]),
    n("Preset_House_A", "Kit_Floor_01", [2.5, 0, 0]),
    n("Preset_House_A", "Kit_Wall_01", [0, 0, 0]),
    n("Preset_House_A", "Kit_Wall_01", [2.5, 0, 0]),
    n("Preset_House_A", "Kit_Wall_Door_01", [0, 0, 2.5]),
    n("Preset_House_A", "Kit_Wall_01", [2.5, 0, 2.5]),
    n("Preset_House_A", "Kit_Wall_01", [0, 0, 0], qNeg90),
    n("Preset_House_A", "Kit_Wall_01", [5, 0, 0], qNeg90),
    n("Preset_House_A", "Kit_Roof_01", [0, 2.5, 0]),
    n("Preset_House_A", "Kit_Prop_Table_01", [2.5, 0, 1.2]),
    n("Preset_House_A", "Kit_Prop_Chair_01", [2.5, 0, 0.6]),
    // A stray wall piece hanging in the air above the house, touching nothing.
    n("Preset_House_A", "Kit_Wall_01", [0, 9, 0]),

    n("Preset_Tavern_A", "Kit_Floor_01", [20, 0, 0]),
    n("Preset_Tavern_A", "Kit_Floor_01", [22.5, 0, 0]),
    n("Preset_Tavern_A", "Kit_Wall_01", [20, 0, 0]),
    n("Preset_Tavern_A", "Kit_Wall_01", [22.5, 0, 0]),
    n("Preset_Tavern_A", "Kit_Wall_Door_01", [20, 0, 2.5]),
    n("Preset_Tavern_A", "Kit_Wall_01", [22.5, 0, 2.5]),
    n("Preset_Tavern_A", "Kit_Wall_01", [20, 0, 0], qNeg90),
    n("Preset_Tavern_A", "Kit_Wall_01", [25, 0, 0], qNeg90),
    n("Preset_Tavern_A", "Kit_Roof_01", [20, 2.5, 0]),
    n("Preset_Tavern_A", "Kit_Prop_Bar_01", [22.5, 0, 1.1]),
  ];
  return decomposeUnityScene(nodes, { family: "test-kit", assetPrefix: "test-kit", catalogBounds: catalog });
}

describe("settlementScene with Unity DecompositionLibrary", () => {
  it("replaces solid structure boxes with enterable modular building groups while keeping openGround untouched", () => {
    const res = generateSettlement({ settlementId: "syn-01", seed: 42, population: 120, rules: BUILTIN_RULES });
    assert.equal(res.ok, true);
    const lib = makeTestLibrary();
    const doc = settlementScene(res.manifest, BUILTIN_RULES, { origin: [0, 0], synthesis: lib });

    assert.deepEqual(validateScene(doc), []);
    const groupNodes = doc.nodes[0]!.children ?? [];
    const modularBuildings = groupNodes.filter((n) => n.kind === "group" && n.name?.startsWith("building:"));
    assert.ok(modularBuildings.length > 0, "at least one building synthesized as a modular group");

    const sample = modularBuildings[0]!;
    const kids = sample.children ?? [];
    assert.ok(kids.some((c) => c.components?.Structure && c.components?.Collider?.shape === "none"), "visual meshes have Collider: none");
    assert.ok(kids.some((c) => c.prefab === "collider" && c.components?.Collider?.shape === "box"), "invisible box colliders attached");
  });

  it("bakes no building part that touches nothing or hangs in the air", () => {
    const res = generateSettlement({ settlementId: "syn-01", seed: 42, population: 120, rules: BUILTIN_RULES });
    assert.equal(res.ok, true);
    const doc = settlementScene(res.manifest, BUILTIN_RULES, { origin: [0, 0], synthesis: makeTestLibrary() });
    const houses = (doc.nodes[0]!.children ?? []).filter((n) => n.name?.startsWith("building:"));
    assert.ok(houses.length > 0);
    for (const h of houses) {
      const high = (h.children ?? []).filter((c) => (c.transform?.position?.[1] ?? 0) > 8);
      assert.deepEqual(high.map((c) => c.id), [], `${h.id}: the stray wall and its collider are gone`);
    }
  });
});
