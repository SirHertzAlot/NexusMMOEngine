/**
 * Chunk terrain geometry: one 16x16-sample tile as a triangle mesh, and
 * vertex normals that agree across chunk borders.
 *
 * Triangles split every cell along its (i+1, j)-(i, j+1) diagonal — the
 * triangles the server grounds characters on (terrainHeightAt) and Jolt
 * collides with, so what you see is what you stand on.
 *
 * Normals come from central differences on the WORLD sample grid: border
 * samples look into the neighbouring chunk (its tile shares the border
 * row), so both sides of a seam compute the same normal and the lighting
 * has no visible edge. Where a neighbour isn't loaded yet, the difference
 * is one-sided; the renderer recomputes the border when it arrives.
 */

import * as THREE from "three";

export const SIDE = 16;
const CELLS = SIDE - 1;

/** A loaded neighbour's tile by chunk offset (dx, dz in -1..1), or null. */
export type NeighbourTiles = (dx: number, dz: number) => Float32Array | null;

/**
 * Height at local sample (i, j) with i, j in -1..16: inside the tile, or
 * one sample into a neighbour (sample -1 of this chunk is sample 14 of the
 * one before it, since they share sample 15/0). Null when not loaded.
 */
function sampleAt(heights: Float32Array, neighbour: NeighbourTiles, i: number, j: number): number | null {
  let dx = 0;
  let dz = 0;
  if (i < 0) [dx, i] = [-1, i + CELLS];
  else if (i > CELLS) [dx, i] = [1, i - CELLS];
  if (j < 0) [dz, j] = [-1, j + CELLS];
  else if (j > CELLS) [dz, j] = [1, j - CELLS];
  const tile = dx === 0 && dz === 0 ? heights : neighbour(dx, dz);
  return tile ? tile[j * SIDE + i] : null;
}

/** Write 256 unit normals (xyz) for a tile into `out` (length 768). */
export function chunkNormals(heights: Float32Array, neighbour: NeighbourTiles, spacing: number, out: Float32Array): void {
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      const h = heights[j * SIDE + i];
      const l = sampleAt(heights, neighbour, i - 1, j);
      const r = sampleAt(heights, neighbour, i + 1, j);
      const d = sampleAt(heights, neighbour, i, j - 1);
      const u = sampleAt(heights, neighbour, i, j + 1);
      // One-sided where the far side isn't loaded.
      const dhdx = ((r ?? h) - (l ?? h)) / (((r === null ? 0 : 1) + (l === null ? 0 : 1)) * spacing || 1);
      const dhdz = ((u ?? h) - (d ?? h)) / (((u === null ? 0 : 1) + (d === null ? 0 : 1)) * spacing || 1);
      const inv = 1 / Math.hypot(dhdx, 1, dhdz);
      const k = 3 * (j * SIDE + i);
      out[k] = -dhdx * inv;
      out[k + 1] = inv;
      out[k + 2] = -dhdz * inv;
    }
  }
}

/** Two triangles per cell, split along (i+1, j)-(i, j+1), facing +Y. */
function chunkIndex(): THREE.BufferAttribute {
  const idx = new Uint16Array(CELLS * CELLS * 6);
  let t = 0;
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const a = j * SIDE + i;
      const b = a + 1;
      const c = a + SIDE;
      const d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = d; idx[t++] = b; idx[t++] = c;
    }
  }
  return new THREE.BufferAttribute(idx, 1);
}

/**
 * A chunk's mesh geometry in chunk-local coordinates (x, z in
 * 0..chunkWorldSize); normals start one-sided (see chunkNormals).
 */
export function buildChunkGeometry(heights: Float32Array, chunkWorldSize: number): THREE.BufferGeometry {
  if (heights.length !== SIDE * SIDE) throw new Error(`terrain: want ${SIDE * SIDE} heights, got ${heights.length}`);
  const spacing = chunkWorldSize / CELLS;
  const pos = new Float32Array(SIDE * SIDE * 3);
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      const k = 3 * (j * SIDE + i);
      pos[k] = i * spacing;
      pos[k + 1] = heights[j * SIDE + i];
      pos[k + 2] = j * spacing;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const normals = new Float32Array(SIDE * SIDE * 3);
  chunkNormals(heights, () => null, spacing, normals);
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(chunkIndex());
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
