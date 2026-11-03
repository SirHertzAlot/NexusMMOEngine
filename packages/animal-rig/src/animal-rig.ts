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
  avianFlightCurve, serpentineWave, aquaticWave, arachnidGait, floraSway,
} from "./gait.js";
import {
  BONE_BODY, BONE_FL, BONE_HEAD, BONE_LOWER, BONE_NAMES, BONE_TAIL, namedRigType, segmentQuadruped,
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
    const defaultParents = (i: number) =>
      i === BONE_BODY ? -1 : i >= BONE_LOWER ? i - BONE_LOWER + BONE_FL : BONE_BODY;
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

    const body = this.bones[BONE_BODY];
    const bob = g.bob * Math.cos(4 * Math.PI * this.phase) * g.moveW;
    const breathe = Math.sin(this.clock * 2.1) * 0.004 * seg.height;
    body.position.set(
      this.rest[BONE_BODY][0],
      this.rest[BONE_BODY][1] + (bob + breathe - windup * 0.1 * L) * alive,
      this.rest[BONE_BODY][2] + (strike * 0.35 * L - windup * 0.12 * L) * alive,
    );
    // Gallop bounds nose-up/down; the windup rocks the weight back onto the haunches.
    const pitch = Math.sin(2 * Math.PI * this.phase) * 0.05 * g.moveW * Math.min(1, g.gait) + windup * 0.12 - strike * 0.08;
    const trotW = g.moveW * Math.max(0, 1 - Math.max(0, g.gait - 1)); // the spine twists in walk and trot, less in a gallop
    const twist = Math.sin(2 * Math.PI * this.phase) * 0.04 * trotW;
    body.rotation.set(pitch * alive, twist * alive, Math.sin(2 * Math.PI * this.phase + 1.2) * 0.02 * trotW * alive);

    // Legs: the upper leg swings from the hip, the lower leg bends at the knee only. The knee
    // folds the foot back on a front leg (carpus) and forward on a hind leg (hock): the opposite way.
    const bodyDrop = (bob + breathe - windup * 0.1 * L) * alive;
    for (let k = 0; k < 4; k++) {
      const upper = this.bones[BONE_FL + k];
      const lower = this.bones[BONE_LOWER + k];
      legCurve(this.phase + g.offsets[k], g.duty, scratchPose);
      const side = k % 2 === 0 ? 1 : -1;
      const front = k < 2;
      // The foot's reach is L sin(angle): sin(angle) runs linearly through stance (constant ground
      // speed, no sliding), and the hip drops by L (1 - cos) so a straight stance leg keeps its foot down.
      const ang = Math.asin(Math.sin(g.sweep) * scratchPose.angle) * alive;
      const flex = ((front ? g.flexF : g.flexH) * scratchPose.flex) * alive + d * 0.5;
      const bend = front ? flex : -flex;
      upper.rotation.set(-ang, 0, side * d * 0.5);
      lower.rotation.set(bend, 0, 0);
      // Where the flexed foot would be relative to the straight leg at this angle: the knee lifts it,
      // but a leg reaching forward with a straightening lower leg would dip it below the ground, so
      // the hip rises just enough to keep a small swing clearance.
      const cosA = Math.cos(ang);
      const rise = seg.kneeHeight * (cosA - Math.cos(ang - bend));
      const clearance = Math.max(rise, 0.5 * g.lift * scratchPose.lift * g.moveW * alive);
      upper.position.set(
        this.rest[BONE_FL + k][0],
        this.rest[BONE_FL + k][1] - bodyDrop - L * (1 - cosA) + (clearance - rise),
        this.rest[BONE_FL + k][2],
      );
    }

    // Head: steadied against the body's pitch, nodding with the stride; lowered in the windup, thrown out in the strike.
    const head = this.bones[BONE_HEAD];
    head.rotation.set(
      (-pitch * 0.8 + Math.sin(4 * Math.PI * this.phase) * 0.05 * g.moveW + windup * 0.35 - strike * 0.5 + Math.sin(this.clock * 0.7) * 0.03) * alive + d * 0.4,
      (Math.sin(this.clock * 0.4) * 0.15 * (1 - g.moveW) - twist * 1.5) * alive,
      0,
    );
    // Tail: swings side to side with the stride, lagging it; a lazy drift when idle.
    const tail = this.bones[BONE_TAIL];
    tail.rotation.set(
      0.1 * Math.sin(4 * Math.PI * this.phase - 0.9) * g.moveW + windup * -0.2,
      (0.35 * Math.sin(2 * Math.PI * this.phase - 1) * g.moveW + 0.12 * Math.sin(this.clock * 1.1)) * alive,
      0,
    );

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
