/** PCG mesh decoding: PCGM bytes -> raw typed arrays (the main thread builds the BufferGeometry). */
import { decodePcgMesh } from '@mmo-engine/picg';
import type { PcgResultPayload, WorkerTaskHandler } from '../types.js';

export function decodePcg(bytes: ArrayBuffer): PcgResultPayload {
  const m = decodePcgMesh(bytes);
  const n = m.positions.length / 3;

  let color: Float32Array | undefined;
  if (m.colors) {
    color = new Float32Array(n * 3); // rgba -> rgb
    for (let i = 0; i < n; i++) color.set(m.colors.subarray(i * 4, i * 4 + 3), i * 3);
  }

  const bbox = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < m.positions.length; i++) {
    const a = i % 3;
    bbox[a] = Math.min(bbox[a], m.positions[i]);
    bbox[a + 3] = Math.max(bbox[a + 3], m.positions[i]);
  }

  return {
    position: m.positions,
    index: m.indices,
    normal: m.normals ?? undefined,
    uv: m.uvs ?? undefined,
    color,
    bbox,
  };
}

export const pcgHandler: WorkerTaskHandler<'pcg'> = {
  type: 'pcg',
  async handle({ bytes }) {
    return decodePcg(bytes);
  },
};
