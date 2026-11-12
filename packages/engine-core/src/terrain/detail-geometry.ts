/**
 * Detail placements become merged, instanced-friendly geometry per chunk or
 * room: each placement is a cross of two alpha-tested quads (texture-mesh
 * detail: moss, lichen, ground plants). No full models, no runtime cost: the
 * runtime only draws the baked buffers.
 */
import type { Placement } from "./detail-layer.js";

export interface DetailGeometry {
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** u, v per vertex (0..1). */
  uvs: Float32Array;
  /** Two triangles per quad, indices into the vertex list. */
  indices: Uint32Array;
  /** Quads baked (cross = 2 quads per placement). */
  quads: number;
}

export interface DetailGeometryOptions {
  /** Quad width and height, metres. */
  size: number;
  /** Ground height at a point (default 0). */
  height?: (x: number, z: number) => number;
}

/** Build a cross of two perpendicular quads for every placement. */
export function buildDetailGeometry(placements: readonly Placement[], opts: DetailGeometryOptions): DetailGeometry {
  const h = opts.height ?? (() => 0);
  const half = opts.size / 2;
  const quads = placements.length * 2;
  const positions = new Float32Array(quads * 4 * 3);
  const uvs = new Float32Array(quads * 4 * 2);
  const indices = new Uint32Array(quads * 6);
  let v = 0;
  let t = 0;
  for (const p of placements) {
    const y = h(p.x, p.z);
    // Quad 0 runs along x; quad 1 along z: a cross that reads from any side.
    for (const axis of [0, 1]) {
      const base = v;
      const ax = axis === 0 ? 1 : 0;
      const az = axis === 0 ? 0 : 1;
      // Corners bottom-left, bottom-right, top-right, top-left; u across, v up.
      const corners: Array<[number, number, number, number, number]> = [
        [-half * ax, 0, -half * az, 0, 0],
        [half * ax, 0, half * az, 1, 0],
        [half * ax, opts.size, half * az, 1, 1],
        [-half * ax, opts.size, -half * az, 0, 1],
      ];
      for (const [dx, dy, dz, u, vv] of corners) {
        positions[v * 3] = p.x + dx;
        positions[v * 3 + 1] = y + dy;
        positions[v * 3 + 2] = p.z + dz;
        uvs[v * 2] = u;
        uvs[v * 2 + 1] = vv;
        v++;
      }
      indices[t++] = base; indices[t++] = base + 1; indices[t++] = base + 2;
      indices[t++] = base; indices[t++] = base + 2; indices[t++] = base + 3;
    }
  }
  return { positions, uvs, indices, quads };
}
