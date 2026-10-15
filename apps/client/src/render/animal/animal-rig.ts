/**
 * AnimalRig: a procedural skeleton for a static animal mesh.
 *
 * The art animals are plain meshes (no bones, no clips). `AnimalTemplate`
 * cuts one into head, tail, four legs and body (segment.ts), writes skin
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
import { advancePhase, attackPose, deathProgress, gaitAt, legCurve, newGait, type GaitParams } from "./gait.js";
import {
  BONE_BODY, BONE_FL, BONE_HEAD, BONE_NAMES, BONE_TAIL, segmentQuadruped,
  type SegmentHints, type Segmentation,
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
  static from(source: THREE.BufferGeometry, hints?: SegmentHints): AnimalTemplate | null {
    const position = source.getAttribute("position");
    if (!position) return null;
    const flat = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      flat[i * 3] = position.getX(i);
      flat[i * 3 + 1] = position.getY(i);
      flat[i * 3 + 2] = position.getZ(i);
    }
    const seg = segmentQuadruped(flat, hints);
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

const scratchPose = { angle: 0, lift: 0 };
const scratchAttack = { windup: 0, strike: 0 };

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
    const { pivots } = template.seg;
    for (const name of BONE_NAMES) {
      const b = new THREE.Bone();
      b.name = name;
      this.bones.push(b);
    }
    // Body is the root; the others hang off it at their pivots.
    for (let i = 0; i < this.bones.length; i++) {
      const [x, y, z] = pivots[i];
      const parent = i === BONE_BODY ? null : pivots[BONE_BODY];
      this.rest.push(parent ? [x - parent[0], y - parent[1], z - parent[2]] : [x, y, z]);
      this.bones[i].position.set(...this.rest[i]);
      if (i !== BONE_BODY) this.bones[BONE_BODY].add(this.bones[i]);
    }
    this.mesh = new THREE.SkinnedMesh(template.geometry, material);
    this.mesh.name = "animal";
    this.mesh.add(this.bones[BONE_BODY]);
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
    body.rotation.set(pitch * alive, 0, 0);

    for (let k = 0; k < 4; k++) {
      const leg = this.bones[BONE_FL + k];
      legCurve(this.phase + g.offsets[k], g.duty, scratchPose);
      // Forward foot is +Z: swing about X by a negative angle. The foot's reach is L sin(angle), so
      // sin(angle) runs linearly through stance (a constant ground speed: no sliding), and the hip
      // drops by L (1 - cos) so the foot stays on the ground instead of arcing up.
      const ang = Math.asin(Math.sin(g.sweep) * scratchPose.angle) * alive;
      leg.rotation.set(-ang, 0, (k % 2 === 0 ? 1 : -1) * d * 0.5);
      leg.position.set(
        this.rest[BONE_FL + k][0],
        this.rest[BONE_FL + k][1] - (bob + breathe - windup * 0.1 * L) * alive - L * (1 - Math.cos(ang)) + scratchPose.lift * g.lift * g.moveW * alive,
        this.rest[BONE_FL + k][2],
      );
    }

    // Head: steadied against the body's pitch, nodding with the stride; lowered in the windup, thrown out in the strike.
    const head = this.bones[BONE_HEAD];
    head.rotation.set(
      (-pitch * 0.8 + Math.sin(4 * Math.PI * this.phase) * 0.05 * g.moveW + windup * 0.35 - strike * 0.5 + Math.sin(this.clock * 0.7) * 0.03) * alive + d * 0.4,
      Math.sin(this.clock * 0.4) * 0.15 * (1 - g.moveW) * alive,
      0,
    );
    // Tail: swings side to side with the stride, lagging it; a lazy drift when idle.
    const tail = this.bones[BONE_TAIL];
    tail.rotation.set(
      0.08 * Math.sin(2 * Math.PI * this.phase) * g.moveW + windup * -0.2,
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
