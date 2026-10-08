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
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH } from "three-mesh-bvh";
import type { WorkerRequester } from "../workers/pool.js";

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
  if (!wantsTree(geometry)) return !!geometry.boundsTree;
  installBvh();
  geometry.computeBoundsTree();
  return true;
}

function wantsTree(geometry: THREE.BufferGeometry): boolean {
  if (geometry.boundsTree) return false;
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  return !!position && (index ? index.count : position.count) / 3 >= MIN_TRIANGLES;
}

/**
 * ensureBoundsTree with the build in a worker (it gets copies; the geometry
 * keeps its arrays). A failed worker leaves the lazy ensureBoundsTree to build it.
 */
export async function ensureBoundsTreeAsync(geometry: THREE.BufferGeometry, workers: WorkerRequester): Promise<void> {
  const index = geometry.getIndex();
  if (!index || !wantsTree(geometry)) return; // the worker builds indexed geometry only
  try {
    const bvh = await workers.request("bvh", {
      positions: (geometry.getAttribute("position").array as Float32Array).slice(),
      indices: (index.array as Uint16Array | Uint32Array).slice(),
    });
    installBvh();
    geometry.boundsTree = MeshBVH.deserialize(bvh, geometry) as unknown as typeof geometry.boundsTree; // (two copies of the package: drei nests its own)
  } catch (err) {
    console.warn("[bvh] worker build failed; building lazily:", (err as Error).message);
  }
}
