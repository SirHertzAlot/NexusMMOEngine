/**
 * Procedural animals: gait maths, region segmentation of a static quadruped
 * mesh (on synthetic geometry, no licensed art), and the skinned rig's
 * pose: legs swing with speed, the attack telegraphs, death lays it down.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { advancePhase, attackPose, deathProgress, gaitAt, legCurve, MAX_SWEEP } from "../src/render/animal/gait.js";
import {
  BONE_BODY, BONE_FL, BONE_FR, BONE_HEAD, BONE_HL, BONE_HR, BONE_TAIL, findFrame, segmentQuadruped,
} from "../src/render/animal/segment.js";
import { AnimalTemplate } from "../src/render/animal/animal-rig.js";

/** A box from x/y/z ranges, with segments so its vertices cover its volume. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, seg = [1, 1, 1]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0, seg[0], seg[1], seg[2]);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** A dog-like animal, 1.2 m long facing +Z: body, a detailed head at the front, a thin tail, four legs. */
function quadruped(): THREE.BufferGeometry {
  const parts = [
    box(-0.2, 0.2, 0.4, 0.75, -0.5, 0.35, [4, 3, 8]),
    box(-0.12, 0.12, 0.6, 0.95, 0.35, 0.6, [3, 3, 3]), // head and neck
    box(-0.02, 0.02, 0.55, 0.65, -0.75, -0.5), // tail
  ];
  for (const x of [-0.14, 0.14]) {
    parts.push(box(x - 0.04, x + 0.04, 0, 0.4, 0.2, 0.3, [1, 3, 1])); // front legs
    parts.push(box(x - 0.04, x + 0.04, 0, 0.4, -0.45, -0.35, [1, 3, 1])); // hind legs
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
}

function turned(g: THREE.BufferGeometry, yaw: number): THREE.BufferGeometry {
  return g.clone().rotateY(yaw).translate(3, 2, -4);
}

describe("gait maths", () => {
  it("is still at rest and blends walk, trot, gallop with speed", () => {
    const still = gaitAt(0, 0.5);
    assert.equal(still.sweep, 0);
    assert.equal(still.freq, 0);
    const walk = gaitAt(1.0, 0.5);
    const trot = gaitAt(2.0, 0.5);
    const gallop = gaitAt(6.5, 0.5);
    assert.ok(walk.gait < 0.2 && trot.gait > 0.9 && trot.gait < 1.2 && gallop.gait > 1.9);
    assert.ok(walk.duty > trot.duty && trot.duty > gallop.duty, "feet spend less time down as it speeds up");
    assert.ok(walk.freq < gallop.freq);
    assert.ok(gallop.sweep <= MAX_SWEEP);
  });

  it("compares sizes by Froude number: a bigger animal changes gait at a higher speed", () => {
    assert.ok(gaitAt(2.0, 0.3).gait > gaitAt(2.0, 1.2).gait);
  });

  it("keeps stance feet from sliding: hip sweep x leg length matches the ground covered in stance", () => {
    const L = 0.6;
    const g = gaitAt(1.2, L);
    const stance = (g.duty / g.freq) * 1.2; // ground the body covers while a foot is down
    assert.ok(Math.abs(2 * L * Math.sin(g.sweep) - stance) < 0.02, `${2 * L * Math.sin(g.sweep)} vs ${stance}`);
  });

  it("walk touches down in lateral sequence, trot in diagonal pairs", () => {
    const walk = gaitAt(0.6, 0.5).offsets;
    const order = [0, 1, 2, 3].sort((a, b) => walk[a] - walk[b]); // FL FR HL HR
    assert.deepEqual(order, [2, 0, 3, 1], "HL, FL, HR, FR");
    const trot = gaitAt(2.0, 0.5).offsets;
    assert.ok(Math.abs(trot[0] - trot[3]) < 0.05 && Math.abs(trot[1] - trot[2]) < 0.05);
  });

  it("wraps the phase and the leg curve runs back in stance, forward in swing", () => {
    assert.ok(Math.abs(advancePhase(0.9, 1, 0.3) - 0.2) < 1e-9);
    const o = { angle: 0, lift: 0 };
    legCurve(0, 0.6, o);
    assert.equal(o.angle, 1);
    legCurve(0.3, 0.6, o);
    assert.ok(Math.abs(o.angle) < 1e-9 && o.lift === 0, "mid stance: under the hip, on the ground");
    legCurve(0.8, 0.6, o);
    assert.ok(o.lift > 0.9, "mid swing: foot lifted");
  });

  it("telegraphs an attack: windup before the hit frame, strike after, then recovery", () => {
    const o = { windup: 0, strike: 0 };
    attackPose(0.2, 0.5, 1, o);
    assert.ok(o.windup > 0 && o.windup < 1 && o.strike === 0);
    attackPose(0.45, 0.5, 1, o);
    assert.ok(o.windup > 0.95, "fully wound up as it lands");
    attackPose(0.6, 0.5, 1, o);
    assert.ok(o.strike > 0.95 && o.windup < 0.05);
    attackPose(0.99, 0.5, 1, o);
    assert.ok(o.strike < 0.05);
    attackPose(2, 0.5, 1, o);
    assert.deepEqual(o, { windup: 0, strike: 0 });
    assert.equal(deathProgress(0), 0);
    assert.equal(deathProgress(5), 1);
  });
});

describe("quadruped segmentation", () => {
  it("finds the head end and stands the mesh on y=0 facing +Z, whatever its orientation", () => {
    for (const yaw of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
      const g = turned(quadruped(), yaw);
      const frame = findFrame(g.getAttribute("position").array)!;
      const n = g.clone().rotateY(frame.yaw).translate(frame.dx, frame.dy, frame.dz);
      n.computeBoundingBox();
      const bb = n.boundingBox!;
      assert.ok(Math.abs(bb.min.y) < 1e-4, `feet on the ground (yaw ${yaw})`);
      // The head (the detailed end) is the front: the highest point sits at positive z.
      let top = -Infinity, topZ = 0;
      const p = n.getAttribute("position");
      for (let i = 0; i < p.count; i++) if (p.getY(i) > top) { top = p.getY(i); topZ = p.getZ(i); }
      assert.ok(topZ > 0.2, `head forward (yaw ${yaw}), got z ${topZ}`);
    }
  });

  it("weights each region to its bone and every vertex sums to one", () => {
    const g = quadruped();
    const seg = segmentQuadruped(g.getAttribute("position").array)!;
    assert.ok(seg, "a dog-shaped mesh segments");
    assert.ok(Math.abs(seg.legLength - 0.4) < 0.1, `leg length ${seg.legLength}`);
    const p = g.getAttribute("position");
    const dominant = (x: number, y: number, z: number): number => {
      let best = -1, bestDist = Infinity;
      for (let i = 0; i < p.count; i++) {
        const d = Math.hypot(p.getX(i) - x, p.getY(i) - y, p.getZ(i) - z);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      let bone = 0, bw = 0;
      for (let k = 0; k < 4; k++) if (seg.skinWeight[best * 4 + k] > bw) { bw = seg.skinWeight[best * 4 + k]; bone = seg.skinIndex[best * 4 + k]; }
      return bone;
    };
    assert.equal(dominant(0.18, 0, 0.3), BONE_FL, "front-left foot (x > 0, front)");
    assert.equal(dominant(-0.18, 0, 0.3), BONE_FR);
    assert.equal(dominant(0.18, 0, -0.4), BONE_HL);
    assert.equal(dominant(-0.18, 0, -0.4), BONE_HR);
    assert.equal(dominant(0, 0.95, 0.5), BONE_HEAD, "top of the head");
    assert.equal(dominant(0, 0.6, -0.75), BONE_TAIL, "tail tip");
    assert.equal(dominant(0, 0.6, 0), BONE_BODY, "middle of the back");
    for (let i = 0; i < p.count; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += seg.skinWeight[i * 4 + k];
      assert.ok(Math.abs(sum - 1) < 1e-4);
    }
  });

  it("leaves things that are not four-legged animals alone", () => {
    assert.equal(segmentQuadruped(box(-0.1, 0.1, 0, 3, -0.1, 0.1, [2, 6, 2]).getAttribute("position").array), null, "a pole");
    assert.equal(segmentQuadruped([0, 0, 0, 1, 1, 1]), null, "too few points");
  });
});

describe("AnimalRig", () => {
  const idle = { speed: 0, attackT: -1, hitAt: 0, attackDuration: 0, dead: false };

  function rig(): ReturnType<AnimalTemplate["create"]> {
    const template = AnimalTemplate.from(turned(quadruped(), Math.PI / 2))!;
    assert.ok(template);
    return template.create(new THREE.MeshBasicMaterial());
  }
  const leg = (r: ReturnType<typeof rig>, i: number): THREE.Object3D => r.skeleton.bones[i];

  it("builds a skinned mesh with seven bones and the geometry skin attributes", () => {
    const r = rig();
    assert.equal(r.skeleton.bones.length, 7);
    assert.ok(r.mesh.geometry.getAttribute("skinIndex") && r.mesh.geometry.getAttribute("skinWeight"));
  });

  it("stands still when idle and swings opposite diagonals in a trot", () => {
    const r = rig();
    for (let i = 0; i < 30; i++) r.update(1 / 60, idle);
    for (const b of [BONE_FL, BONE_FR, BONE_HL, BONE_HR]) assert.ok(Math.abs(leg(r, b).rotation.x) < 1e-6, "legs hang");
    let diag = 0, swung = 0;
    for (let i = 0; i < 240; i++) {
      r.update(1 / 60, { ...idle, speed: 2.0 });
      if (i > 120) {
        diag = Math.max(diag, Math.abs(leg(r, BONE_FL).rotation.x - leg(r, BONE_HR).rotation.x));
        swung = Math.max(swung, Math.abs(leg(r, BONE_FL).rotation.x));
      }
    }
    assert.ok(swung > 0.2, `legs swing (${swung})`);
    assert.ok(diag < 0.12, "front-left and hind-right move together in a trot");
  });

  it("plants the stance foot: it stays on the ground and does not slide against it", () => {
    const r = rig();
    const g = r.mesh.geometry;
    const w = g.getAttribute("skinWeight"), idx = g.getAttribute("skinIndex"), pos = g.getAttribute("position");
    let foot = -1;
    for (let i = 0; i < pos.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (idx.getComponent(i, k) === BONE_FL && w.getComponent(i, k) > 0.95 && (foot < 0 || pos.getY(i) < pos.getY(foot))) foot = i;
      }
    }
    assert.ok(foot >= 0);
    const v = 1.0, dt = 1 / 120;
    const p = new THREE.Vector3();
    let travelled = 0, minZ = Infinity, maxZ = -Infinity, maxY = 0, planted = 0, worst = 0, was = false;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(dt, { ...idle, speed: v });
      travelled += v * dt;
      if (i < 120 * 2) continue; // let the speed settle
      r.mesh.updateMatrixWorld(true);
      r.mesh.getVertexPosition(foot, p);
      if (p.y < 0.004) {
        planted++;
        if (!was) { minZ = Infinity; maxZ = -Infinity; }
        minZ = Math.min(minZ, p.z + travelled);
        maxZ = Math.max(maxZ, p.z + travelled);
        worst = Math.max(worst, maxZ - minZ);
      }
      was = p.y < 0.004;
      maxY = Math.max(maxY, p.y);
    }
    assert.ok(planted > 60, `the foot spends part of the cycle on the ground (${planted} frames)`);
    assert.ok(worst < 0.08, `planted foot slides ${worst.toFixed(3)} m over one stance`);
    assert.ok(maxY > 0.02, "and lifts in swing");
  });

  it("winds up before the hit frame, lowers the head, and lies down when dead", () => {
    const r = rig();
    for (let i = 0; i < 10; i++) r.update(1 / 60, idle);
    const headRest = leg(r, BONE_HEAD).rotation.x;
    r.update(1 / 60, { ...idle, attackT: 0.4, hitAt: 0.5, attackDuration: 1 });
    assert.ok(leg(r, BONE_HEAD).rotation.x > headRest + 0.2, "head down in the windup");
    for (let i = 0; i < 80; i++) r.update(1 / 60, { ...idle, dead: true });
    assert.ok(Math.abs(r.root.children[0].rotation.z) > 1.5, "rolled onto its side");
    assert.ok(Math.abs(leg(r, BONE_FL).rotation.x) < 1e-6, "legs limp, not walking");
  });

  it("holds the bind pose and spends nothing when far away", () => {
    const r = rig();
    r.update(1 / 60, { ...idle, speed: 3 });
    r.update(1 / 60, { ...idle, speed: 3 }, false);
    for (const b of r.skeleton.bones) assert.deepEqual(b.rotation.toArray().slice(0, 3), [0, 0, 0]);
  });

  it("disposes without touching the shared geometry or material", () => {
    const r = rig();
    const g = r.mesh.geometry;
    let disposed = false;
    g.addEventListener("dispose", () => (disposed = true));
    r.dispose();
    assert.equal(disposed, false);
  });
});

