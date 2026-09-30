/**
 * Accelerated raycasting (three-mesh-bvh): a bounding-volume hierarchy per
 * geometry, so a ray tests a few triangles instead of every one. Hover
 * picking over the scatter props (art-pack models of thousands of
 * triangles, drawn as instances) goes from scanning each instance's
 * triangles to a tree walk per instance.
 *
 * `installBvh()` patches three once: Mesh.raycast uses a geometry's tree
 * when it has one and falls back to three's own raycast otherwise, and
 * InstancedMesh raycasts through Mesh.raycast, so instances get it too.
 * Skinned meshes never get a tree (their triangles move with the pose),
 * so they keep three's exact raycast.
 */

import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

let installed = false;

export function installBvh(): void {
  if (installed) return;
  installed = true;
  // (The package types its generic BVH builder more loosely than its own augmentation.)
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as unknown as typeof THREE.BufferGeometry.prototype.computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

/** Below this many triangles a tree costs more than it saves. */
const MIN_TRIANGLES = 64;

/** Give a (static) geometry its tree, once; small ones are left alone. Returns whether it has one. */
export function ensureBoundsTree(geometry: THREE.BufferGeometry): boolean {
  if (geometry.boundsTree) return true;
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!position) return false;
  const triangles = (index ? index.count : position.count) / 3;
  if (triangles < MIN_TRIANGLES) return false;
  installBvh();
  geometry.computeBoundsTree();
  return true;
}
