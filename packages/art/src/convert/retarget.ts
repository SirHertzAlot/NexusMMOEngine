/**
 * Retargeting: an animation made for one humanoid skeleton, played by
 * another. Both skeletons stand upright facing +Z: a source that doesn't
 * (a Z-up FBX) is turned first, found from its own hips, head and
 * shoulders (or `rotate`). Each frame, a mapped bone turns in the world
 * exactly as its source bone turns away from the source's rest pose:
 *
 *   targetWorld(t) = sourceWorld(t) · sourceWorldRest⁻¹ · align · targetWorldRest
 *
 * where `align` turns our rest bone to point where the source's rest bone
 * points (towards its next joint), so rest poses needn't match — an A-pose
 * source drives a T-pose rig. The local rotation follows from the target
 * parent's world rotation.
 * Unmapped target bones keep their rest pose. The hips move as the
 * source's do, scaled by hip height; horizontal root motion (the source's
 * root bone) is taken out — the clip plays in place — and reported, so
 * the game can move the character that far itself.
 *
 * Works on three.js scenes in memory (Node or browser).
 */

import * as THREE from "three";

export interface RetargetSourceRig {
  scene: THREE.Object3D;
  /** The source's hips (pelvis) node name. */
  hips: string;
  /**
   * The node carrying root motion (its horizontal travel is taken out);
   * without one, the hips' own horizontal travel is (raw mocap moves the
   * hips about the room).
   */
  root?: string;
  /** Target bone name → source node name. */
  map: Readonly<Record<string, string>>;
  /**
   * A clip whose first frame places the nodes above the hips (some FBX
   * files animate their armature node in a different frame from their rest
   * pose: the rest pose then takes those nodes from the clip, so both agree).
   */
  rootFrom?: THREE.AnimationClip;
  /**
   * Euler angles (radians, XYZ) that stand the source up facing +Z.
   * Default: found from the rest pose (hips → head is up, right → left
   * shoulder is the character's left, +X).
   */
  rotate?: readonly [number, number, number];
}

export interface RetargetTargetRig {
  scene: THREE.Object3D;
  /** The target's hips node name (its position is animated). */
  hips: string;
}

export interface RetargetedClip {
  clip: THREE.AnimationClip;
  /** Horizontal root travel over the clip, target metres (x, z; +z = forward). */
  travel: [number, number];
}

interface TargetBone {
  node: THREE.Object3D;
  parent: number; // index into the bone list, -1 = the scene root
  restLocal: THREE.Quaternion;
  restWorld: THREE.Quaternion;
  source: THREE.Object3D | null;
  sourceRestWorldInv: THREE.Quaternion | null;
  /** align · targetWorldRest (see the header). */
  aligned: THREE.Quaternion;
}

/** The child a bone points along, by preference (the spine goes up the neck, not a clavicle). */
const POINTS_AT = [/^Spine_/, /^Neck$/, /^Head$/, /^Finger_01/];

/** three.js's node-name sanitising (GLTFLoader names nodes this way). */
export const sanitizeName = (name: string): string => THREE.PropertyBinding.sanitizeNodeName(name);

export class Retargeter {
  private readonly bones: TargetBone[] = [];
  private readonly sceneWorld = new THREE.Quaternion();
  private readonly srcHips: THREE.Object3D;
  private readonly srcRoot: THREE.Object3D | null;
  private readonly srcHipsRest = new THREE.Vector3();
  private readonly srcRootRest = new THREE.Vector3();
  private readonly tgtHips: TargetBone;
  private readonly tgtHipsRest = new THREE.Vector3();
  private readonly tgtHipsParentInv = new THREE.Matrix4();
  /**
   * Holds the source scene and carries its turn upright: a clip may animate
   * the scene's own root node (an FBX armature), which would undo a turn
   * put there.
   */
  private readonly holder = new THREE.Group();
  /** Target hip height over source hip height. */
  readonly scale: number;
  /** Mapped target bones whose source node is missing. */
  readonly missing: string[] = [];

  constructor(
    private readonly source: RetargetSourceRig,
    target: RetargetTargetRig,
  ) {
    const find = (scene: THREE.Object3D, name: string): THREE.Object3D | undefined =>
      scene.getObjectByName(name) ?? scene.getObjectByName(sanitizeName(name));
    source.scene.removeFromParent();
    this.holder.add(source.scene);
    const hipsNode = find(source.scene, source.hips);
    if (source.rootFrom && hipsNode) {
      const above = new Map<string, THREE.Object3D>();
      for (let n = hipsNode.parent; n && n !== this.holder; n = n.parent) above.set(n.name, n);
      for (const t of source.rootFrom.tracks) {
        const dot = t.name.lastIndexOf(".");
        const node = above.get(t.name.slice(0, dot));
        const prop = t.name.slice(dot + 1);
        if (!node) continue;
        if (prop === "quaternion") node.quaternion.fromArray(t.values, 0);
        else if (prop === "position") node.position.fromArray(t.values, 0);
        else if (prop === "scale") node.scale.fromArray(t.values, 0);
      }
    }
    if (source.rotate) this.holder.rotation.set(...source.rotate);
    else this.standUp(source, find);
    this.holder.updateMatrixWorld(true);
    target.scene.updateMatrixWorld(true);
    target.scene.getWorldQuaternion(this.sceneWorld);

    const visit = (node: THREE.Object3D, parent: number): void => {
      const srcName = source.map[node.name];
      const src = srcName ? find(source.scene, srcName) ?? null : null;
      if (srcName && !src) this.missing.push(node.name);
      const bone: TargetBone = {
        node,
        parent,
        restLocal: node.quaternion.clone(),
        restWorld: node.getWorldQuaternion(new THREE.Quaternion()),
        source: src,
        sourceRestWorldInv: src ? src.getWorldQuaternion(new THREE.Quaternion()).invert() : null,
        aligned: new THREE.Quaternion(),
      };
      const at = this.bones.length;
      this.bones.push(bone);
      for (const c of node.children) visit(c, at);
    };
    for (const c of target.scene.children) visit(c, -1);

    // align: our rest bone turned to point as the source's rest bone does.
    const at = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
    for (const b of this.bones) {
      b.aligned.copy(b.restWorld);
      if (!b.source) continue;
      const kids = this.bones.filter((c) => c.node.parent === b.node && c.source);
      const child = POINTS_AT.map((re) => kids.find((c) => re.test(c.node.name))).find((c) => c) ?? kids[0];
      if (!child) continue;
      const ours = at(child.node).sub(at(b.node));
      const theirs = at(child.source!).sub(at(b.source));
      if (ours.lengthSq() < 1e-12 || theirs.lengthSq() < 1e-12) continue;
      const align = new THREE.Quaternion().setFromUnitVectors(ours.normalize(), theirs.normalize());
      b.aligned.premultiply(align);
    }

    const hips = this.bones.find((b) => b.node.name === target.hips);
    if (!hips) throw new Error(`retarget: target has no ${target.hips}`);
    this.tgtHips = hips;
    hips.node.getWorldPosition(this.tgtHipsRest);
    this.tgtHipsParentInv.copy((hips.node.parent ?? target.scene).matrixWorld).invert();

    const srcHips = find(source.scene, source.hips);
    if (!srcHips) throw new Error(`retarget: source has no ${source.hips}`);
    this.srcHips = srcHips;
    srcHips.getWorldPosition(this.srcHipsRest);
    this.srcRoot = source.root ? find(source.scene, source.root) ?? null : null;
    this.srcRoot?.getWorldPosition(this.srcRootRest);
    this.scale = this.tgtHipsRest.y / this.srcHipsRest.y;
  }

  /** Turn the source scene so its skeleton stands up (+Y) facing +Z, its left side at +X. */
  private standUp(source: RetargetSourceRig, find: (s: THREE.Object3D, n: string) => THREE.Object3D | undefined): void {
    const bone = (ours: string): THREE.Object3D | undefined => (source.map[ours] ? find(source.scene, source.map[ours]) : undefined);
    const hips = find(source.scene, source.hips);
    const head = bone("Head") ?? bone("Neck");
    const left = bone("Shoulder_L");
    const right = bone("Shoulder_R");
    if (!hips || !head || !left || !right) return;
    this.holder.updateMatrixWorld(true);
    const at = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
    const up = at(head).sub(at(hips)).normalize();
    const side = at(left).sub(at(right));
    side.sub(up.clone().multiplyScalar(side.dot(up))).normalize();
    const forward = new THREE.Vector3().crossVectors(side, up);
    // The source's (left, up, forward) frame onto (+X, +Y, +Z).
    const frame = new THREE.Matrix4().makeBasis(side, up, forward);
    const turn = new THREE.Quaternion().setFromRotationMatrix(frame).invert();
    this.holder.quaternion.premultiply(turn);
  }

  /** Retarget `clip` (made for the source scene), sampled at `fps`. */
  retarget(clip: THREE.AnimationClip, fps = 30): RetargetedClip {
    const mixer = new THREE.AnimationMixer(this.source.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();

    const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = new Float32Array(frames);
    const mapped = this.bones.filter((b) => b.source !== null);
    const quats = new Map<TargetBone, Float32Array>(mapped.map((b) => [b, new Float32Array(frames * 4)]));
    const hipsPos = new Float32Array(frames * 3);
    const world = this.bones.map(() => new THREE.Quaternion());
    const q = new THREE.Quaternion();
    const d = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const rootAt = new THREE.Vector3();
    const travel: THREE.Vector2[] = [];

    for (let f = 0; f < frames; f++) {
      const t = Math.min(f / fps, clip.duration);
      times[f] = t;
      mixer.setTime(t);
      this.holder.updateMatrixWorld(true);
      if (this.srcRoot) this.srcRoot.getWorldPosition(rootAt).sub(this.srcRootRest);
      else this.srcHips.getWorldPosition(rootAt).sub(this.srcHipsRest);
      rootAt.y = 0;
      travel.push(new THREE.Vector2(rootAt.x, rootAt.z).multiplyScalar(this.scale));

      for (let i = 0; i < this.bones.length; i++) {
        const b = this.bones[i];
        const parentWorld = b.parent < 0 ? this.sceneWorld : world[b.parent];
        if (b.source) {
          // The source bone's turn away from its rest, applied to ours.
          b.source.getWorldQuaternion(d).multiply(b.sourceRestWorldInv!);
          world[i].copy(d).multiply(b.aligned);
          q.copy(parentWorld).invert().multiply(world[i]);
          const out = quats.get(b)!;
          // Keep neighbouring keys in one hemisphere (no flips between them).
          if (f > 0) {
            const k = (f - 1) * 4;
            if (out[k] * q.x + out[k + 1] * q.y + out[k + 2] * q.z + out[k + 3] * q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
          }
          q.toArray(out, f * 4);
        } else {
          world[i].copy(parentWorld).multiply(b.restLocal);
        }
      }

      // Hips: the source's hip movement with its root travel taken out, scaled.
      this.srcHips.getWorldPosition(p);
      p.x -= rootAt.x;
      p.z -= rootAt.z;
      p.sub(this.srcHipsRest).multiplyScalar(this.scale).add(this.tgtHipsRest).applyMatrix4(this.tgtHipsParentInv);
      p.toArray(hipsPos, f * 3);
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(this.source.scene);

    const tracks: THREE.KeyframeTrack[] = [
      new THREE.VectorKeyframeTrack(`${this.tgtHips.node.name}.position`, Array.from(times), Array.from(hipsPos)),
    ];
    for (const b of mapped) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${b.node.name}.quaternion`, Array.from(times), Array.from(quats.get(b)!)));
    }
    const first = travel[0];
    const last = travel[travel.length - 1];
    return {
      clip: new THREE.AnimationClip(clip.name, clip.duration, tracks),
      travel: [last.x - first.x, last.y - first.y],
    };
  }
}
