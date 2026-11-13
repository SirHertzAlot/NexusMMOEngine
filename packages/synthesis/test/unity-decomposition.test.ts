import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateScene } from "@mmo-engine/scene";
import {
  boundsCenter,
  buildingToSceneNodes,
  decomposeUnityScene,
  extractLearnedRuleSet,
  extractUnitySceneNodes,
  generatePartSockets,
  readGlbPivotBounds,
  synthesisToScene,
  synthesizeBuilding,
  unityTrsToEngine,
  type CatalogModelBounds,
  type PlacedPartInstance,
  type UnityPackageIndex,
  type UnityRawNode,
} from "../src/index.js";

function makeMinimalGlb(min: [number, number, number], max: [number, number, number]): Buffer {
  const gltf = {
    asset: { version: "2.0" },
    nodes: [{ name: "MeshNode", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min, max, count: 8, type: "VEC3", componentType: 5126 }],
  };
  const jsonText = JSON.stringify(gltf);
  const pad = (4 - (Buffer.byteLength(jsonText) % 4)) % 4;
  const jsonBuf = Buffer.from(jsonText + " ".repeat(pad), "utf8");
  const totalLen = 12 + 8 + jsonBuf.byteLength;
  const glb = Buffer.alloc(totalLen);
  glb.writeUInt32LE(0x46546c67, 0); // glTF
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLen, 8);
  glb.writeUInt32LE(jsonBuf.byteLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16); // JSON
  jsonBuf.copy(glb, 20);
  return glb;
}

function makeCornerWallBounds(): CatalogModelBounds["bounds"] {
  return { min: [0, 0, -0.12], max: [2.5, 2.5, 0.12], size: [2.5, 2.5, 0.24] };
}

function makeFloorBounds(): CatalogModelBounds["bounds"] {
  return { min: [0, -0.075, 0], max: [2.5, 0.075, 2.5], size: [2.5, 0.15, 2.5] };
}

function makeStairBounds(): CatalogModelBounds["bounds"] {
  return { min: [-1.25, 0, -2.5], max: [1.25, 2.5, 0], size: [2.5, 2.5, 2.5] };
}

function makeSyntheticCatalog(): Map<string, CatalogModelBounds> {
  const map = new Map<string, CatalogModelBounds>();
  const reg = (partId: string, bounds: CatalogModelBounds["bounds"], cat = "Buildings") => {
    map.set(partId, {
      partId,
      assetRef: `test-kit/${partId}`,
      pack: "test-kit",
      catalogCategory: cat,
      bounds,
    });
  };
  reg("Kit_Bld_Wall_01", makeCornerWallBounds());
  reg("Kit_Bld_Wall_Door_01", makeCornerWallBounds());
  reg("Kit_Bld_Wall_Window_01", makeCornerWallBounds());
  reg("Kit_Bld_Floor_Wood_01", makeFloorBounds());
  reg("Kit_Bld_Stairs_01", makeStairBounds());
  reg("Kit_Bld_Roof_01", { min: [0, 0, 0], max: [2.5, 1.5, 2.5], size: [2.5, 1.5, 2.5] });
  reg("Kit_Bld_Base_Wall_01", { min: [0, 0, -0.35], max: [2.5, 1.25, 0.35], size: [2.5, 1.25, 0.7] });

  reg("Kit_Prop_Bar_01", { min: [-1.0, 0, -0.5], max: [1.0, 1.05, 0.5], size: [2.0, 1.05, 1.0] }, "Props");
  reg("Kit_Prop_Table_01", { min: [-0.8, 0, -0.5], max: [0.8, 0.8, 0.5], size: [1.6, 0.8, 1.0] }, "Props");
  reg("Kit_Prop_Stool_01", { min: [-0.25, 0, -0.25], max: [0.25, 0.55, 0.25], size: [0.5, 0.55, 0.5] }, "Props");
  reg("Kit_Prop_Chair_01", { min: [-0.3, 0, -0.3], max: [0.3, 0.9, 0.3], size: [0.6, 0.9, 0.6] }, "Props");
  reg("Kit_Prop_Mug_01", { min: [-0.1, 0, -0.1], max: [0.1, 0.2, 0.1], size: [0.2, 0.2, 0.2] }, "Props");
  reg("Kit_Prop_Stove_01", { min: [-0.6, 0, -0.45], max: [0.6, 1.6, 0.45], size: [1.2, 1.6, 0.9] }, "Props");
  reg("Kit_Prop_Pot_01", { min: [-0.18, 0, -0.18], max: [0.18, 0.3, 0.18], size: [0.36, 0.3, 0.36] }, "Props");
  reg("Kit_Prop_Bed_01", { min: [-0.7, 0, -1.0], max: [0.7, 0.85, 1.0], size: [1.4, 0.85, 2.0] }, "Props");
  reg("Kit_Prop_Rug_01", { min: [-1.0, 0, -0.8], max: [1.0, 0.03, 0.8], size: [2.0, 0.03, 1.6] }, "Props");
  reg("Kit_Prop_Chest_01", { min: [-0.45, 0, -0.3], max: [0.45, 0.55, 0.3], size: [0.9, 0.55, 0.6] }, "Props");
  return map;
}

const yawQ = (deg: number): [number, number, number, number] => {
  const h = ((deg * Math.PI) / 180) * 0.5;
  return [0, Math.round(Math.sin(h) * 10000) / 10000, 0, Math.round(Math.cos(h) * 10000) / 10000];
};

function makeNode(
  rootGroup: string,
  partId: string,
  pos: [number, number, number],
  yawDeg = 0,
  isInteriorHint = false,
): UnityRawNode {
  return {
    partId,
    name: partId,
    rootGroup,
    groupPath: isInteriorHint ? `${rootGroup}/Interior` : `${rootGroup}/Exterior`,
    isInteriorHint,
    transform: { pos, rot: yawQ(yawDeg), scale: [1, 1, 1] },
  };
}

/** Build a synthetic 2-storey 2x2-cell (5m x 5m) tavern + 1-storey house for hierarchical decomposition tests. */
function makeSyntheticVillageNodes(): UnityRawNode[] {
  const nodes: UnityRawNode[] = [];
  const t = "Preset_Tavern_01";
  // Ground plinth & 2 storeys: y = 1.25 ground floor, y = 3.75 second floor (corner-pivoted 2.5x2.5 tiles on [0..5, 0..5])
  for (let gx = 0; gx < 2; gx++) {
    for (let gz = 0; gz < 2; gz++) {
      nodes.push(makeNode(t, "Kit_Bld_Floor_Wood_01", [gx * 2.5, 1.25, gz * 2.5], 0, true));
      nodes.push(makeNode(t, "Kit_Bld_Floor_Wood_01", [gx * 2.5, 3.75, gz * 2.5], 0, true));
      nodes.push(makeNode(t, "Kit_Bld_Roof_01", [gx * 2.5, 6.25, gz * 2.5], 0, false));
    }
  }
  // North (z=0), South (z=5, with doorway at x=0..2.5), West (x=0), East (x=5) outer walls + internal partition at z=2.5
  for (const y of [1.25, 3.75]) {
    // North z=0: 2 wall panels spanning +X [0..2.5], [2.5..5.0]
    nodes.push(makeNode(t, "Kit_Bld_Wall_01", [0, y, 0], 0));
    nodes.push(makeNode(t, "Kit_Bld_Wall_01", [2.5, y, 0], 0));
    // South z=5: front door on storey 0 at x=0..2.5
    nodes.push(makeNode(t, y === 1.25 ? "Kit_Bld_Wall_Door_01" : "Kit_Bld_Wall_Window_01", [0, y, 5], 0));
    nodes.push(makeNode(t, "Kit_Bld_Wall_Window_01", [2.5, y, 5], 0));
    // West x=0 & East x=5: rotated -90 so +X spans +Z [0..2.5], [2.5..5.0]
    nodes.push(makeNode(t, "Kit_Bld_Wall_01", [0, y, 0], -90));
    nodes.push(makeNode(t, "Kit_Bld_Wall_01", [0, y, 2.5], -90));
    nodes.push(makeNode(t, "Kit_Bld_Wall_01", [5, y, 0], -90));
    nodes.push(makeNode(t, "Kit_Bld_Wall_01", [5, y, 2.5], -90));
  }
  // Plinth front wall & interior partition on storey 0 separating taproom (z=2.5..5) from kitchen (z=0..2.5)
  nodes.push(makeNode(t, "Kit_Bld_Base_Wall_01", [0, 0, 5], 0));
  nodes.push(makeNode(t, "Kit_Bld_Base_Wall_01", [2.5, 0, 5], 0));
  nodes.push(makeNode(t, "Kit_Bld_Wall_Door_01", [0, 1.25, 2.5], 0, true));
  nodes.push(makeNode(t, "Kit_Bld_Wall_01", [2.5, 1.25, 2.5], 0, true));
  // Interior stairs at [3.75, 1.25, 2.5] rising toward -Z to reach floor 1
  nodes.push(makeNode(t, "Kit_Bld_Stairs_01", [3.75, 1.25, 2.5], 0, true));

  // Vignette 1: bar_service in South taproom (z = 3.75, x = 3.5)
  nodes.push(makeNode(t, "Kit_Prop_Bar_01", [3.5, 1.25, 3.8], 0, true));
  nodes.push(makeNode(t, "Kit_Prop_Stool_01", [3.0, 1.25, 4.5], 0, true));
  nodes.push(makeNode(t, "Kit_Prop_Stool_01", [4.0, 1.25, 4.5], 0, true));
  nodes.push(makeNode(t, "Kit_Prop_Mug_01", [3.3, 2.3, 3.8], 0, true));

  // Vignette 2: hearth/kitchen in North room (z = 1.0, x = 1.2)
  nodes.push(makeNode(t, "Kit_Prop_Stove_01", [1.2, 1.25, 0.8], 0, true));
  nodes.push(makeNode(t, "Kit_Prop_Pot_01", [1.2, 2.1, 0.8], 0, true));

  // Vignette 3: sleeping_alcove upstairs at y = 3.75
  nodes.push(makeNode(t, "Kit_Prop_Bed_01", [1.3, 3.75, 1.4], 0, true));
  nodes.push(makeNode(t, "Kit_Prop_Rug_01", [1.3, 3.75, 1.4], 0, true));
  nodes.push(makeNode(t, "Kit_Prop_Chest_01", [1.3, 3.75, 2.6], 0, true));

  // Second prototype: simple single-storey House shifted in X by +20m
  const h = "Preset_House_01";
  nodes.push(makeNode(h, "Kit_Bld_Floor_Wood_01", [20, 0, 0], 0, true));
  nodes.push(makeNode(h, "Kit_Bld_Floor_Wood_01", [22.5, 0, 0], 0, true));
  nodes.push(makeNode(h, "Kit_Bld_Wall_01", [20, 0, 0], 0));
  nodes.push(makeNode(h, "Kit_Bld_Wall_01", [22.5, 0, 0], 0));
  nodes.push(makeNode(h, "Kit_Bld_Wall_Door_01", [20, 0, 2.5], 0));
  nodes.push(makeNode(h, "Kit_Bld_Wall_Window_01", [22.5, 0, 2.5], 0));
  nodes.push(makeNode(h, "Kit_Bld_Wall_01", [20, 0, 0], -90));
  nodes.push(makeNode(h, "Kit_Bld_Wall_01", [25, 0, 0], -90));
  nodes.push(makeNode(h, "Kit_Bld_Roof_01", [20, 2.5, 0], 0));
  nodes.push(makeNode(h, "Kit_Bld_Table_01".replace("Kit_Bld_", "Kit_Prop_"), [22.0, 0, 1.2], 0, true));
  nodes.push(makeNode(h, "Kit_Prop_Chair_01", [22.0, 0, 0.5], 0, true));
  return nodes;
}

describe("Unity YAML Parser, GLB Bounds & Pivot Socket Rules", () => {
  it("converts Unity LH TRS to engine RH coordinates and canonicalizes double-axis negative flips", () => {
    const t1 = unityTrsToEngine([3, 1.25, 4], [0, 0.7071068, 0, 0.7071068], [1, 1, 1]);
    assert.deepEqual(t1.pos, [-3, 1.25, 4]);
    assert.ok(t1.rot[1] < -0.7 && t1.rot[3] > 0.7, "LH +90 yaw becomes RH -90 yaw");

    const flipped = unityTrsToEngine([0, 0, 0], [0, 0, 0, 1], [-1, 1, -1]);
    assert.deepEqual(flipped.scale, [1, 1, 1], "XZ double negative scale converts cleanly into positive unit scale");
    assert.ok(Math.abs(Math.abs(flipped.rot[1]) - 1) < 1e-3, "180 deg Y rotation absorbed from (-1,1,-1)");
  });

  it("parses nested PrefabInstances, stripped Transforms, and active filter from synthetic Unity YAML", () => {
    const childPrefab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1000
GameObject:
  m_IsActive: 1
  m_Name: ChildWall
--- !u!4 &1001
Transform:
  m_GameObject: {fileID: 1000}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 2, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!33 &1002
MeshFilter:
  m_GameObject: {fileID: 1000}
  m_Mesh: {fileID: 4300000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
`;
    const sceneYaml = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &10
GameObject:
  m_IsActive: 1
  m_Name: Preset_House_A
--- !u!4 &11
Transform:
  m_GameObject: {fileID: 10}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 10, y: 0, z: 5}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!1001 &20
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 11}
    m_Modifications:
      - target: {fileID: 1001, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
        propertyPath: m_LocalPosition.x
        value: 1
      - target: {fileID: 1000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
        propertyPath: m_IsActive
        value: 1
  m_SourcePrefab: {fileID: 100100000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
--- !u!1001 &30
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 11}
    m_Modifications:
      - target: {fileID: 1000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
        propertyPath: m_IsActive
        value: 0
  m_SourcePrefab: {fileID: 100100000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
`;
    const index: UnityPackageIndex = {
      guidToPath: new Map([
        ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Assets/Models/SM_Test_Wall_01.fbx"],
        ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Assets/Prefabs/SM_Test_Wall_01.prefab"],
      ]),
      textFiles: new Map([
        ["Assets/Prefabs/SM_Test_Wall_01.prefab", childPrefab],
        ["Assets/Scenes/Test.unity", sceneYaml],
      ]),
    };

    const nodes = extractUnitySceneNodes(index, "Assets/Scenes/Test.unity", { expandNestedPrefabs: true });
    assert.equal(nodes.length, 1, "disabled PrefabInstance (m_IsActive: 0) is filtered out");
    assert.equal(nodes[0]!.partId, "SM_Test_Wall_01");
    assert.equal(nodes[0]!.rootGroup, "Preset_House_A");
    // Unity pos: 10 + 1 = 11 -> engine X = -11
    assert.equal(nodes[0]!.transform.pos[0], -11);
    assert.equal(nodes[0]!.transform.pos[2], 5);
  });

  it("places a model with sub-mesh GameObjects once, and keeps a child's overrides off the instance", () => {
    // One FBX, three GameObjects: the wall at the root, its glass on top of it and a shutter hinged 1.5 m along.
    const go = (id: number, name: string, tf: number, father: number, x: number, mesh: number) => `--- !u!1 &${id}
GameObject:
  m_IsActive: 1
  m_Name: ${name}
--- !u!4 &${tf}
Transform:
  m_GameObject: {fileID: ${id}}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: ${x}, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: ${father}}
--- !u!33 &${id + 2}
MeshFilter:
  m_GameObject: {fileID: ${id}}
  m_Mesh: {fileID: ${mesh}, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
`;
    const prefab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
${go(2020, "SM_Test_Window_01_Shutter", 2021, 2001, 1.5, 4300004)}${go(2000, "SM_Test_Window_01", 2001, 0, 0, 4300000)}${go(2010, "SM_Test_Window_01_Glass", 2011, 2001, 0, 4300002)}`;
    // The scene places it at x 4, opens the shutter (moves it to x 9) and hides it: both are the shutter's, not the wall's.
    const mod = (target: number, path: string, value: number) => `      - target: {fileID: ${target}, guid: cccccccccccccccccccccccccccccccc, type: 3}
        propertyPath: ${path}
        value: ${value}
`;
    // It is placed twice at the same spot (a slip in the source scene).
    const instance = (id: number) => `--- !u!1001 &${id}
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 0}
    m_Modifications:
${mod(2001, "m_LocalPosition.x", 4)}${mod(2021, "m_LocalPosition.x", 9)}${mod(2020, "m_IsActive", 0)}  m_SourcePrefab: {fileID: 100100000, guid: cccccccccccccccccccccccccccccccc, type: 3}
`;
    const scene = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
${instance(40)}${instance(41)}`;
    const index: UnityPackageIndex = {
      guidToPath: new Map([
        ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Assets/Models/SM_Test_Window_01.fbx"],
        ["cccccccccccccccccccccccccccccccc", "Assets/Prefabs/SM_Test_Window_01.prefab"],
      ]),
      textFiles: new Map([
        ["Assets/Prefabs/SM_Test_Window_01.prefab", prefab],
        ["Assets/Scenes/Window.unity", scene],
      ]),
    };
    const nodes = extractUnitySceneNodes(index, "Assets/Scenes/Window.unity", { expandNestedPrefabs: true });
    assert.equal(nodes.length, 1, "one wall: not one per sub-mesh, not two at one spot, and not hidden by the shutter's override");
    assert.equal(nodes[0]!.partId, "SM_Test_Window_01");
    assert.equal(nodes[0]!.name, "SM_Test_Window_01", "named for its root GameObject, whichever the prefab lists first");
    assert.equal(nodes[0]!.transform.pos[0], -4, "at the wall's own place, not the opened shutter's");
  });

  it("reads corner-pivoted GLB AABB and shifts sockets and circular relativeYawDeg accordingly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-glb-"));
    try {
      const glbFile = path.join(dir, "wall.glb");
      fs.writeFileSync(glbFile, makeMinimalGlb([0, 0, -0.12], [2.5, 2.5, 0.12]));
      const bounds = readGlbPivotBounds(glbFile);
      assert.ok(bounds);
      assert.deepEqual(bounds.min, [0, 0, -0.12]);
      assert.deepEqual(bounds.max, [2.5, 2.5, 0.12]);
      assert.deepEqual(boundsCenter(bounds), [1.25, 1.25, 0]);

      const sockets = generatePartSockets("Kit_Wall", "wall", bounds);
      const topSock = sockets.find((s) => s.name === "top")!;
      assert.deepEqual(topSock.offset, [1.25, 2.5, 0]);

      const parts: PlacedPartInstance[] = [
        { partId: "Kit_Wall", assetRef: "test-kit/Kit_Wall", category: "wall", transform: { pos: [0, 0, 0], rot: yawQ(0), scale: [1, 1, 1] }, bounds },
        { partId: "Kit_Wall", assetRef: "test-kit/Kit_Wall", category: "wall", transform: { pos: [2.5, 0, 0], rot: yawQ(-90), scale: [1, 1, 1] }, bounds },
      ];
      const rules = extractLearnedRuleSet([{ id: "a", family: "test", source: "unit", license: "MIT", parts }], { adjacencyThreshold: 4.0 });
      assert.ok(rules.adjacency.length >= 2);
      const yaws = rules.adjacency.map((r) => Math.abs(r.transformStats.relativeYawDeg));
      assert.ok(yaws.some((y) => Math.abs(y - 90) < 0.1), "computes true circular relativeYawDeg instead of 0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("4-Tier Hierarchical Decomposition & WFC Building Synthesis", () => {
  const catalog = makeSyntheticCatalog();
  const lib = decomposeUnityScene(makeSyntheticVillageNodes(), {
    family: "test-kit",
    assetPrefix: "test-kit",
    catalogBounds: catalog,
  });

  it("extracts structure archetypes, multi-storey rooms, roomGraph, and decoration vignettes", () => {
    assert.equal(lib.structures.length, 2);
    const tavern = lib.structures.find((s) => s.category === "tavern");
    const house = lib.structures.find((s) => s.category === "house");
    assert.ok(tavern, "classified Preset_Tavern_01 as tavern");
    assert.ok(house, "classified Preset_House_01 as house");

    assert.equal(tavern.storeys.length, 2, "detected 2 floor levels (y=1.25 and y=3.75)");
    assert.ok(tavern.rooms.length >= 3, `expected >= 3 rooms across 2 storeys, got ${tavern.rooms.length}`);
    assert.ok(tavern.rooms.some((r) => r.roomType === "taproom"), "classified taproom");
    assert.ok(tavern.rooms.some((r) => r.roomType === "kitchen_hearth"), "classified kitchen_hearth");
    assert.ok(tavern.rooms.some((r) => r.roomType === "bedroom"), "classified upstairs bedroom");
    assert.ok(tavern.roomGraph.some((e) => e.via === "door"), "linked ground rooms across doorway");
    assert.ok(tavern.roomGraph.some((e) => e.via === "stairs"), "linked storeys across interior stairs");

    const barVig = lib.vignettes.find((v) => v.kind === "bar_service");
    const bedVig = lib.vignettes.find((v) => v.kind === "sleeping_alcove");
    assert.ok(barVig, "extracted bar_service vignette");
    assert.ok(barVig.items.some((i) => i.relation === "on_top_of"), "linked mug on_top_of bar");
    assert.ok(barVig.items.some((i) => i.relation === "beside"), "linked stools beside bar");
    assert.ok(bedVig?.items.some((i) => i.relation === "under"), "linked rug under bed");
  });

  it("synthesizes deterministic multi-part enterable buildings with valid modular colliders", () => {
    const b1 = synthesizeBuilding(lib, { archetype: "tavern", seed: 101, maxFootprintM: [8, 8] });
    const b2 = synthesizeBuilding(lib, { archetype: "tavern", seed: 101, maxFootprintM: [8, 8] });
    assert.deepEqual(b1.placements, b2.placements, "same seed yields byte-identical placements");
    assert.ok(b1.rooms.length >= 2);
    assert.ok(b1.placements.some((p) => p.interaction?.kind === "vendor"), "counter carries vendor interaction");

    const doc = synthesisToScene(b1, { name: "test-tavern", kind: "arena", mode: "modular" });
    const issues = validateScene(doc);
    assert.deepEqual(issues, [], `modular SceneDoc should validate cleanly, got ${JSON.stringify(issues)}`);

    // Check split doorway geometry & stair stepping
    const flatNodes = doc.nodes[0]!.children ?? [];
    const jambs = flatNodes.filter((n) => n.id.includes("-jamb-"));
    const lintels = flatNodes.filter((n) => n.id.includes("-lintel"));
    const steps = flatNodes.filter((n) => n.id.includes("-step-"));
    assert.ok(jambs.length >= 2, "doorway wall emits split left & right jamb colliders");
    assert.ok(lintels.length >= 1, "doorway wall emits overhead lintel collider");
    assert.ok(steps.length >= 4, "stairs emit stepped risers for climbing");

    // Verify all Roof & Mug placements emit NO collider node
    const roofPlacementIdx = b1.placements.findIndex((p) => p.partId.includes("Roof"));
    assert.ok(roofPlacementIdx >= 0);
    assert.equal(
      flatNodes.some((n) => n.id.startsWith(`part-p${roofPlacementIdx}-`)),
      false,
      "roof emits visual-only node with zero colliders",
    );

    const group = buildingToSceneNodes(b1, { id: "bld-1", archetype: "tavern", position: [10, 0, -5], yawDeg: 90 });
    assert.equal(group.name, "building:tavern");
    assert.deepEqual(group.transform?.rotation, [0, 90, 0]);
  });
});
