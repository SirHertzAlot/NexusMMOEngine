/**
 * Levels of detail for props: lighter versions of a model drawn when it is
 * far enough away that the difference is under a few pixels.
 *
 * - PICG meshes arrive with their chain from the server (meshoptimizer in
 *   the native cook, engine-core pcg/asset-library.ts).
 * - Art-pack models get theirs here, when they load: meshoptimizer's
 *   simplifier (the same C++ library, built to WebAssembly), each material
 *   group simplified on its own with its borders locked so groups don't
 *   crack apart. A level shares the model's vertex buffers; only its index
 *   buffer is new.
 *
 * A level is used from `distance` on: where its deviation from the full
 * model (in metres) projects to at most MAX_PIXEL_ERROR pixels, and never
 * nearer than MIN_STEP metres per level.
 */

import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";

export interface LodLevel {
  geometry: THREE.BufferGeometry;
  /** Used from this camera distance on, metres. */
  distance: number;
  /** Deviation from the full model, metres. */
  error: number;
}

/** Triangles kept per level, as fractions of the full model. */
export const LOD_RATIOS = [0.5, 0.25, 0.1];
/** Largest simplification allowed, relative to the model's size. */
export const LOD_MAX_ERROR = 0.05;
/** How far a level's deviation may show on screen, pixels. */
export const MAX_PIXEL_ERROR = 4;
/** A level is never used nearer than this many metres per level. */
export const MIN_STEP = 18;
/** Pixels per radian at 1080p with a 50 degree vertical field of view. */
const PX_PER_RADIAN = 1080 / (2 * Math.tan(THREE.MathUtils.degToRad(25)));

/** The distance a level with this deviation (metres) is used from. */
export function lodDistance(errorMetres: number, level: number): number {
  return Math.max(MIN_STEP * level, (errorMetres * PX_PER_RADIAN) / MAX_PIXEL_ERROR);
}

/** The model's size the simplifier measures error against: its largest extent. */
export function modelScale(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z, 1e-6);
}

/**
 * Simplified levels of an indexed geometry (most detailed first), sharing
 * its attributes. Empty for a geometry without an index, or where
 * simplification can't take triangles away.
 */
export async function simplifyLods(geometry: THREE.BufferGeometry, ratios = LOD_RATIOS, maxError = LOD_MAX_ERROR): Promise<LodLevel[]> {
  const index = geometry.index;
  const position = geometry.getAttribute("position");
  if (!index || !position || !MeshoptSimplifier.supported) return [];
  await MeshoptSimplifier.ready;
  const positions = toFloat32(position);
  const indices = Uint32Array.from(index.array as ArrayLike<number>);
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: indices.length, materialIndex: 0 }];
  const scale = modelScale(geometry);
  const levels: LodLevel[] = [];
  let previous = indices.length;
  for (const [i, ratio] of ratios.entries()) {
    const parts: Uint32Array[] = [];
    const lodGroups: Array<{ start: number; count: number; materialIndex: number }> = [];
    let error = 0;
    let at = 0;
    for (const g of groups) {
      const src = indices.subarray(g.start, g.start + g.count);
      const target = Math.max(3, Math.floor((g.count / 3) * ratio) * 3);
      const [out, e] = MeshoptSimplifier.simplify(src, positions, 3, target, maxError, ["LockBorder"]);
      parts.push(out);
      lodGroups.push({ start: at, count: out.length, materialIndex: g.materialIndex ?? 0 });
      at += out.length;
      error = Math.max(error, e);
    }
    // Simplification can't go further (the error cap, locked borders): stop the chain.
    if (at >= previous * 0.9) break;
    previous = at;
    const lodIndex = new Uint32Array(at);
    let o = 0;
    for (const p of parts) {
      lodIndex.set(p, o);
      o += p.length;
    }
    const lod = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geometry.attributes)) lod.setAttribute(name, attr);
    lod.setIndex(new THREE.BufferAttribute(lodIndex, 1));
    for (const g of lodGroups) lod.addGroup(g.start, g.count, g.materialIndex);
    lod.boundingSphere = geometry.boundingSphere?.clone() ?? null;
    lod.boundingBox = geometry.boundingBox?.clone() ?? null;
    const metres = error * scale;
    levels.push({ geometry: lod, distance: lodDistance(metres, i + 1), error: metres });
  }
  return levels;
}

/** Positions as a tightly packed Float32Array (interleaved or not). */
function toFloat32(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  if (attr instanceof THREE.BufferAttribute && attr.array instanceof Float32Array && attr.itemSize === 3) return attr.array;
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i);
    out[i * 3 + 1] = attr.getY(i);
    out[i * 3 + 2] = attr.getZ(i);
  }
  return out;
}
