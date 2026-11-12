/**
 * Procedural animals: gait maths, region segmentation of a static quadruped
 * mesh (on synthetic geometry, no licensed art), and the skinned rig's
 * pose: legs swing with speed, the spine undulates and arches, the tail
 * follows as a lagged chain, the attack telegraphs, death lays it down.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { advancePhase, attackPose, deathProgress, gaitAt, legCurve, MAX_SWEEP } from "../src/gait.js";
import {
  BONE_BODY, BONE_FL, BONE_FR, BONE_HEAD, BONE_HL, BONE_HR, BONE_LOWER, BONE_LOIN, BONE_NECK,
  BONE_TAIL, BONE_TAIL1, BONE_TAIL2, findFrame, segmentQuadruped,
} from "../src/segment.js";
import { AnimalTemplate } from "../src/animal-rig.js";

/** A box from x/y/z ranges, with segments so its vertices cover its volume. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, seg = [1, 1, 1]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0, seg[0], seg[1], seg[2]);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** A dog-like animal, 1.2 m long facing +Z: body, a detailed head at the front, a thin tail,
 * four legs with haunch and shoulder mass (the upper legs carry them, as a real animal does). */
function quadruped(): THREE.BufferGeometry {
  const parts = [
    box(-0.2, 0.2, 0.4, 0.75, -0.5, 0.35, [4, 3, 8]),
    box(-0.12, 0.12, 0.6, 0.95, 0.35, 0.6, [3, 3, 3]), // head and neck
    box(-0.02, 0.02, 0.55, 0.65, -0.75, -0.5, [1, 1, 4]), // tail
  ];
  for (const x of [-0.14, 0.14]) {
    parts.push(box(x - 0.055, x + 0.055, 0.15, 0.6, 0.16, 0.34, [1, 3, 2])); // shoulder
    parts.push(box(x - 0.04, x + 0.04, 0, 0.4, 0.2, 0.3, [1, 3, 1])); // front legs
    parts.push(box(x - 0.055, x + 0.055, 0.15, 0.6, -0.44, -0.26, [1, 3, 2])); // haunch
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
    const o = { angle: 0, lift: 0, flex: 0 };
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
    assert.equal(dominant(0.18, 0, 0.3), BONE_LOWER, "front-left foot is on the lower leg bone (x > 0, front)");
    assert.equal(dominant(-0.18, 0, 0.3), BONE_LOWER + 1);
    assert.equal(dominant(0.18, 0, -0.4), BONE_LOWER + 2);
    assert.equal(dominant(-0.18, 0, -0.4), BONE_LOWER + 3);
    assert.equal(dominant(0.18, 0.27, 0.3), BONE_FL, "above the knee it is the upper leg");
    assert.equal(dominant(-0.18, 0.27, -0.4), BONE_HR);
    assert.equal(dominant(0.18, 0.45, 0.25), BONE_FL, "the shoulder mass swings with the front leg");
    assert.equal(dominant(-0.18, 0.45, -0.35), BONE_HR, "the haunch swings with the hind leg");
    assert.ok(seg.kneeHeight > 0.35 * seg.legLength && seg.kneeHeight < 0.65 * seg.legLength, `knee ${seg.kneeHeight} of leg ${seg.legLength}`);
    assert.ok(Math.abs(segmentQuadruped(g.getAttribute("position").array, { knee: 0.45 })!.kneeHeight - 0.45 * seg.legLength) < 1e-6, "a hint moves the knee");
    assert.equal(dominant(0, 0.95, 0.5), BONE_HEAD, "top of the head");
    assert.equal(dominant(0, 0.6, -0.75), BONE_TAIL2, "tail tip is the end of the chain");
    assert.equal(dominant(0, 0.6, -0.68), BONE_TAIL1, "tail middle follows the root");
    assert.equal(dominant(0, 0.6, 0), BONE_BODY, "middle of the back is the chest");
    assert.equal(dominant(0, 0.6, -0.3), BONE_LOIN, "the rump is the loin, which carries the hind legs");
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

  it("builds a skinned mesh with the full anatomical skeleton and the geometry skin attributes", () => {
    const r = rig();
    assert.equal(r.skeleton.bones.length, 15);
    assert.equal(r.skeleton.bones[BONE_LOWER].parent, r.skeleton.bones[BONE_FL], "the lower leg hangs off the upper leg");
    assert.equal(r.skeleton.bones[BONE_HEAD].parent, r.skeleton.bones[BONE_NECK], "the head hangs off the neck");
    assert.equal(r.skeleton.bones[BONE_LOIN].parent, r.skeleton.bones[BONE_BODY], "the loin follows the chest");
    assert.equal(r.skeleton.bones[BONE_HL].parent, r.skeleton.bones[BONE_LOIN], "the hind leg swings from the loin (pelvis)");
    assert.equal(r.skeleton.bones[BONE_TAIL].parent, r.skeleton.bones[BONE_LOIN], "the tail grows out of the loin");
    assert.equal(r.skeleton.bones[BONE_TAIL2].parent, r.skeleton.bones[BONE_TAIL1], "the tail is a chain");
    assert.ok(r.mesh.geometry.getAttribute("skinIndex") && r.mesh.geometry.getAttribute("skinWeight"));
  });

  it("stands still when idle and swings opposite diagonals in a trot", () => {
    const r = rig();
    for (let i = 0; i < 30; i++) r.update(1 / 60, idle);
    for (const b of [BONE_FL, BONE_FR, BONE_HL, BONE_HR]) assert.ok(Math.abs(leg(r, b).rotation.x) < 1e-6, "legs hang");
    for (const b of [BONE_LOIN, BONE_NECK, BONE_BODY]) assert.ok(Math.abs(leg(r, b).rotation.y) < 1e-6, "the spine is quiet");
    // Diagonal coupling, measured where it matters: the feet. In a trot the front-left and
    // hind-right feet stride together (the upper bones differ by the femur's counter-flexion).
    const fl = sole(r, 0), hr = sole(r, 3), fr = sole(r, 1);
    const zf: number[] = [], zh: number[] = [], zr: number[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < 240; i++) {
      r.update(1 / 60, { ...idle, speed: 2.0 });
      if (i > 120) {
        r.mesh.updateMatrixWorld(true);
        zf.push(soleAt(r, fl, p).z);
        zh.push(soleAt(r, hr, p.clone()).z);
        zr.push(soleAt(r, fr, p.clone()).z);
      }
    }
    const spread = (a: number[]): number => Math.max(...a) - Math.min(...a);
    const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    const resid = (a: number[], b: number[]): number => {
      const ma = mean(a), mb = mean(b);
      return spread(a.map((v, i) => (v - ma) - (b[i]! - mb)));
    };
    assert.ok(spread(zf) > 0.15, `the foot strides (${spread(zf).toFixed(3)} m)`);
    const diag = resid(zf, zh), lat = resid(zf, zr);
    assert.ok(diag < 0.35 * lat, `diagonal feet move together (diag ${diag.toFixed(3)} vs lateral ${lat.toFixed(3)})`);
  });

  it("plants the stance foot: it stays on the ground and does not slide against it", () => {
    const r = rig();
    const verts = sole(r, 0);
    const v = 1.0, dt = 1 / 120;
    const p = new THREE.Vector3();
    let travelled = 0, minZ = Infinity, maxZ = -Infinity, maxY = 0, planted = 0, worst = 0, was = false;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(dt, { ...idle, speed: v });
      travelled += v * dt;
      if (i < 120 * 2) continue; // let the speed settle
      r.mesh.updateMatrixWorld(true);
      soleAt(r, verts, p);
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

  /** The vertices of a leg's sole (lowest points of its lower bone) and where their centre is now. */
  function sole(r: ReturnType<typeof rig>, leg: number): number[] {
    const g = r.mesh.geometry;
    const w = g.getAttribute("skinWeight"), idx = g.getAttribute("skinIndex"), pos = g.getAttribute("position");
    const out: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (idx.getComponent(i, k) === BONE_LOWER + leg && w.getComponent(i, k) > 0.95 && pos.getY(i) < 0.001) out.push(i);
      }
    }
    assert.ok(out.length >= 4);
    return out;
  }
  const soleAt = (r: ReturnType<typeof rig>, verts: number[], out: THREE.Vector3): THREE.Vector3 => {
    const t = new THREE.Vector3();
    out.set(0, 0, 0);
    for (const v of verts) out.add(r.mesh.getVertexPosition(v, t));
    return out.multiplyScalar(1 / verts.length);
  };

  it("flexes the knee only in swing: straight when the foot is planted, bent when it is up", () => {
    const r = rig();
    const verts = sole(r, 0);
    const p = new THREE.Vector3();
    let peak = 0, bentOnGround = 0, straightInAir = 0;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(1 / 120, { ...idle, speed: 0.8 });
      if (i < 240) continue;
      r.mesh.updateMatrixWorld(true);
      soleAt(r, verts, p);
      const flex = Math.abs(leg(r, BONE_LOWER).rotation.x);
      peak = Math.max(peak, flex);
      if (p.y < 0.004 && flex > 0.15) bentOnGround++;
      if (p.y > 0.03 && flex < 0.02) straightInAir++;
    }
    assert.ok(peak > 0.4, `the knee bends in swing (${peak.toFixed(2)} rad)`);
    assert.equal(bentOnGround, 0, "never bent while the foot is on the ground");
    assert.equal(straightInAir, 0, "never straight while the foot is well off the ground");
  });

  it("swings the upper leg in an arc symmetric about vertical at a walk", () => {
    const r = rig();
    let hi = -Infinity, lo = Infinity, sum = 0, n = 0;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(1 / 120, { ...idle, speed: 0.8 });
      if (i < 240) continue;
      const a = leg(r, BONE_FL).rotation.x;
      hi = Math.max(hi, a);
      lo = Math.min(lo, a);
      sum += a;
      n++;
    }
    assert.ok(hi > 0.2 && lo < -0.2, `swings both ways (${lo.toFixed(2)} .. ${hi.toFixed(2)})`);
    // The shoulder's counter-flexion deepens the forward reach in swing (the humerus reaches as
    // the carpus folds), so the arc is allowed to lean forward — but only by a small share.
    assert.ok(Math.abs(hi + lo) < 0.25 * (hi - lo), "peak forward roughly equals peak back");
    // The mean is not zero (stance is slower than swing), but it stays a small share of the range.
    assert.ok(Math.abs(sum / n) < 0.3 * (hi - lo));
  });

  it("articulates hips with 3-axis rotation: yaw and roll coordinate with spine undulation", () => {
    const r = rig();
    let maxFrontYaw = 0, maxHindYaw = 0, maxFrontRoll = 0, maxHindRoll = 0;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(1 / 120, { ...idle, speed: 1.2 });
      if (i < 120) continue;
      maxFrontYaw = Math.max(maxFrontYaw, Math.abs(leg(r, BONE_FL).rotation.y));
      maxHindYaw = Math.max(maxHindYaw, Math.abs(leg(r, BONE_HL).rotation.y));
      maxFrontRoll = Math.max(maxFrontRoll, Math.abs(leg(r, BONE_FL).rotation.z));
      maxHindRoll = Math.max(maxHindRoll, Math.abs(leg(r, BONE_HL).rotation.z));
    }
    assert.ok(maxFrontYaw > 0.03, `front hip yaws to track ground (${maxFrontYaw.toFixed(3)} rad)`);
    assert.ok(maxHindYaw > 0.05, `hind hip yaws to coordinate with loin (${maxHindYaw.toFixed(3)} rad)`);
    assert.ok(maxFrontRoll > 0.02, `front shoulder rolls with weight bearing (${maxFrontRoll.toFixed(3)} rad)`);
    assert.ok(maxHindRoll > 0.02, `hind hip rolls with pelvic sway (${maxHindRoll.toFixed(3)} rad)`);
  });

  it("bends the hind hock the opposite way to the front knee", () => {
    const r = rig();
    let front = 0, hind = 0;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(1 / 120, { ...idle, speed: 2.0 });
      const f = leg(r, BONE_LOWER).rotation.x, h = leg(r, BONE_LOWER + 2).rotation.x;
      if (Math.abs(f) > Math.abs(front)) front = f;
      if (Math.abs(h) > Math.abs(hind)) hind = h;
    }
    assert.ok(front > 0.5 && hind < -0.4, `front knee ${front.toFixed(2)}, hind hock ${hind.toFixed(2)}`);
  });

  it("locomotes with the spine: the loin leads the lateral wave and arches harder at a gallop", () => {
    const r = rig();
    let loinYawWalk = 0, chestYawWalk = 0, loinPitchWalk = 0, loinPitchGallop = 0;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(1 / 120, { ...idle, speed: i < 360 ? 1.2 : 6.0 });
      if (i < 120) continue;
      if (i < 360) {
        loinYawWalk = Math.max(loinYawWalk, Math.abs(leg(r, BONE_LOIN).rotation.y));
        chestYawWalk = Math.max(chestYawWalk, Math.abs(leg(r, BONE_BODY).rotation.y));
        loinPitchWalk = Math.max(loinPitchWalk, Math.abs(leg(r, BONE_LOIN).rotation.x));
      } else {
        loinPitchGallop = Math.max(loinPitchGallop, Math.abs(leg(r, BONE_LOIN).rotation.x));
      }
    }
    assert.ok(loinYawWalk > 0.05, `the spine undulates (${loinYawWalk.toFixed(3)} rad)`);
    assert.ok(loinYawWalk > chestYawWalk * 1.5, "the loin leads, the chest follows smaller");
    assert.ok(loinPitchGallop > loinPitchWalk * 1.5, `the gallop bounds the back (${loinPitchWalk.toFixed(3)} -> ${loinPitchGallop.toFixed(3)})`);
  });

  it("carries the tail as a lagged chain that whips with the stride", () => {
    const r = rig();
    const peak = [0, 0, 0];
    for (let i = 0; i < 120 * 6; i++) {
      r.update(1 / 120, { ...idle, speed: 2.0 });
      if (i < 120) continue;
      peak[0] = Math.max(peak[0], Math.abs(leg(r, BONE_TAIL).rotation.y));
      peak[1] = Math.max(peak[1], Math.abs(leg(r, BONE_TAIL1).rotation.y));
      peak[2] = Math.max(peak[2], Math.abs(leg(r, BONE_TAIL2).rotation.y));
    }
    for (const b of [0, 1, 2]) assert.ok(peak[b] > 0.05, `tail segment ${b} swings (${peak[b].toFixed(3)})`);
    assert.ok(peak[2]! > peak[0]!, "the tip travels farther than the root (a whip, not a plank)");
  });

  it("holds the head level: the neck answers the loin's arch", () => {
    const r = rig();
    let loinPitch = 0, neckPitch = 0, opposite = 0, n = 0;
    for (let i = 0; i < 120 * 6; i++) {
      r.update(1 / 120, { ...idle, speed: 6.0 });
      if (i < 240) continue;
      const lp = leg(r, BONE_LOIN).rotation.x, np = leg(r, BONE_NECK).rotation.x;
      loinPitch = Math.max(loinPitch, Math.abs(lp));
      neckPitch = Math.max(neckPitch, Math.abs(np));
      if (Math.abs(lp) > 0.02) { opposite += lp * np < 0 ? 1 : 0; n++; }
    }
    assert.ok(neckPitch > 0.02, `the neck pitches (${neckPitch.toFixed(3)})`);
    assert.ok(n > 0 && opposite / n > 0.7, "the neck counters the loin most of the cycle");
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

  it("applies species-specific trademark kinematics for bears, boars, canines and caprines", () => {
    const mat = new THREE.MeshBasicMaterial();
    const geom = turned(quadruped(), Math.PI / 2);

    // 1. Bear: rears up tall on hind legs during windup, swipes paw during strike
    const bearT = AnimalTemplate.from(geom, undefined, "Bear_0PXWfxfb0Hu")!;
    assert.ok(bearT);
    const bear = bearT.create(mat);
    assert.equal(bear.species, "bear");
    bear.update(1 / 60, { ...idle, attackT: 0.35, hitAt: 0.5, attackDuration: 1 });
    assert.ok(bear.skeleton.bones[BONE_BODY].position.y > 0.1, "bear chest lifts when rearing tall");
    assert.ok(bear.skeleton.bones[BONE_BODY].rotation.x < -0.2, "bear chest pitches up as it rears");
    // In strike (attackT > hitAt): horizontal paw swipe
    bear.update(1 / 60, { ...idle, attackT: 0.65, hitAt: 0.5, attackDuration: 1 });
    assert.ok(Math.abs(bear.skeleton.bones[BONE_FR].rotation.y) > 0.2, "bear paw executes horizontal swipe");

    // 2. Boar: low rooting posture, upward tusk goring head toss in strike
    const boarT = AnimalTemplate.from(geom, undefined, "Boar_57fSWum6F1P")!;
    assert.ok(boarT);
    const boar = boarT.create(mat);
    assert.equal(boar.species, "boar");
    boar.update(1 / 60, idle);
    assert.ok(boar.skeleton.bones[BONE_NECK].rotation.x > 0.2, "boar head pitched low for soil rooting");
    boar.update(1 / 60, { ...idle, attackT: 0.65, hitAt: 0.5, attackDuration: 1 });
    assert.ok(boar.skeleton.bones[BONE_NECK].rotation.x < 0.1, "boar thrusts head violently upward in tusk goring strike");

    // 3. Canine: sleek prowl posture
    const wolfT = AnimalTemplate.from(geom, undefined, "Wolf_Stalker")!;
    assert.ok(wolfT);
    const wolf = wolfT.create(mat);
    assert.equal(wolf.species, "canine");
    wolf.update(1 / 60, { ...idle, speed: 0.8 });
    assert.ok(wolf.skeleton.bones[BONE_NECK].rotation.x > 0.1, "canine lowers neck into predatory prowl stalk");

    // 4. Caprine: spurring and head-down horn ramming
    const goatT = AnimalTemplate.from(geom, undefined, "Goat_Ram")!;
    assert.ok(goatT);
    const goat = goatT.create(mat);
    assert.equal(goat.species, "caprine");
    goat.update(1 / 60, { ...idle, attackT: 0.35, hitAt: 0.5, attackDuration: 1 });
    assert.ok(goat.skeleton.bones[BONE_NECK].rotation.x > 0.2, "caprine tucks horns down before charge");
  });
});

