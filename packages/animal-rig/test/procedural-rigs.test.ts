/**
 * Unit tests for multi-rig procedural animals & flora:
 * avian, serpentine, aquatic, arachnid, and flora segmentation and posing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  classifyModelType,
  segmentAvian,
  segmentSerpentine,
  segmentAquatic,
  segmentArachnid,
  segmentFlora,
} from "../src/segment.js";
import { AnimalTemplate } from "../src/animal-rig.js";
import { namedRigType } from "../src/segment.js";

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, seg = [1, 1, 1]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0, seg[0], seg[1], seg[2]);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

function syntheticAvian(): THREE.BufferGeometry {
  const parts = [
    box(-0.15, 0.15, 0.3, 0.6, -0.2, 0.2, [3, 3, 3]), // body
    box(-0.08, 0.08, 0.5, 0.8, 0.15, 0.35, [2, 2, 2]), // head
    box(-0.05, 0.05, 0.35, 0.45, -0.4, -0.2, [1, 1, 2]), // tail
    box(0.15, 0.6, 0.4, 0.55, -0.1, 0.1, [3, 1, 2]), // wingL
    box(-0.6, -0.15, 0.4, 0.55, -0.1, 0.1, [3, 1, 2]), // wingR
    box(0.05, 0.1, 0, 0.3, -0.05, 0.05, [1, 2, 1]), // legL
    box(-0.1, -0.05, 0, 0.3, -0.05, 0.05, [1, 2, 1]), // legR
  ];
  return mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
}

function syntheticSerpentine(): THREE.BufferGeometry {
  // Long slender snake: length 3.0, width 0.15, height 0.15
  return box(-0.08, 0.08, 0, 0.16, -1.5, 1.5, [2, 2, 16]);
}

function syntheticAquatic(): THREE.BufferGeometry {
  const parts = [
    box(-0.15, 0.15, 0.2, 0.7, -0.6, 0.6, [3, 3, 6]), // body
    box(-0.1, 0.1, 0.25, 0.65, 0.5, 0.9, [2, 2, 2]), // head
    box(-0.04, 0.04, 0.2, 0.7, -0.9, -0.6, [1, 2, 2]), // caudal fin
    box(0.15, 0.4, 0.25, 0.4, 0.1, 0.3, [2, 1, 2]), // finL
    box(-0.4, -0.15, 0.25, 0.4, 0.1, 0.3, [2, 1, 2]), // finR
    box(-0.03, 0.03, 0.7, 0.95, -0.1, 0.2, [1, 2, 2]), // dorsal
  ];
  return mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
}

function syntheticArachnid(): THREE.BufferGeometry {
  const parts = [
    box(-0.3, 0.3, 0.1, 0.35, -0.4, 0.1, [3, 2, 3]), // abdomen / body
    box(-0.2, 0.2, 0.12, 0.38, 0.1, 0.4, [2, 2, 2]), // head
  ];
  // 4 leg pairs radiating outward
  for (let i = 0; i < 4; i++) {
    const z = -0.3 + i * 0.2;
    parts.push(box(0.2, 0.8, 0, 0.3, z - 0.05, z + 0.05, [2, 1, 1]));
    parts.push(box(-0.8, -0.2, 0, 0.3, z - 0.05, z + 0.05, [2, 1, 1]));
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
}

function syntheticFlora(): THREE.BufferGeometry {
  const parts = [
    box(-0.1, 0.1, 0, 1.2, -0.1, 0.1, [2, 6, 2]), // trunk
    box(-0.6, 0.6, 1.0, 2.0, -0.6, 0.6, [4, 4, 4]), // canopy
  ];
  return mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
}

describe("Multi-rig procedural classification & segmentation", () => {
  it("classifies models correctly by name pattern", () => {
    const dummy = [0, 0, 0, 1, 1, 1];
    assert.equal(classifyModelType(dummy, undefined, "Raven_01.glb"), "avian");
    assert.equal(classifyModelType(dummy, undefined, "Bushmaster_snake_f1DELjNQxqz.glb"), "serpentine");
    assert.equal(classifyModelType(dummy, undefined, "Shark_1L-AKXa31CF.glb"), "aquatic");
    assert.equal(classifyModelType(dummy, undefined, "Spider_1.glb"), "arachnid");
    assert.equal(classifyModelType(dummy, undefined, "Pine_tree_02.glb"), "flora");
    assert.equal(classifyModelType(dummy, undefined, "Wolf_6K9M8f0j1P.glb"), "quadruped");
  });

  it("a model named as a bird takes the avian rig from its name, not the quadruped fit", () => {
    assert.equal(namedRigType("synty:animals/SM_Raven_01"), "avian");
    assert.equal(namedRigType("animals/SM_Bear_01"), "quadruped");
    assert.equal(namedRigType("structure:house"), undefined, "a name that says nothing");
    const named = AnimalTemplate.from(syntheticAvian(), undefined, "animals/SM_Raven_01");
    assert.ok(named);
    assert.equal(named.seg.type, "avian");
  });

  it("segments avian models with wing and leg bones", () => {
    const mesh = syntheticAvian();
    const seg = segmentAvian(mesh.getAttribute("position").array);
    assert.ok(seg);
    assert.equal(seg.type, "avian");
    assert.equal(seg.boneNames?.length, 7);
    assert.equal(seg.skinIndex.length, mesh.getAttribute("position").count * 4);
  });

  it("segments serpentine models into sequential vertebrae", () => {
    const mesh = syntheticSerpentine();
    const seg = segmentSerpentine(mesh.getAttribute("position").array);
    assert.ok(seg);
    assert.equal(seg.type, "serpentine");
    assert.equal(seg.boneNames?.length, 5);
    assert.deepEqual(seg.parentIndices, [-1, 0, 1, 2, 3]);
  });

  it("segments aquatic fauna into fin and caudal joints", () => {
    const mesh = syntheticAquatic();
    const seg = segmentAquatic(mesh.getAttribute("position").array);
    assert.ok(seg);
    assert.equal(seg.type, "aquatic");
    assert.equal(seg.boneNames?.length, 6);
  });

  it("segments arachnids into cephalothorax and radiating legs", () => {
    const mesh = syntheticArachnid();
    const seg = segmentArachnid(mesh.getAttribute("position").array);
    assert.ok(seg);
    assert.equal(seg.type, "arachnid");
    assert.equal(seg.boneNames?.length, 10);
  });

  it("segments flora into trunk and canopy swaying pivots", () => {
    const mesh = syntheticFlora();
    const seg = segmentFlora(mesh.getAttribute("position").array);
    assert.ok(seg);
    assert.equal(seg.type, "flora");
    assert.equal(seg.boneNames?.length, 5);
  });

  it("creates rigs and poses each procedural rig type without error", () => {
    const mat = new THREE.MeshBasicMaterial();
    const models: Array<{ name: string; g: THREE.BufferGeometry }> = [
      { name: "Eagle_01.glb", g: syntheticAvian() },
      { name: "Snake_01.glb", g: syntheticSerpentine() },
      { name: "Trout_01.glb", g: syntheticAquatic() },
      { name: "Spider_01.glb", g: syntheticArachnid() },
      { name: "Tree_01.glb", g: syntheticFlora() },
    ];

    for (const { name, g } of models) {
      const template = AnimalTemplate.from(g, undefined, name);
      assert.ok(template, `Template for ${name} created`);
      const rig = template.create(mat);
      assert.ok(rig.mesh);
      assert.ok(rig.skeleton);

      // Pose moving, attacking, dead
      rig.update(0.016, { speed: 2.0, attackT: 0.1, hitAt: 0.2, attackDuration: 0.5, dead: false });
      rig.update(0.016, { speed: 0, attackT: -1, hitAt: 0, attackDuration: 0, dead: true });
      rig.restPose();
      rig.dispose();
      template.dispose();
    }
  });
});
