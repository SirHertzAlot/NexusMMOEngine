/**
 * Foot IK (EA21): two-bone inverse kinematics for planting feet on the ground.
 *
 * After the animation mixer runs, each foot bone is raycast down to find the
 * ground. If the animated foot is above or below the ground, the thigh and
 * shin joints are rotated to bring the foot to the ground height, keeping
 * the knee bending in its natural direction.
 *
 * Two-bone IK math:
 * - a = thigh length, b = shin length, d = clamped distance hip→target
 * - cos(angle at hip) = (a² + d² - b²) / (2·a·d)  (law of cosines)
 * - The knee is placed along the bend direction (the animated knee's pole).
 */

import * as THREE from "three";

const _hipPos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _kneeDir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();

export interface FootIkChain {
  /** Thigh bone (hip→knee). */
  thigh: THREE.Object3D;
  /** Shin bone (knee→ankle). */
  shin: THREE.Object3D;
  /** Foot/ankle bone (the end effector). */
  foot: THREE.Object3D;
  /** Length thigh→knee, in world units. */
  thighLen: number;
  /** Length knee→ankle, in world units. */
  shinLen: number;
}

function boneLength(parent: THREE.Object3D, child: THREE.Object3D): number {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  parent.getWorldPosition(a);
  child.getWorldPosition(b);
  return a.distanceTo(b);
}

/** Find thigh/shin/foot bones by name convention. Returns null if not found. */
export function findFootChain(root: THREE.Object3D, side: "L" | "R"): FootIkChain | null {
  // Common naming: "Thigh_L", "thigh.l", "mixamorigLeftUpLeg", etc.
  // Try several conventions.
  const candidates: Array<[string, string, string]> = [
    [`Thigh_${side}`, `Shin_${side}`, `Foot_${side}`],
    [`thigh.${side.toLowerCase()}`, `shin.${side.toLowerCase()}`, `foot.${side.toLowerCase()}`],
    [`UpperLeg_${side}`, `LowerLeg_${side}`, `Foot_${side}`],
  ];
  // Mixamo: LeftUpLeg / LeftLeg / LeftFoot.
  const mixamoSide = side === "L" ? "Left" : "Right";
  candidates.push([`${mixamoSide}UpLeg`, `${mixamoSide}Leg`, `${mixamoSide}Foot`]);

  for (const [thighName, shinName, footName] of candidates) {
    const thigh = root.getObjectByName(thighName);
    const shin = root.getObjectByName(shinName);
    const foot = root.getObjectByName(footName);
    if (thigh && shin && foot) {
      return {
        thigh,
        shin,
        foot,
        thighLen: boneLength(thigh, shin),
        shinLen: boneLength(shin, foot),
      };
    }
  }
  return null;
}

/**
 * Solve two-bone IK: rotate thigh and shin so the foot reaches `target`.
 * `poleDir` is the direction the knee should point (world space).
 * Modifies the bones' quaternions in place.
 */
export function solveTwoBoneIk(chain: FootIkChain, target: THREE.Vector3, poleDir: THREE.Vector3): void {
  const { thigh, shin, thighLen, shinLen } = chain;
  thigh.getWorldPosition(_hipPos);
  _dir.subVectors(target, _hipPos);
  let d = _dir.length();
  // Clamp to reachable range (avoid over-extension and collapse).
  const maxReach = thighLen + shinLen - 1e-4;
  const minReach = Math.abs(thighLen - shinLen) + 1e-4;
  d = THREE.MathUtils.clamp(d, minReach, maxReach);
  _dir.normalize();

  // Angle at the hip between hip→target and hip→knee (law of cosines).
  const cosHip = THREE.MathUtils.clamp((thighLen * thighLen + d * d - shinLen * shinLen) / (2 * thighLen * d), -1, 1);
  const hipAngle = Math.acos(cosHip);

  // Current thigh direction in world space.
  const thighWorldQ = thigh.getWorldQuaternion(new THREE.Quaternion());
  const thighDir = new THREE.Vector3(0, -1, 0).applyQuaternion(thighWorldQ); // bones point down

  // Rotation axis: perpendicular to (thighDir, _dir), oriented by poleDir.
  _axis.crossVectors(thighDir, _dir);
  if (_axis.lengthSq() < 1e-8) {
    // Already aligned; use poleDir as the axis fallback.
    _axis.crossVectors(thighDir, poleDir).normalize();
  } else {
    _axis.normalize();
    // Flip if the rotation would bend the knee away from the pole.
    _kneeDir.copy(poleDir).sub(_dir).normalize();
    const testKnee = thighDir.clone().applyAxisAngle(_axis, hipAngle);
    if (testKnee.dot(_kneeDir) < 0) _axis.negate();
  }
  _q.setFromAxisAngle(_axis, hipAngle);
  thigh.quaternion.premultiply(thigh.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(_q));

  // Knee angle: interior angle at the knee joint.
  const cosKnee = THREE.MathUtils.clamp((thighLen * thighLen + shinLen * shinLen - d * d) / (2 * thighLen * shinLen), -1, 1);
  const kneeAngle = Math.PI - Math.acos(cosKnee); // bend amount (0 = straight)
  // Apply knee bend around the same axis, in shin-local space.
  _q.setFromAxisAngle(_axis, -kneeAngle);
  const shinParentQ = shin.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
  shin.quaternion.premultiply(shinParentQ.multiply(_q));
}

/**
 * Foot IK controller: plants both feet on the ground each frame.
 * `groundHeight(x, z)` returns the ground Y at a world position.
 */
export class FootIk {
  private readonly left: FootIkChain | null;
  private readonly right: FootIkChain | null;
  /** Max distance to search for ground below the foot. */
  maxReach = 1.5;
  /** Blend 0..1: 0 = animation only, 1 = full IK. */
  weight = 1;

  constructor(root: THREE.Object3D) {
    this.left = findFootChain(root, "L");
    this.right = findFootChain(root, "R");
  }

  /** True when both (or at least one) foot chain was found. */
  get available(): boolean {
    return this.left !== null || this.right !== null;
  }

  /**
   * Run IK for both feet. Call after mixer.update().
   * `groundHeight` maps world (x, z) → ground Y.
   */
  update(groundHeight: (x: number, z: number) => number): void {
    if (this.weight <= 0) return;
    for (const chain of [this.left, this.right]) {
      if (!chain) continue;
      this.plantFoot(chain, groundHeight);
    }
  }

  private plantFoot(chain: FootIkChain, groundHeight: (x: number, z: number) => number): void {
    const footPos = chain.foot.getWorldPosition(new THREE.Vector3());
    const groundY = groundHeight(footPos.x, footPos.z);
    const dy = footPos.y - groundY;
    // Only correct when the foot is near the ground (not when lifted high in a kick).
    if (Math.abs(dy) > this.maxReach) return;
    if (Math.abs(dy) < 0.01) return; // Already planted.
    _target.set(footPos.x, groundY, footPos.z);
    // Knee pole: forward from the character (use the foot's world -Z as forward).
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(chain.thigh.getWorldQuaternion(new THREE.Quaternion()));
    solveTwoBoneIk(chain, _target, forward);
  }
}
