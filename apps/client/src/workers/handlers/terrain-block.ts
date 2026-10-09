import { buildBlockBuffers } from '../../render/terrain/terrain-lod.js';
import type { WorkerTaskHandler } from '../types.js';

export const terrainBlockHandler: WorkerTaskHandler<'terrainBlock'> = {
  type: 'terrainBlock',
  async handle({ chunks, chunkWorldSize, originX, originZ }) {
    return buildBlockBuffers(chunks, chunkWorldSize, originX, originZ);
  },
};
