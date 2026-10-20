/**
 * Animation retargeting (EA21): retarget an AnimationClip from a source
 * skeleton to a target skeleton.
 *
 * Different rigs name bones differently (mixamorigHips vs Hips) and rest in
 * different poses. Retargeting maps bones by name, then converts each track's
 * local transforms through the rest-pose delta:
 *
 *   target_local = target_rest⁻¹ · source_rest · source_local · source_rest⁻¹ · target_rest
 *
 * …simplified per-track: for position tracks we scale by the bone-length
 * ratio; for quaternion tracks we apply the rest-pose orientation delta.
 *
 * Usage:
 *   const map = buildBoneMap(sourceRoot, targetRoot); // name → name
 *   const retargeted = retargetClip(sourceClip, sourceRoot, targetRoot, map);
 */

import * as THREE from "three";

/** Map from source bone name → target bone name. */
export type BoneMap = Map<string, string>;

/**
 * Build a bone map by matching names with common conventions stripped.
 * Handles: "mixamorigHips" → "Hips", "Thigh_L" → "thigh.l", etc.
 */
export function buildBoneMap(sourceRoot: THREE.Object3D, targetRoot: THREE.Object3D): BoneMap {
  const normalize = (n: string): string =>
    n
      .replace(/^mixamorig/i, "")
      .replace(/[_\.\-]/g, "")
      .toLowerCase();
  const targetByNorm = new Map<string, string>();
  targetRoot.traverse((o) => {
    if ((o as THREE.Bone).isBone) targetByNorm.set(normalize(o.name), o.name);
  });
  const map: BoneMap = new Map();
  sourceRoot.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    const t = targetByNorm.get(normalize(o.name));
    if (t) map.set(o.name, t);
  });
  return map;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/**
 * Retarget one AnimationClip from sourceRoot's skeleton to targetRoot's.
 * Tracks for unmapped bones are dropped. Returns a new clip; the source is
 * untouched.
 */
export function retargetClip(
  source: THREE.AnimationClip,
  sourceRoot: THREE.Object3D,
  targetRoot: THREE.Object3D,
  map: BoneMap,
): THREE.AnimationClip {
  // Rest-pose world matrices for both skeletons.
  sourceRoot.updateWorldMatrix(true, true);
  targetRoot.updateWorldMatrix(true, true);
  const sourceRest = new Map<string, THREE.Matrix4>();
  const targetRest = new Map<string, THREE.Matrix4>();
  sourceRoot.traverse((o) => {
    if ((o as THREE.Bone).isBone) sourceRest.set(o.name, o.matrixWorld.clone());
  });
  targetRoot.traverse((o) => {
    if ((o as THREE.Bone).isBone) targetRest.set(o.name, o.matrixWorld.clone());
  });

  // Bone length ratios for position scaling (hips → child distance).
  const lengthRatio = new Map<string, number>();
  for (const [sName, tName] of map) {
    const sBone = sourceRoot.getObjectByName(sName)!;
    const tBone = targetRoot.getObjectByName(tName)!;
    const sLen = childDistance(sBone);
    const tLen = childDistance(tBone);
    lengthRatio.set(sName, sLen > 1e-6 && tLen > 1e-6 ? tLen / sLen : 1);
  }

  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of source.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    const sBoneName = parsed.nodeName!;
    const tBoneName = map.get(sBoneName);
    if (!tBoneName) continue; // No target bone: drop the track.

    const sRest = sourceRest.get(sBoneName)!;
    const tRest = targetRest.get(tBoneName)!;
    // Rest delta: rotation taking source rest orientation to target rest.
    const sRestQ = new THREE.Quaternion().setFromRotationMatrix(sRest);
    const tRestQ = new THREE.Quaternion().setFromRotationMatrix(tRest);
    const restDelta = tRestQ.clone().multiply(sRestQ.invert());

    const targetName = `${tBoneName}.${parsed.propertyName}`;
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const src = track.values;
      const dst = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 4) {
        _q1.set(src[i], src[i + 1], src[i + 2], src[i + 3]);
        // target_local = restDelta · source_local
        _q2.copy(restDelta).multiply(_q1);
        dst[i] = _q2.x; dst[i + 1] = _q2.y; dst[i + 2] = _q2.z; dst[i + 3] = _q2.w;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(targetName, track.times.slice(), dst));
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const ratio = lengthRatio.get(sBoneName) ?? 1;
      const src = track.values;
      const dst = new Float32Array(src.length);
      const itemSize = track.getValueSize();
      for (let i = 0; i < src.length; i += itemSize) {
        _v1.set(src[i], src[i + 1], src[i + 2]);
        if (parsed.propertyName === "position") {
          // Scale positions by bone-length ratio; rotate by rest delta.
          _v1.multiplyScalar(ratio).applyQuaternion(restDelta);
        }
        dst[i] = _v1.x; dst[i + 1] = _v1.y;
        if (itemSize > 2) dst[i + 2] = _v1.z;
      }
      tracks.push(new (track.constructor as new (name: string, times: ArrayLike<number>, values: ArrayLike<number>) => THREE.KeyframeTrack)(targetName, track.times.slice(), dst));
    } else {
      // Scalar tracks (e.g. morph): copy with renamed target.
      tracks.push(track.clone());
      tracks[tracks.length - 1].name = targetName;
    }
  }
  const out = new THREE.AnimationClip(`${source.name}→retargeted`, source.duration, tracks);
  out.blendMode = source.blendMode;
  return out;
}

/** Distance from a bone to its first child (0 if leaf). */
function childDistance(bone: THREE.Object3D): number {
  for (const child of bone.children) {
    if ((child as THREE.Bone).isBone) {
      bone.getWorldPosition(_v1);
      child.getWorldPosition(_v2);
      return _v1.distanceTo(_v2);
    }
  }
  return 0;
}
