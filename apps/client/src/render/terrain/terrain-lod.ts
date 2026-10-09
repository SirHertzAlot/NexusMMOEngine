/**
 * Terrain LOD rings and batching (OPEN-WORLD-PLAN Phase 3).
 *
 * Each chunk tile is 16 × 16 samples, 15 cells a side (~1.07 m apart on
 * 16 m chunks). A chunk further from the camera keeps only every
 * `stride`-th sample: 1 (full), 3, 5 or 15 (its corners only) — the
 * strides that divide 15, so every level keeps the tile's border samples
 * and its corners line up with the neighbours'. The rings are counted in
 * chunks (Chebyshev distance from the camera's chunk).
 *
 * Cracks: where a coarse chunk meets a finer one, the finer edge has
 * samples the coarse edge interpolates past. Every chunk keeps its skirt
 * (terrain-mesh.ts), which hangs below every edge and fills that gap, so
 * there is no crack to see through.
 *
 * Draw calls: chunks are merged into blocks of BLOCK × BLOCK chunks, one
 * mesh per block (a 17 × 17 ring is ~25 meshes instead of 289). A block is
 * rebuilt when a chunk in it arrives, leaves, changes level, or has its
 * border normals refined.
 */

import * as THREE from "three";
import { SIDE, SKIRT_DEPTH } from "./terrain-mesh.js";

const CELLS = SIDE - 1;

/** Chunks per block side. */
export const BLOCK = 4;

/** Ring → sample stride. A chunk at Chebyshev ring r takes the first row with r <= maxRing. */
export const LOD_RINGS: ReadonlyArray<{ maxRing: number; stride: number }> = [
  { maxRing: 3, stride: 1 },
  { maxRing: 5, stride: 3 },
  { maxRing: 8, stride: 5 },
  { maxRing: Infinity, stride: 15 },
];

export function strideForRing(ring: number): number {
  for (const r of LOD_RINGS) if (ring <= r.maxRing) return r.stride;
  return CELLS;
}

export function ringOf(cx: number, cz: number, camCx: number, camCz: number): number {
  return Math.max(Math.abs(cx - camCx), Math.abs(cz - camCz));
}

export const blockOf = (c: number): number => Math.floor(c / BLOCK);

/** What a block needs from each of its chunks. */
export interface LodChunk {
  cx: number;
  cz: number;
  heights: Float32Array;
  /** SIDE * SIDE unit normals (xyz). */
  normals: Float32Array;
  stride: number;
}

/** Vertices and triangles one chunk takes at `stride` (surface + skirts). */
export function chunkCost(stride: number): { vertices: number; triangles: number } {
  const n = CELLS / stride; // cells a side
  return { vertices: (n + 1) * (n + 1) + 4 * (n + 1), triangles: n * n * 2 + 4 * n * 4 };
}

/**
 * One block's geometry: every chunk at its own stride, in block-local
 * coordinates (the mesh sits at the block's origin). Same triangle split
 * as the full-res mesh ((i+1, j)-(i, j+1)), so stride 1 is the exact
 * ground the server stands characters on.
 */
export function buildBlockBuffers(
  chunks: readonly LodChunk[],
  chunkWorldSize: number,
  originX: number,
  originZ: number,
): { position: Float32Array; normal: Float32Array; index: Uint16Array | Uint32Array } {
  let vCount = 0;
  let iCount = 0;
  for (const c of chunks) {
    const { vertices, triangles } = chunkCost(c.stride);
    vCount += vertices;
    iCount += triangles * 3;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const idx = vCount > 0xffff ? new Uint32Array(iCount) : new Uint16Array(iCount);
  const spacing = chunkWorldSize / CELLS;
  let v = 0;
  let t = 0;
  for (const c of chunks) {
    const s = c.stride;
    const n = CELLS / s;
    const row = n + 1;
    const base = v;
    const ox = c.cx * chunkWorldSize - originX;
    const oz = c.cz * chunkWorldSize - originZ;
    for (let jj = 0; jj <= n; jj++) {
      for (let ii = 0; ii <= n; ii++) {
        const i = ii * s;
        const j = jj * s;
        const src = j * SIDE + i;
        pos[3 * v] = ox + i * spacing;
        pos[3 * v + 1] = c.heights[src];
        pos[3 * v + 2] = oz + j * spacing;
        nrm[3 * v] = c.normals[3 * src];
        nrm[3 * v + 1] = c.normals[3 * src + 1];
        nrm[3 * v + 2] = c.normals[3 * src + 2];
        v++;
      }
    }
    for (let jj = 0; jj < n; jj++) {
      for (let ii = 0; ii < n; ii++) {
        const a = base + jj * row + ii;
        const b = a + 1;
        const cc = a + row;
        const d = cc + 1;
        idx[t++] = a; idx[t++] = cc; idx[t++] = b;
        idx[t++] = d; idx[t++] = b; idx[t++] = cc;
      }
    }
    // Skirts: north, east, south, west, each a strip SKIRT_DEPTH below the edge, both faces.
    const edges = [
      Array.from({ length: row }, (_, k) => base + k),
      Array.from({ length: row }, (_, k) => base + k * row + n),
      Array.from({ length: row }, (_, k) => base + n * row + k),
      Array.from({ length: row }, (_, k) => base + k * row),
    ];
    for (const edge of edges) {
      const low = v;
      for (const top of edge) {
        pos[3 * v] = pos[3 * top];
        pos[3 * v + 1] = pos[3 * top + 1] - SKIRT_DEPTH;
        pos[3 * v + 2] = pos[3 * top + 2];
        nrm[3 * v + 1] = 1;
        v++;
      }
      for (let k = 0; k < n; k++) {
        const [a, b, cc, d] = [edge[k], edge[k + 1], low + k, low + k + 1];
        idx[t++] = a; idx[t++] = cc; idx[t++] = b;
        idx[t++] = b; idx[t++] = cc; idx[t++] = d;
        idx[t++] = a; idx[t++] = b; idx[t++] = cc;
        idx[t++] = b; idx[t++] = d; idx[t++] = cc;
      }
    }
  }
  return { position: pos, normal: nrm, index: idx };
}

/** Typed arrays (from buildBlockBuffers, here or in a worker) -> the block's geometry. */
export function blockGeometry(b: { position: Float32Array; normal: Float32Array; index: Uint16Array | Uint32Array }): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(b.position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(b.normal, 3));
  g.setIndex(new THREE.BufferAttribute(b.index, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export function buildBlockGeometry(chunks: readonly LodChunk[], chunkWorldSize: number, originX: number, originZ: number): THREE.BufferGeometry {
  return blockGeometry(buildBlockBuffers(chunks, chunkWorldSize, originX, originZ));
}
