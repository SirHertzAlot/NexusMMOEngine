/**
 * Retargeting: a source clip on another skeleton — branching bones, other
 * bone frames, a Z-up source, a clip that animates its own root node —
 * points our limbs where the source points its own.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Retargeter } from "../src/convert/retarget.js";

interface Rig {
  scene: THREE.Group;
  bones: Map<string, THREE.Bone>;
}

/**
 * A little humanoid in a T-pose facing +Z: Hips → Spine → Head, the arms
 * off the spine and the legs off the hips (branches). `frame` turns every
 * bone's local frame (the child offsets are kept in world terms), as
 * different rigs do.
 */
function humanoid(names: Record<string, string>, frame: THREE.Quaternion, unit = 1): Rig {
  const scene = new THREE.Group();
  const bones = new Map<string, THREE.Bone>();
  const layout: Array<[string, string | null, [number, number, number]]> = [
    ["Hips", null, [0, 1, 0]],
    ["Spine", "Hips", [0, 0.3, 0]],
    ["Head", "Spine", [0, 0.4, 0]],
    ["ArmL", "Spine", [0.2, 0.3, 0]],
    ["ForeL", "ArmL", [0.3, 0, 0]],
    ["HandL", "ForeL", [0.25, 0, 0]],
    ["ArmR", "Spine", [-0.2, 0.3, 0]],
    ["ForeR", "ArmR", [-0.3, 0, 0]],
    ["ThighL", "Hips", [0.1, -0.05, 0]],
    ["ShinL", "ThighL", [0, -0.45, 0]],
    ["FootL", "ShinL", [0, -0.45, 0]],
    ["ThighR", "Hips", [-0.1, -0.05, 0]],
    ["ShinR", "ThighR", [0, -0.45, 0]],
  ];
  for (const [key, parentKey, offset] of layout) {
    const b = new THREE.Bone();
    b.name = names[key] ?? key;
    const parent = parentKey ? bones.get(parentKey)! : scene;
    parent.add(b);
    scene.updateMatrixWorld(true);
    // World offset → the parent's local frame; every bone has the odd frame.
    const parentWorld = parent.getWorldQuaternion(new THREE.Quaternion());
    b.position.set(...offset).multiplyScalar(unit).applyQuaternion(parentWorld.clone().invert());
    b.quaternion.copy(parentWorld.clone().invert().multiply(frame));
    bones.set(key, b);
  }
  scene.updateMatrixWorld(true);
  return { scene, bones };
}

const OURS: Record<string, string> = {
  Hips: "Hips", Spine: "Spine_01", Head: "Head", ArmL: "Shoulder_L", ForeL: "Elbow_L", HandL: "Hand_L",
  ArmR: "Shoulder_R", ForeR: "Elbow_R", ThighL: "UpperLeg_L", ShinL: "LowerLeg_L", FootL: "Ankle_L",
  ThighR: "UpperLeg_R", ShinR: "LowerLeg_R",
};
const THEIRS: Record<string, string> = Object.fromEntries(Object.keys(OURS).map((k) => [k, `src_${k}`]));
const MAP = Object.fromEntries(Object.entries(OURS).map(([k, ours]) => [ours, THEIRS[k]]));

/** A clip bending the source's left arm down and its right knee, over one second. */
function clipFor(src: Rig): THREE.AnimationClip {
  const bend = (key: string, axis: THREE.Vector3, angle: number): THREE.QuaternionKeyframeTrack => {
    const b = src.bones.get(key)!;
    const rest = b.quaternion.clone();
    // A world-space turn at the joint, expressed locally.
    const parentWorld = b.parent!.getWorldQuaternion(new THREE.Quaternion());
    const turn = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const end = parentWorld.clone().invert().multiply(turn).multiply(parentWorld).multiply(rest);
    return new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, [0, 1], [...rest.toArray(), ...end.toArray()]);
  };
  return new THREE.AnimationClip("test", 1, [
    bend("ArmL", new THREE.Vector3(0, 0, 1), -Math.PI / 2),
    bend("ShinR", new THREE.Vector3(1, 0, 0), Math.PI / 3),
  ]);
}

function direction(rig: Rig, from: string, to: string): THREE.Vector3 {
  const a = rig.bones.get(from)!.getWorldPosition(new THREE.Vector3());
  return rig.bones.get(to)!.getWorldPosition(new THREE.Vector3()).sub(a).normalize();
}

function check(src: Rig, ours: Rig, clip: THREE.AnimationClip, retargeter: Retargeter): void {
  const out = retargeter.retarget(clip, 10);
  const mixer = new THREE.AnimationMixer(ours.scene);
  const action = mixer.clipAction(out.clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(1);
  ours.scene.updateMatrixWorld(true);
  // The source at the same moment (in the frame the retargeter stood it in).
  const sm = new THREE.AnimationMixer(src.scene);
  const sa = sm.clipAction(clip);
  sa.setLoop(THREE.LoopOnce, 1);
  sa.clampWhenFinished = true;
  sa.play();
  sm.setTime(1);
  src.scene.parent?.updateMatrixWorld(true);
  src.scene.updateMatrixWorld(true);
  for (const [a, b] of [["ArmL", "ForeL"], ["ForeL", "HandL"], ["ShinR", "ThighR"], ["ThighL", "ShinL"], ["Spine", "Head"], ["ArmR", "ForeR"]]) {
    const want = direction(src, a, b);
    const got = direction(ours, a, b);
    assert.ok(want.angleTo(got) < 1e-3, `${a}→${b}: want ${want.toArray().map((v) => v.toFixed(3))}, got ${got.toArray().map((v) => v.toFixed(3))}`);
  }
}

describe("Retargeter", () => {
  it("drives every branch of a skeleton with other bone frames", () => {
    const src = humanoid(THEIRS, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.7)));
    const ours = humanoid(OURS, new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.9, 0.3, 1.2)));
    check(src, ours, clipFor(src), new Retargeter({ scene: src.scene, hips: "src_Hips", map: MAP }, { scene: ours.scene, hips: "Hips" }));
    // The left arm hangs down now, as the source's does.
    assert.ok(direction(ours, "ArmL", "ForeL").y < -0.99);
  });

  it("stands a Z-up source up, in centimetres", () => {
    const src = humanoid(THEIRS, new THREE.Quaternion(), 100);
    src.scene.rotation.x = Math.PI / 2; // Z-up, facing -Y
    src.scene.updateMatrixWorld(true);
    const ours = humanoid(OURS, new THREE.Quaternion());
    const r = new Retargeter({ scene: src.scene, hips: "src_Hips", map: MAP }, { scene: ours.scene, hips: "Hips" });
    assert.ok(Math.abs(r.scale - 0.01) < 1e-6, `hip scale ${r.scale}`);
    check(src, ours, clipFor(src), r);
  });

  it("keeps a clip's own root node from undoing the turn (rootFrom)", () => {
    const src = humanoid(THEIRS, new THREE.Quaternion());
    src.scene.name = "Armature";
    const ours = humanoid(OURS, new THREE.Quaternion());
    // The clip lays its armature node down (Z-up), as some FBX exports do.
    const clip = clipFor(src);
    const down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2).toArray();
    clip.tracks.push(new THREE.QuaternionKeyframeTrack("Armature.quaternion", [0, 1], [...down, ...down]));
    const r = new Retargeter({ scene: src.scene, hips: "src_Hips", map: MAP, rootFrom: clip }, { scene: ours.scene, hips: "Hips" });
    check(src, ours, clip, r);
    assert.ok(direction(ours, "Spine", "Head").y > 0.99, "upright");
  });
});
