/** BVH build for raycasting; the main thread restores it with MeshBVH.deserialize(result, geometry). */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { WorkerTaskHandler } from '../types.js';

export const bvhHandler: WorkerTaskHandler<'bvh'> = {
  type: 'bvh',
  async handle({ positions, indices }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    const { roots, index, indirectBuffer } = MeshBVH.serialize(new MeshBVH(g));
    g.dispose();
    return { roots, index, indirectBuffer };
  },
};
