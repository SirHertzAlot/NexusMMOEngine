import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  categorizePart,
  generatePartSockets,
  decomposeScene,
  extractLearnedRuleSet,
  synthesizeAssembly,
  compileRuleSetToWfcModules,
  type ExampleAssembly,
  type SynthesisProblem,
  type LearnedRuleSet,
} from "../src/index.js";

describe("Model Synthesis & Scene Decomposer", () => {
  it("categorizes parts into architectural roles", () => {
    assert.equal(categorizePart("SM_Env_Tiles_01"), "floor");
    assert.equal(categorizePart("SM_Env_Wall_Solid_01"), "wall");
    assert.equal(categorizePart("SM_Env_Pillar_Round_02"), "pillar");
    assert.equal(categorizePart("SM_Env_Ceiling_Arched_01"), "ceiling");
    assert.equal(categorizePart("SM_Prop_Chest_01"), "prop");
    assert.equal(categorizePart("SM_Env_Rubble_Large_01"), "rubble");
    assert.equal(categorizePart("SM_Env_Dungeon_Stairs_01"), "stairs");
  });

  it("generates continuous sockets with directional normals", () => {
    const sockets = generatePartSockets("SM_Env_Wall_01", "wall", {
      min: [-2.5, -2, -0.25],
      max: [2.5, 2, 0.25],
      size: [5, 4, 0.5],
    });

    assert.ok(sockets.length >= 4);
    const left = sockets.find((s) => s.name === "edge_left");
    const right = sockets.find((s) => s.name === "edge_right");
    assert.ok(left);
    assert.ok(right);
    assert.deepEqual(left?.normal, [-1, 0, 0]);
    assert.deepEqual(right?.normal, [1, 0, 0]);
  });

  it("decomposes a scene graph into assemblies with meter normalization", () => {
    const scene = new THREE.Group();

    // Create 10 dummy objects (simulating Unity scene with 1 unit = 1 cm)
    for (let i = 0; i < 10; i++) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(500, 400, 50),
        new THREE.MeshBasicMaterial()
      );
      mesh.name = `SM_Env_Wall_01_${i}`;
      mesh.position.set(i * 500, 0, 0); // 500 cm = 5 m spacing
      scene.add(mesh);
    }

    const assemblies = decomposeScene(scene, { scaleFactor: 0.01, clusterRadius: 100 });
    assert.ok(assemblies.length > 0);
    const asm = assemblies[0];
    assert.equal(asm.parts.length, 10);
    // Verified 500cm -> 5m
    assert.ok(Math.abs(asm.parts[1].transform.pos[0] - 5.0) < 0.1);
    assert.ok(Math.abs(asm.parts[2].transform.pos[0] - 10.0) < 0.1);
  });

  it("extracts learned adjacency rules and frequencies from assemblies", () => {
    const assemblies: ExampleAssembly[] = [
      {
        id: "dungeon_room_1",
        family: "dungeon",
        source: "test",
        license: "test",
        parts: [
          {
            partId: "SM_Env_Floor_01",
            assetRef: "models/floor.glb",
            category: "floor",
            transform: { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          {
            partId: "SM_Env_Wall_01",
            assetRef: "models/wall.glb",
            category: "wall",
            transform: { pos: [0, 2, 2.5], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          {
            partId: "SM_Env_Pillar_01",
            assetRef: "models/pillar.glb",
            category: "pillar",
            transform: { pos: [2.5, 2, 2.5], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
        ],
      },
    ];

    const ruleSet = extractLearnedRuleSet(assemblies, { adjacencyThreshold: 4.0 });
    assert.equal(ruleSet.family, "dungeon");
    assert.equal(ruleSet.stats.uniqueParts, 3);
    assert.ok(ruleSet.adjacency.length > 0);
    assert.ok(ruleSet.stats.totalAdjacencyPairs > 0);
  });

  it("synthesizes deterministic assemblies from a learned rule set", () => {
    const dummyRuleSet: LearnedRuleSet = {
      family: "dungeon",
      extractorVersion: "1.0.0",
      sourceAssemblies: ["test"],
      parts: {
        floor_a: {
          id: "floor_a",
          assetRef: "models/floor_a.glb",
          category: "floor",
          bounds: { min: [-2.5, -0.1, -2.5], max: [2.5, 0.1, 2.5], size: [5, 0.2, 5] },
          sockets: [
            { name: "edge_px", kind: "floor-edge", offset: [2.5, 0, 0], normal: [1, 0, 0] },
            { name: "edge_nx", kind: "floor-edge", offset: [-2.5, 0, 0], normal: [-1, 0, 0] },
            { name: "edge_pz", kind: "floor-edge", offset: [0, 0, 2.5], normal: [0, 0, 1] },
            { name: "edge_nz", kind: "floor-edge", offset: [0, 0, -2.5], normal: [0, 0, -1] },
            { name: "top", kind: "surface-mount", offset: [0, 0.1, 0], normal: [0, 1, 0] },
          ],
        },
        wall_a: {
          id: "wall_a",
          assetRef: "models/wall_a.glb",
          category: "wall",
          bounds: { min: [-2.5, -2, -0.25], max: [2.5, 2, 0.25], size: [5, 4, 0.5] },
          sockets: [
            { name: "edge_px", kind: "wall-edge", offset: [2.5, 0, 0], normal: [1, 0, 0] },
            { name: "edge_nx", kind: "wall-edge", offset: [-2.5, 0, 0], normal: [-1, 0, 0] },
            { name: "bottom", kind: "wall-base", offset: [0, -2, 0], normal: [0, -1, 0] },
            { name: "top", kind: "wall-top", offset: [0, 2, 0], normal: [0, 1, 0] },
          ],
        },
      },
      adjacency: [
        {
          aPart: "floor_a",
          aSocket: "edge_px",
          bPart: "floor_a",
          bSocket: "edge_nx",
          count: 10,
          frequency: 0.8,
          transformStats: { meanOffset: [5, 0, 0], spreadOffset: [0, 0, 0], relativeYawDeg: 0 },
        },
        {
          aPart: "floor_a",
          aSocket: "edge_pz",
          bPart: "floor_a",
          bSocket: "edge_nz",
          count: 10,
          frequency: 0.8,
          transformStats: { meanOffset: [0, 0, 5], spreadOffset: [0, 0, 0], relativeYawDeg: 0 },
        },
        {
          aPart: "floor_a",
          aSocket: "top",
          bPart: "wall_a",
          bSocket: "bottom",
          count: 5,
          frequency: 0.5,
          transformStats: { meanOffset: [0, 2.1, 0], spreadOffset: [0, 0, 0], relativeYawDeg: 0 },
        },
      ],
      terminals: [],
      stats: {
        totalPlacements: 15,
        uniqueParts: 2,
        totalAdjacencyPairs: 25,
        categoryDistribution: { floor: 10, wall: 5 },
        partFrequencies: { floor_a: 10, wall_a: 5 },
      },
    };

    const problem: SynthesisProblem = {
      ruleSet: dummyRuleSet,
      seed: 1337,
      site: {
        bounds: {
          min: [-20, 0, -20],
          max: [20, 10, 20],
        },
      },
      budget: {
        maxParts: 8,
      },
    };

    const out1 = synthesizeAssembly(problem);
    assert.ok(out1.placements.length > 1);
    assert.equal(out1.report.partsPlaced, out1.placements.length);

    // Bit-for-bit determinism
    const out2 = synthesizeAssembly(problem);
    assert.deepEqual(out1.placements, out2.placements);
  });

  it("compiles learned rules into 3D WFC module variation definitions", () => {
    const dummyRuleSet: LearnedRuleSet = {
      family: "dungeon",
      extractorVersion: "1.0.0",
      sourceAssemblies: ["test"],
      parts: {
        floor_stone: {
          id: "floor_stone",
          assetRef: "models/floor.glb",
          category: "floor",
          bounds: { min: [-2.5, -0.1, -2.5], max: [2.5, 0.1, 2.5], size: [5, 0.2, 5] },
          sockets: [
            { name: "top", kind: "surface", offset: [0, 0.1, 0], normal: [0, 1, 0] },
            { name: "edge_px", kind: "edge", offset: [2.5, 0, 0], normal: [1, 0, 0] },
          ],
        },
      },
      adjacency: [],
      terminals: [],
      stats: {
        totalPlacements: 10,
        uniqueParts: 1,
        totalAdjacencyPairs: 0,
        categoryDistribution: { floor: 10 },
        partFrequencies: { floor_stone: 10 },
      },
    };

    const wfcModules = compileRuleSetToWfcModules(dummyRuleSet);
    assert.equal(wfcModules.length, 1);
    assert.equal(wfcModules[0].moduleType, "floor");
    assert.equal(wfcModules[0].sockets.pz, "floor_top");
    assert.equal(wfcModules[0].sockets.px, "floor_side");
  });
});
