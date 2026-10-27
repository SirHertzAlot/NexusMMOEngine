/**
 * Unit tests for bone mapping ontology and presets resolution.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_BONE_ONTOLOGY,
  MIXAMO_MAP,
  SYNTY_MAP,
  RIGIFY_MAP,
  MANNEQUIN_MAP,
  KEVIN_MAP,
  CMU_MAP,
  resolveBoneMapping,
} from "../src/convert/convert-animations.js";

describe("Bone mapping ontology", () => {
  it("defines canonical bones covering humanoids, creatures, wings, and tails", () => {
    assert.ok(CANONICAL_BONE_ONTOLOGY.length >= 40);
    const names = new Set(CANONICAL_BONE_ONTOLOGY.map((b) => b.canonical));
    assert.ok(names.has("Hips"));
    assert.ok(names.has("Spine_01"));
    assert.ok(names.has("Head"));
    assert.ok(names.has("Shoulder_L"));
    assert.ok(names.has("Hand_R"));
    assert.ok(names.has("Thumb_01_L"));
    assert.ok(names.has("IndexFinger_03_R"));
    assert.ok(names.has("UpperLeg_L"));
    assert.ok(names.has("Ankle_R"));
    assert.ok(names.has("Wing_01_L"));
    assert.ok(names.has("Tail_01"));
  });

  it("resolves Mixamo preset rigs correctly", () => {
    const mixamoBones = [
      "mixamorig:Hips",
      "mixamorig:Spine",
      "mixamorig:Spine1",
      "mixamorig:Spine2",
      "mixamorig:Neck",
      "mixamorig:Head",
      "mixamorig:LeftArm",
      "mixamorig:LeftForeArm",
      "mixamorig:LeftHand",
      "mixamorig:RightUpLeg",
      "mixamorig:RightLeg",
      "mixamorig:RightFoot",
    ];
    const resolved = resolveBoneMapping(mixamoBones);
    assert.equal(resolved["Hips"], "mixamorig:Hips");
    assert.equal(resolved["Spine_01"], "mixamorig:Spine");
    assert.equal(resolved["Shoulder_L"], "mixamorig:LeftArm");
    assert.equal(resolved["UpperLeg_R"], "mixamorig:RightUpLeg");
  });

  it("resolves Synty preset rigs correctly", () => {
    const syntyBones = [
      "Root",
      "Pelvis",
      "Spine_01",
      "Spine_02",
      "Spine_03",
      "Neck",
      "Head",
      "UpperArm_L",
      "LowerArm_L",
      "Hand_L",
      "Thigh_L",
      "Calf_L",
      "Foot_L",
    ];
    const resolved = resolveBoneMapping(syntyBones);
    assert.equal(resolved["Hips"], "Root");
    assert.equal(resolved["Pelvis"], "Pelvis");
    assert.equal(resolved["Shoulder_L"], "UpperArm_L");
    assert.equal(resolved["UpperLeg_L"], "Thigh_L");
  });

  it("resolves Rigify preset rigs correctly", () => {
    const rigifyBones = [
      "DEF-hips",
      "DEF-spine.001",
      "DEF-neck",
      "DEF-head",
      "DEF-upper_arm.L",
      "DEF-forearm.L",
      "DEF-thigh.R",
    ];
    const resolved = resolveBoneMapping(rigifyBones);
    assert.equal(resolved["Hips"], "DEF-hips");
    assert.equal(resolved["Spine_01"], "DEF-spine.001");
    assert.equal(resolved["Shoulder_L"], "DEF-upper_arm.L");
    assert.equal(resolved["UpperLeg_R"], "DEF-thigh.R");
  });

  it("resolves dynamic/custom bones matching aliases", () => {
    const customBones = ["root", "spine", "chest", "head", "upperleg_l", "lowerleg_l"];
    const resolved = resolveBoneMapping(customBones);
    assert.equal(resolved["Hips"], "root");
    assert.equal(resolved["Spine_01"], "spine");
    assert.equal(resolved["Spine_03"], "chest");
    assert.equal(resolved["Head"], "head");
    assert.equal(resolved["UpperLeg_L"], "upperleg_l");
  });
});
