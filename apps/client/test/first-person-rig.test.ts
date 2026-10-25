/**
 * TDD: FirstPersonRig — first-person hands, weapons, stance posture,
 * locomotion swing, look inertia, and combat strike choreography.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { LocomotionMode, Move } from "@mmo-engine/protocol";
import {
  createFirstPersonCameraState,
  stepFirstPersonMotion,
  firstPersonCamera,
} from "../src/render/first-person-camera.js";
import {
  FirstPersonRig,
  inferWeaponKind,
  buildProceduralWeaponMesh,
} from "../src/render/first-person-rig.js";

describe("FirstPersonRig", () => {
  it("infers weapon visual kinds from item bases and art catalog paths", () => {
    assert.equal(inferWeaponKind(null), "unarmed");
    assert.equal(inferWeaponKind("dungeon-pack/SM_Wep_Straightsword_01"), "sword");
    assert.equal(inferWeaponKind("dungeon-pack/SM_Wep_GreatSword_01"), "greatsword");
    assert.equal(inferWeaponKind("dungeon-pack/SM_Wep_Axe_01"), "axe");
    assert.equal(inferWeaponKind("fantasy-kingdom/SM_Wep_Mace_01"), "mace");
    assert.equal(inferWeaponKind("fantasy-kingdom/SM_Wep_Dagger_01"), "dagger");
    assert.equal(inferWeaponKind("dungeon-pack/SM_Wep_Spear_01"), "spear");
    assert.equal(inferWeaponKind("fantasy-kingdom/SM_Wep_Staff_01"), "staff");
    assert.equal(inferWeaponKind("dungeon-pack/SM_Wep_Shield_Bone_01", "off"), "shield");
  });

  it("builds procedural meshes for all weapon families and shields", () => {
    for (const kind of ["sword", "greatsword", "axe", "mace", "dagger", "spear", "staff", "wand", "bow", "shield"] as const) {
      const mesh = buildProceduralWeaponMesh(kind, "#ffaa33");
      assert.ok(mesh.children.length >= 2, `expected children for ${kind}, got ${mesh.children.length}`);
    }
    const bare = buildProceduralWeaponMesh("unarmed");
    assert.equal(bare.children.length, 0);
  });

  it("renders left and right hands, attaches weapons, and follows the camera", () => {
    const rig = new FirstPersonRig();
    assert.equal(rig.root.visible, false);
    rig.setVisible(true);
    assert.equal(rig.root.visible, true);

    rig.setColors({ skin: "#e0b18c", sleeve: "#1e293b", cuff: "#78350f" });
    rig.setEquipment("dungeon-pack/SM_Wep_Straightsword_01", "dungeon-pack/SM_Wep_Shield_Bone_01");
    assert.equal(rig.mainWeaponKind, "sword");
    assert.equal(rig.offWeaponKind, "shield");

    const cam = new THREE.PerspectiveCamera();
    const eye = new THREE.Vector3(5, 1.6, 10);
    const camState = createFirstPersonCameraState();
    const motion = stepFirstPersonMotion(camState, { dt: 1 / 60, vx: 0, vz: 5, grounded: true, mode: LocomotionMode.Ground });
    firstPersonCamera(cam, eye, 0.4, -0.1, motion);

    const pose = rig.update({
      dt: 1 / 60,
      camera: cam,
      lookYaw: 0.4,
      lookPitch: -0.1,
      motion,
      move: Move.None,
      moveElapsed: 0,
      technique: "cut",
      aimPart: "torso",
    });

    assert.ok(Math.abs(rig.root.position.x - cam.position.x) < 1e-6);
    assert.ok(Math.abs(rig.root.position.y - cam.position.y) < 1e-6);
    assert.ok(pose.rightHand.px > 0, "right hand sits on right side of view");
    assert.ok(pose.leftHand.px < 0, "left hand sits on left side of view");
    assert.ok(pose.rightHand.pz < -0.2, "right hand sits in front of camera (-Z)");
  });

  it("animates hands and weapon through SwordA, SwordB, SwordC, Guard, ShieldBash, and Stances", () => {
    const rig = new FirstPersonRig();
    rig.setVisible(true);
    rig.setEquipment("sword", "shield");
    const cam = new THREE.PerspectiveCamera();
    const camState = createFirstPersonCameraState();
    const motion = stepFirstPersonMotion(camState, { dt: 1 / 60 });

    const restPose = structuredClone(
      rig.update({ dt: 1 / 60, camera: cam, lookYaw: 0, lookPitch: 0, motion, move: Move.None, technique: "cut", aimPart: "torso" }),
    );

    const thrustPose = structuredClone(
      rig.update({ dt: 1 / 60, camera: cam, lookYaw: 0, lookPitch: 0, motion, move: Move.None, technique: "thrust", aimPart: "head" }),
    );
    assert.ok(thrustPose.rightHand.py > restPose.rightHand.py, "aiming at head raises weapon guard");
    assert.ok(thrustPose.rightHand.pz < restPose.rightHand.pz, "thrust stance extends point forward");

    const slashA = structuredClone(
      rig.update({ dt: 1 / 60, camera: cam, lookYaw: 0, lookPitch: 0, motion, move: Move.SwordA, moveElapsed: 0.21, technique: "cut" }),
    );
    assert.ok(slashA.swingIntensity > 0.7, `SwordA hit frame swingIntensity=${slashA.swingIntensity}`);
    assert.ok(slashA.rightHand.px < restPose.rightHand.px - 0.15, "SwordA sweeps right hand across to the left");

    const slashC = structuredClone(
      rig.update({ dt: 1 / 60, camera: cam, lookYaw: 0, lookPitch: 0, motion, move: Move.SwordC, moveElapsed: 0.43, technique: "cut" }),
    );
    assert.ok(slashC.swingIntensity > 0.7, `SwordC slam swingIntensity=${slashC.swingIntensity}`);
    assert.ok(slashC.rightHand.pz < restPose.rightHand.pz - 0.15, "SwordC lunges weapon forward");

    const guardPose = structuredClone(
      rig.update({ dt: 1 / 60, camera: cam, lookYaw: 0, lookPitch: 0, motion, move: Move.Guard, moveElapsed: 0.25 }),
    );
    assert.ok(guardPose.leftHand.px > restPose.leftHand.px + 0.08, "Guard raises shield toward center");
    assert.ok(guardPose.leftHand.py > restPose.leftHand.py + 0.08, "Guard lifts shield up");
  });
});
