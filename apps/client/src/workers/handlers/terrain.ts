import type { WorkerTaskHandler } from '../types.js';
import { buildChunkGeometry } from '../../render/terrain/terrain-mesh.js';

export const terrainHandler: WorkerTaskHandler<'terrain'> = {
  type: 'terrain',
  async handle({ heights, chunkWorldSize }) {
    const g = buildChunkGeometry(heights, chunkWorldSize);
    g.computeBoundingBox();
    const { min, max } = g.boundingBox!;
    return {
      position: g.getAttribute('position').array as Float32Array,
      normal: g.getAttribute('normal').array as Float32Array,
      index: g.index!.array as Uint16Array,
      bbox: new Float32Array([min.x, min.y, min.z, max.x, max.y, max.z]),
    };
  },
};
