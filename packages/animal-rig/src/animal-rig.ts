/**
 * AnimalRig: a procedural skeleton for a static animal mesh.
 *
 * The art animals are plain meshes (no bones, no clips). `AnimalTemplate`
 * cuts one into head, tail, body and four two-segment legs (segment.ts), writes skin
 * weights onto a copy of its geometry and keeps them; `AnimalRig` is one
 * animal's skinned mesh, bones and gait state. The pose each frame comes
 * from gait.ts (speed -> gait phase, idle/walk/trot/gallop blend) plus
 * one-shots: an attack with a readable windup, and a death fall.
 *
 * Presentation only, like the character animator: the server moves the
 * animal, this makes the legs agree with how it moves. Update allocates
 * nothing. The shared material belongs to the model cache and is never
 * disposed here; the template owns its skinned geometry copy.
 */

import * as THREE from "three";
import {
  advancePhase, attackPose, deathProgress, gaitAt, legCurve, newGait, type GaitParams,
  spineCurve, tailChain,
  avianFlightCurve, serpentineWave, aquaticWave, arachnidGait, floraSway,
} from "./gait.js";
import {
  BONE_BODY, BONE_FL, BONE_HEAD, BONE_LOWER, BONE_NAMES, BONE_LOIN, BONE_NECK,
  BONE_TAIL, BONE_TAIL1, BONE_TAIL2, QUADRUPED_PARENTS, namedRigType, segmentQuadruped,
  segmentModel, type SegmentHints, type Segmentation,
} from "./segment.js";

/** Animals nearer than this (metres) are posed; farther ones hold the rest pose (no CPU cost). */
export const ANIMAL_LOD_RADIUS = 45;
/** How quickly the shown speed follows the server's velocity (1/s): wire jitter must not flicker the legs. */
const SPEED_FOLLOW = 7;

export interface AnimalFrameInput {
  /** Horizontal speed from the server's velocity, m/s. */
  speed: number;
  /** Seconds into the attack move on show (hit frame at `hitAt`), or -1 when not attacking. */
  attackT: number;
  hitAt: number;
  attackDuration: number;
  /** Health is zero. */
  dead: boolean;
}

/** A model's rig data: the skinned geometry copy and the bone layout. Shared by every animal of the model. */
export class AnimalTemplate {
  readonly geometry: THREE.BufferGeometry;

  private constructor(geometry: THREE.BufferGeometry, readonly seg: Segmentation) {
    this.geometry = geometry;
  }

  /** Null when the geometry does not look like a four-legged animal (it stays a static mesh). */
  static from(source: THREE.BufferGeometry, hints?: SegmentHints, modelName?: string): AnimalTemplate | null {
    const position = source.getAttribute("position");
    if (!position) return null;
    const flat = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      flat[i * 3] = position.getX(i);
      flat[i * 3 + 1] = position.getY(i);
      flat[i * 3 + 2] = position.getZ(i);
    }
    // A model named as a non-quadruped (a bird, a snake, a fish) takes its own rig; the quadruped fit is tried first only for the rest.
    const named = modelName ? namedRigType(modelName) : undefined;
    const seg = hints?.rigType || (named && named !== "quadruped")
      ? segmentModel(flat, hints, modelName)
      : (segmentQuadruped(flat, hints) ?? segmentModel(flat, hints, modelName));
    if (!seg) return null;
    const g = source.clone();
    g.rotateY(seg.frame.yaw);
    g.translate(seg.frame.dx, seg.frame.dy, seg.frame.dz);
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(seg.skinIndex, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(seg.skinWeight, 4));
    g.computeBoundingSphere();
    // Room for the lunge and the death roll.
    if (g.boundingSphere) g.boundingSphere.radius *= 1.4;
    return new AnimalTemplate(g, seg);
  }

  create(material: THREE.Material | THREE.Material[]): AnimalRig {
    return new AnimalRig(this, material);
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

const scratchPose = { angle: 0, lift: 0, flex: 0 };
const scratchAttack = { windup: 0, strike: 0 };
const scratchSpine = { chestYaw: 0, loinYaw: 0, loinPitch: 0, chestRoll: 0, neckPitch: 0, neckYaw: 0 };
const scratchTail = new Float32Array(3);
const scratchAvian = { wingRoll: 0, wingPitch: 0, headBob: 0 };
const scratchAquatic = { tailYaw: 0, finPitch: 0, dorsalRoll: 0 };
const scratchSerpentine = new Float32Array(8);
const scratchArachnid = new Float32Array(8);
const scratchFlora = { swayX: 0, swayZ: 0, flutter: 0 };

export class AnimalRig {
  /** Add this to the scene; place and yaw it like any entity (it faces +Z). */
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly skeleton: THREE.Skeleton;
  private readonly lie = new THREE.Group();
  private readonly bones: THREE.Bone[] = [];
  /** Rest position of each bone relative to its parent. */
  private readonly rest: Array<[number, number, number]> = [];
  private readonly gait: GaitParams = newGait();
  private phase = 0;
  private speed = 0;
  private fall = 0;
  private fallSide = 1;
  private posed = false;
  private first = true;
  /** Idle breathing / head sway clock. */
  private clock = 0;

  constructor(readonly template: AnimalTemplate, material: THREE.Material | THREE.Material[]) {
    const { pivots, boneNames, parentIndices } = template.seg;
    const names = boneNames ?? BONE_NAMES;
    for (const name of names) {
      const b = new THREE.Bone();
      b.name = name;
      this.bones.push(b);
    }
    const defaultParents = (i: number) => QUADRUPED_PARENTS[i] ?? -1;
    for (let i = 0; i < this.bones.length; i++) {
      const [x, y, z] = pivots[i];
      const parentIndex = parentIndices ? parentIndices[i] : defaultParents(i);
      const parent = parentIndex >= 0 ? pivots[parentIndex] : null;
      this.rest.push(parent ? [x - parent[0], y - parent[1], z - parent[2]] : [x, y, z]);
      this.bones[i].position.set(...this.rest[i]);
      if (parentIndex >= 0) this.bones[parentIndex].add(this.bones[i]);
    }
    this.mesh = new THREE.SkinnedMesh(template.geometry, material);
    this.mesh.name = "animal";
    this.mesh.add(this.bones[0]);
    this.mesh.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.lie.add(this.mesh);
    this.root.add(this.lie);
  }

  /** Pose one frame (dt seconds). `near` false: hold the rest pose and spend nothing. */
  update(dt: number, input: AnimalFrameInput, near = true): void {
    if (!near) {
      if (this.posed) this.restPose();
      return;
    }
    this.posed = true;
    const seg = this.template.seg;
    const L = seg.legLength;
    this.clock += dt;
    if (this.first) {
      this.first = false;
      this.speed = input.speed;
      if (input.dead) this.fall = 1;
    }
    this.speed += (input.speed - this.speed) * (1 - Math.exp(-SPEED_FOLLOW * dt));
    const g = gaitAt(this.speed, L, this.gait);
    this.phase = advancePhase(this.phase, g.freq * g.moveW, dt);

    // Death: roll onto the side and go limp. No way back (the server respawns with a new entity).
    if (input.dead) this.fall = Math.min(1, this.fall + dt / 0.9);
    const d = deathProgress(this.fall, 1);
    const alive = 1 - d;

    if (input.attackT >= 0) attackPose(input.attackT, input.hitAt, input.attackDuration, scratchAttack);
    else {
      scratchAttack.windup = 0;
      scratchAttack.strike = 0;
    }
    const { windup, strike } = scratchAttack;
    const rigType = seg.type ?? "quadruped";

    if (rigType === "avian") {
      avianFlightCurve(this.phase, this.speed, scratchAvian);
      const body = this.bones[0];
      body.position.set(this.rest[0][0], this.rest[0][1] + Math.sin(this.clock * 2) * 0.005 * seg.height, this.rest[0][2]);
      body.rotation.set(0, 0, 0);
      if (this.bones[1]) this.bones[1].rotation.set(scratchAvian.headBob * alive + d * 0.3, 0, 0); // head
      if (this.bones[2]) this.bones[2].rotation.set(0, 0, 0); // tail
      if (this.bones[3]) this.bones[3].rotation.set(scratchAvian.wingPitch * alive, 0, scratchAvian.wingRoll * alive); // wingL
      if (this.bones[4]) this.bones[4].rotation.set(scratchAvian.wingPitch * alive, 0, -scratchAvian.wingRoll * alive); // wingR
      if (this.bones[5]) this.bones[5].rotation.set(Math.sin(2 * Math.PI * this.phase) * 0.3 * alive, 0, 0); // legL
      if (this.bones[6]) this.bones[6].rotation.set(-Math.sin(2 * Math.PI * this.phase) * 0.3 * alive, 0, 0); // legR
      this.lie.rotation.z = this.fallSide * d * (Math.PI / 2);
      this.lie.position.y = d * seg.width * 0.5;
      return;
    }

    if (rigType === "serpentine") {
      serpentineWave(this.phase, this.speed, this.bones.length, scratchSerpentine);
      for (let i = 0; i < this.bones.length; i++) {
        this.bones[i].rotation.set(0, scratchSerpentine[i] * alive, 0);
      }
      this.lie.rotation.z = this.fallSide * d * (Math.PI / 2);
      this.lie.position.y = d * seg.width * 0.5;
      return;
    }

    if (rigType === "aquatic") {
      aquaticWave(this.phase, this.speed, scratchAquatic);
      const body = this.bones[0];
      body.rotation.set(0, 0, scratchAquatic.dorsalRoll * alive);
      if (this.bones[2]) this.bones[2].rotation.set(0, scratchAquatic.tailYaw * alive, 0); // caudal fin
      if (this.bones[3]) this.bones[3].rotation.set(scratchAquatic.finPitch * alive, 0, 0); // finL
      if (this.bones[4]) this.bones[4].rotation.set(-scratchAquatic.finPitch * alive, 0, 0); // finR
      if (this.bones[5]) this.bones[5].rotation.set(0, 0, scratchAquatic.dorsalRoll * alive); // dorsal
      this.lie.rotation.z = this.fallSide * d * (Math.PI / 2);
      this.lie.position.y = d * seg.width * 0.5;
      return;
    }

    if (rigType === "arachnid") {
      arachnidGait(this.phase, this.speed, scratchArachnid);
      const numLegs = Math.min(8, this.bones.length - 2);
      for (let k = 0; k < numLegs; k++) {
        this.bones[2 + k].rotation.set(0, scratchArachnid[k] * alive, 0);
      }
      this.lie.rotation.z = this.fallSide * d * (Math.PI / 2);
      this.lie.position.y = d * seg.width * 0.5;
      return;
    }

    if (rigType === "flora") {
      floraSway(this.clock, scratchFlora);
      if (this.bones[1]) this.bones[1].rotation.set(scratchFlora.swayX, 0, scratchFlora.swayZ); // trunk
      if (this.bones[2]) this.bones[2].rotation.set(scratchFlora.flutter, 0, scratchFlora.flutter); // branchL
      if (this.bones[3]) this.bones[3].rotation.set(scratchFlora.flutter, 0, -scratchFlora.flutter); // branchR
      if (this.bones[4]) this.bones[4].rotation.set(scratchFlora.swayX * 1.5, 0, scratchFlora.swayZ * 1.5); // canopy
      return;
    }

    // Spine: the chest leads and the loin follows with a larger, lagged lateral wave; at a gallop
    // the loin arches dorsoventrally (spineCurve). The loin carries the hind legs and the tail,
    // so its flexion moves the haunches with it. Everything fades out with `alive`.
    spineCurve(this.phase, g.moveW, g.gait, scratchSpine);
    const sp = scratchSpine;

    const body = this.bones[BONE_BODY];
    const loin = this.bones[BONE_LOIN];
    const neck = this.bones[BONE_NECK];
    const bob = g.bob * Math.cos(4 * Math.PI * this.phase) * g.moveW;
    const breathe = Math.sin(this.clock * 2.1) * 0.004 * seg.height;
    const bodyLift = (bob + breathe - windup * 0.1 * L) * alive;
    body.position.set(
      this.rest[BONE_BODY][0],
      this.rest[BONE_BODY][1] + bodyLift,
      this.rest[BONE_BODY][2] + (strike * 0.35 * L - windup * 0.12 * L) * alive,
    );
    const pitch = Math.sin(2 * Math.PI * this.phase) * 0.05 * g.moveW * Math.min(1, g.gait) + windup * 0.12 - strike * 0.08;
    const pc = pitch * alive, qc = sp.chestYaw * alive, sc = sp.chestRoll * alive;
    body.rotation.set(pc, qc, sc);
    const pl = (sp.loinPitch + windup * 0.1) * alive, ql = sp.loinYaw * alive, sl = -0.6 * sp.chestRoll * alive;
    loin.rotation.set(pl, ql, sl);
    // Neck: holds the head level against the chest's pitch and the loin's arch;
    // lowered in the windup, thrown out in the strike.
    neck.rotation.set((sp.neckPitch + windup * 0.2 - strike * 0.25) * alive + d * 0.25, sp.neckYaw * alive, 0);

    // Legs: the femur/humerus swings from the hip/shoulder, the knee (carpus) and hock flex only in
    // swing, and the upper segment counter-rotates against the lower's flexion (the femur sits back
    // as the hock folds forward, the humerus reaches as the carpus folds back): the way a real
    // animal folds a leg. The spine's rotation would drag the hips (and any planted foot) with it,
    // so a first-order inverse rotation is folded into the hip position: the stance foot stays put.
    const loinRest = this.rest[BONE_LOIN];
    for (let k = 0; k < 4; k++) {
      const upper = this.bones[BONE_FL + k];
      const lower = this.bones[BONE_LOWER + k];
      legCurve(this.phase + g.offsets[k], g.duty, scratchPose);
      const side = k % 2 === 0 ? 1 : -1;
      const front = k < 2;
      // The foot's reach is L sin(angle): sin(angle) runs linearly through stance (constant ground
      // speed, no sliding), and the hip drops by L (1 - cos) so a straight stance leg keeps its foot down.
      const ang = Math.asin(Math.sin(g.sweep) * scratchPose.angle) * alive;
      const flexPeak = (front ? g.flexF : g.flexH) * scratchPose.flex * alive;
      const flex = flexPeak + d * 0.5;
      const bend = front ? flex : -flex;
      const contra = front ? -0.25 * flexPeak : 0.35 * flexPeak;
      upper.rotation.set(-ang + contra, 0, side * d * 0.5);
      lower.rotation.set(bend, 0, 0);
      // Where the flexed foot would be relative to the straight leg at this angle: the knee lifts it,
      // but a leg reaching forward with a straightening lower leg would dip it below the ground, so
      // the hip rises just enough to keep a small swing clearance.
      const cosA = Math.cos(ang);
      const rise = seg.kneeHeight * (cosA - Math.cos(ang - bend));
      const clearance = Math.max(rise, 0.5 * g.lift * scratchPose.lift * g.moveW * alive);
      const restU = this.rest[BONE_FL + k];
      const ikY = -bodyLift - L * (1 - cosA) + (clearance - rise);
      // The wanted hip, in the chest's unrotated space (through the loin for a hind leg)...
      const vx = front ? restU[0] : loinRest[0] + restU[0];
      const vy = (front ? restU[1] : loinRest[1] + restU[1]) + ikY;
      const vz = front ? restU[2] : loinRest[2] + restU[2];
      // ...minus what the chest's rotation would do to it (delta = angle x offset, small angles)...
      const dcx = qc * vz - sc * vy, dcy = sc * vx - pc * vz, dcz = pc * vy - qc * vx;
      let ax = restU[0] - dcx, ay = restU[1] + ikY - dcy, az = restU[2] - dcz;
      if (!front) {
        // ...and the loin's: a hind hip hangs one rotation deeper.
        const dlx = ql * az - sl * ay, dly = sl * ax - pl * az, dlz = pl * ay - ql * ax;
        ax -= dlx; ay -= dly; az -= dlz;
      }
      upper.position.set(ax, ay, az);
    }

    // Head: steadied against what is left of the chest's pitch, nodding with the stride;
    // lowered in the windup, thrown out in the strike; watching around when idle.
    const head = this.bones[BONE_HEAD];
    head.rotation.set(
      (-pitch * 0.5 + Math.sin(4 * Math.PI * this.phase) * 0.05 * g.moveW + windup * 0.35 - strike * 0.5 + Math.sin(this.clock * 0.7) * 0.03) * alive + d * 0.4,
      (Math.sin(this.clock * 0.4) * 0.15 * (1 - g.moveW)) * alive,
      0,
    );
    // Tail: a lagged chain, the root following the stride and the tip flicking on; limp when dead.
    tailChain(this.phase, this.clock, g.moveW, 3, scratchTail);
    this.bones[BONE_TAIL].rotation.set(
      (0.08 * Math.sin(4 * Math.PI * this.phase - 0.9) * g.moveW - windup * 0.2) * alive + d * 0.35,
      scratchTail[0] * alive,
      0,
    );
    this.bones[BONE_TAIL1].rotation.set(d * 0.25, scratchTail[1] * alive, 0);
    this.bones[BONE_TAIL2].rotation.set(d * 0.2, scratchTail[2] * alive, 0);

    // Lying: roll about the feet line and lower the body so it rests on the ground.
    this.lie.rotation.z = this.fallSide * d * (Math.PI / 2);
    this.lie.position.x = 0;
    this.lie.position.y = d * seg.width * 0.5;
  }

  /** Back to the bind pose (all bones at rest). */
  restPose(): void {
    this.posed = false;
    for (let i = 0; i < this.bones.length; i++) {
      this.bones[i].position.set(...this.rest[i]);
      this.bones[i].rotation.set(0, 0, 0);
    }
    this.lie.rotation.set(0, 0, 0);
    this.lie.position.set(0, 0, 0);
  }

  /** Release what this animal owns: its skeleton. The template's geometry and the shared material stay. */
  dispose(): void {
    this.skeleton.dispose();
    this.root.removeFromParent();
  }
}
