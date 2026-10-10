/**
 * A procedural stand-in character and clip library: a blocky humanoid on a
 * rig with the real kit's bone names (Hips, Spine_01, UpperArm_R ...) and
 * clips named like the real library's (Idle_Loop, Walk_Loop, Sword_Regular_A
 * ...), made from sine waves.
 *
 * It is for tests, for the editor's Animation preview and for working on
 * the animation layer where the licensed art is not installed (the art
 * lives in <repo>/assets, which is never committed). It is not art and not
 * shipped: nothing in a game build imports it.
 */

import * as THREE from "three";
import type { AnimationClipInfo } from "./animations.js";

interface BoneDef {
  name: string;
  parent: string | null;
  /** Offset from the parent, metres. */
  at: [number, number, number];
  /** The box that shows the bone: [width, length, depth], hanging along `dir` from the bone. */
  box?: { size: [number, number, number]; dir: 1 | -1 | 0 };
}

// The rig faces +Z, y up, 1.8 m tall. Left is +x.
const RIG: BoneDef[] = [
  { name: "Hips", parent: null, at: [0, 0.95, 0], box: { size: [0.34, 0.16, 0.2], dir: 0 } },
  { name: "Spine_01", parent: "Hips", at: [0, 0.08, 0], box: { size: [0.32, 0.22, 0.2], dir: 1 } },
  { name: "Spine_02", parent: "Spine_01", at: [0, 0.22, 0], box: { size: [0.36, 0.26, 0.22], dir: 1 } },
  { name: "Head", parent: "Spine_02", at: [0, 0.3, 0], box: { size: [0.2, 0.24, 0.22], dir: 1 } },
  { name: "UpperArm_L", parent: "Spine_02", at: [0.24, 0.2, 0], box: { size: [0.1, 0.28, 0.1], dir: -1 } },
  { name: "LowerArm_L", parent: "UpperArm_L", at: [0, -0.28, 0], box: { size: [0.08, 0.26, 0.08], dir: -1 } },
  { name: "UpperArm_R", parent: "Spine_02", at: [-0.24, 0.2, 0], box: { size: [0.1, 0.28, 0.1], dir: -1 } },
  { name: "LowerArm_R", parent: "UpperArm_R", at: [0, -0.28, 0], box: { size: [0.08, 0.26, 0.08], dir: -1 } },
  { name: "UpperLeg_L", parent: "Hips", at: [0.1, -0.06, 0], box: { size: [0.14, 0.44, 0.14], dir: -1 } },
  { name: "LowerLeg_L", parent: "UpperLeg_L", at: [0, -0.44, 0], box: { size: [0.11, 0.42, 0.11], dir: -1 } },
  { name: "UpperLeg_R", parent: "Hips", at: [-0.1, -0.06, 0], box: { size: [0.14, 0.44, 0.14], dir: -1 } },
  { name: "LowerLeg_R", parent: "UpperLeg_R", at: [0, -0.44, 0], box: { size: [0.11, 0.42, 0.11], dir: -1 } },
];

const TINT: Record<string, number> = { Hips: 0x4a5a78, Spine: 0x6d86b8, Head: 0xe0b890, Arm: 0xc8a070, Leg: 0x3c4660 };
const tintOf = (name: string): THREE.Color => {
  const key = Object.keys(TINT).find((k) => name.startsWith(k)) ?? "Hips";
  return new THREE.Color(TINT[key]);
};

export interface StandIn {
  /** Add this to a scene; the bones and the skinned mesh are inside. */
  root: THREE.Group;
  bones: THREE.Bone[];
}

/** One skinned mesh (a box per bone, each weighted wholly to its bone) on the stand-in rig. */
export function buildStandIn(): StandIn {
  const bones = RIG.map((d) => {
    const b = new THREE.Bone();
    b.name = d.name;
    b.position.set(...d.at);
    return b;
  });
  const byName = new Map(bones.map((b) => [b.name, b]));
  const root = new THREE.Group();
  root.name = "StandIn";
  RIG.forEach((d, i) => (d.parent ? byName.get(d.parent)!.add(bones[i]) : root.add(bones[i])));
  root.updateMatrixWorld(true);

  const positions: number[] = [];
  const normals: number[] = [];
  const colours: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const index: number[] = [];
  RIG.forEach((d, i) => {
    if (!d.box) return;
    const [w, h, depth] = d.box.size;
    const box = new THREE.BoxGeometry(w, h, depth);
    // Hang the box along the bone's direction, in the bone's own space (bind pose: identity rotations).
    const world = bones[i].getWorldPosition(new THREE.Vector3());
    box.translate(world.x, world.y + (d.box.dir * h) / 2, world.z);
    const c = tintOf(d.name);
    const base = positions.length / 3;
    positions.push(...(box.getAttribute("position").array as Float32Array));
    normals.push(...(box.getAttribute("normal").array as Float32Array));
    for (let v = 0; v < box.getAttribute("position").count; v++) {
      colours.push(c.r, c.g, c.b);
      skinIndex.push(i, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
    index.push(...Array.from(box.index!.array, (n) => n + base));
    box.dispose();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(index);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  mesh.name = "StandInBody";
  mesh.frustumCulled = false;
  root.add(mesh);
  mesh.bind(new THREE.Skeleton(bones));
  return { root, bones };
}

// --------------------------------------------------------------- clips

type Pose = Record<string, (t: number) => [number, number, number]>;

const TAU = Math.PI * 2;

/** A looping/once clip from per-bone Euler functions of phase t (0..1), sampled at 30 Hz. */
function clipOf(name: string, duration: number, pose: Pose): THREE.AnimationClip {
  const steps = Math.max(2, Math.round(duration * 30));
  const times = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * duration);
  const tracks = Object.entries(pose).map(([bone, f]) => {
    const values: number[] = [];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let i = 0; i <= steps; i++) {
      e.set(...f(i / steps));
      q.setFromEuler(e);
      values.push(q.x, q.y, q.z, q.w);
    }
    return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
  });
  return new THREE.AnimationClip(name, duration, tracks);
}

const swing = (amp: number, phase = 0) => (t: number): [number, number, number] => [amp * Math.sin(TAU * t + phase), 0, 0];

/** A gait: legs and arms swing in opposition; the knee bends on the forward swing. */
function gait(name: string, duration: number, leg: number, arm: number, lean: number): THREE.AnimationClip {
  return clipOf(name, duration, {
    UpperLeg_L: swing(leg),
    UpperLeg_R: swing(leg, Math.PI),
    LowerLeg_L: (t) => [Math.max(0, -leg * 1.2 * Math.sin(TAU * t)), 0, 0],
    LowerLeg_R: (t) => [Math.max(0, leg * 1.2 * Math.sin(TAU * t)), 0, 0],
    UpperArm_L: swing(arm, Math.PI),
    UpperArm_R: swing(arm),
    Spine_01: () => [lean, 0, 0],
  });
}

/** The clips the default clip map names, plus a few more, in the real library's naming. */
export function buildStandInClips(): THREE.AnimationClip[] {
  const idle = clipOf("Idle_Loop", 2, {
    Spine_01: (t) => [0.03 * Math.sin(TAU * t), 0, 0],
    UpperArm_L: (t) => [0, 0, 0.12 + 0.02 * Math.sin(TAU * t)],
    UpperArm_R: (t) => [0, 0, -0.12 - 0.02 * Math.sin(TAU * t)],
  });
  return [
    idle,
    gait("Walk_Loop", 1.0, 0.5, 0.35, 0.04),
    gait("Jog_Fwd_Loop", 0.7, 0.8, 0.7, 0.12),
    gait("Sprint_Loop", 0.5, 1.0, 1.0, 0.25),
    clipOf("Swim_Fwd_Loop", 1.2, {
      Spine_01: () => [0.9, 0, 0],
      UpperArm_L: swing(1.6),
      UpperArm_R: swing(1.6, Math.PI),
      UpperLeg_L: swing(0.3, Math.PI),
      UpperLeg_R: swing(0.3),
    }),
    clipOf("Jump_Loop", 1, {
      UpperArm_L: () => [0, 0, 1.2],
      UpperArm_R: () => [0, 0, -1.2],
      UpperLeg_L: () => [0.5, 0, 0],
      LowerLeg_L: () => [0.9, 0, 0],
      UpperLeg_R: () => [-0.2, 0, 0],
    }),
    // Attacks: wind up, strike across the body, recover (sword arm and spine twist).
    ...(["A", "B", "C"] as const).map((v, i) =>
      clipOf(`Sword_Regular_${v}`, v === "C" ? 1.2 : 0.6, {
        UpperArm_R: (t) => {
          const k = Math.sin(Math.PI * Math.min(1, t * 1.15));
          return [-2.2 * k, 0, (i === 1 ? -1 : 1) * 0.6 * k];
        },
        LowerArm_R: (t) => [-0.6 * Math.sin(Math.PI * t), 0, 0],
        Spine_01: (t) => [0, (i === 1 ? -1 : 1) * -0.6 * Math.sin(Math.PI * t), 0],
        Spine_02: (t) => [0.15 * Math.sin(Math.PI * t), 0, 0],
      }),
    ),
    clipOf("Idle_Shield_Loop", 2, {
      UpperArm_L: () => [-1.1, 0, 0.35],
      LowerArm_L: () => [-1.3, 0, 0],
      Spine_01: (t) => [0.03 * Math.sin(TAU * t), 0, 0],
    }),
    clipOf("Hit_Reaction", 0.5, {
      Spine_01: (t) => [-0.5 * Math.sin(Math.PI * t), 0, 0],
      Spine_02: (t) => [-0.3 * Math.sin(Math.PI * t), 0, 0],
      Head: (t) => [-0.4 * Math.sin(Math.PI * t), 0, 0],
    }),
    clipOf("Cast_Spell", 1, {
      UpperArm_L: (t) => [-2.4 * Math.sin(Math.PI * t), 0, 0.3],
      UpperArm_R: (t) => [-2.4 * Math.sin(Math.PI * t), 0, -0.3],
    }),
  ];
}

/** Manifest-style info for the stand-in clips (loops, durations; the stand-in clips play in place). */
export function standInClipInfo(clips: THREE.AnimationClip[] = buildStandInClips()): AnimationClipInfo[] {
  return clips.map((c) => ({
    name: c.name,
    source: "stand-in",
    duration: c.duration,
    loop: /_Loop$/.test(c.name),
    travel: [0, 0],
  }));
}
