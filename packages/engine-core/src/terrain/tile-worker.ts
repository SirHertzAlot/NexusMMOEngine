/**
 * Tile generation worker for the world bake. Receives the survey's height
 * and roughness arrays plus a batch of chunk coordinates, generates each
 * chunk's 16×16 tile using the same logic as WorldHeights.generateChunk,
 * and returns the results.
 *
 * The survey arrays are received as typed arrays (structured clone) and
 * are read-only here. The detail noise is recreated from the spec
 * parameters passed in workerData.
 */

import { parentPort, workerData } from "node:worker_threads";
import { makeProcgenChunkSource } from "../procgen/chunk-source.js";
import { fieldSeed } from "./survey.js";

interface TileWorkerData {
  height: Float32Array;
  roughness: Float32Array;
  gridWidth: number;
  gridDepth: 1;
  gridCell: number;
  originX: number;
  originZ: number;
  chunkWorldSize: number;
  detailAmplitude: number;
  detailScale: number;
  specSeed: number;
  chunks: Array<[number, number]>;
}

interface TileWorkerResult {
  tiles: Array<{ cx: number; cz: number; heights: Float32Array }>;
}

if (parentPort) {
  const data = workerData as TileWorkerData;
  const port = parentPort;

  // Reconstruct the sampling context from the survey data.
  const g = {
    width: data.gridWidth,
    depth: data.gridDepth,
    cell: data.gridCell,
    originX: data.originX,
    originZ: data.originZ,
  };

  // Recreate the detail noise source (same as WorldHeights constructor).
  const spacing = data.chunkWorldSize / 15;
  const detail = makeProcgenChunkSource({ amplitude: 1, frequency: Math.min(1, spacing / data.detailScale) });
  const detailSeed = fieldSeed(data.specSeed, 7);

  const block = new Float32Array(256);

  function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }

  function sampleField(field: Float32Array, x: number, z: number, cubic: boolean): number {
    const fu = (x - g.originX) / g.cell;
    const fv = (z - g.originZ) / g.cell;
    const u = Math.floor(fu);
    const v = Math.floor(fv);
    const tu = fu - u;
    const tv = fv - v;
    const at = (du: number, dv: number): number => {
      const uu = Math.min(g.width - 1, Math.max(0, u + du));
      const vv = Math.min(g.depth - 1, Math.max(0, v + dv));
      return field[vv * g.width + uu];
    };
    if (!cubic) {
      return (at(0, 0) * (1 - tu) + at(1, 0) * tu) * (1 - tv) + (at(0, 1) * (1 - tu) + at(1, 1) * tu) * tv;
    }
    const row = (dv: number): number => catmullRom(at(-1, dv), at(0, dv), at(1, dv), at(2, dv), tu);
    return catmullRom(row(-1), row(0), row(1), row(2), tv);
  }

  const tiles: Array<{ cx: number; cz: number; heights: Float32Array }> = [];
  for (const [cx, cz] of data.chunks) {
    detail.generateChunk(detailSeed, cx, cz, 0, block);
    const out = new Float32Array(256);
    for (let j = 0; j < 16; j++) {
      const z = (cz * 15 + j) * spacing;
      for (let i = 0; i < 16; i++) {
        const x = (cx * 15 + i) * spacing;
        out[j * 16 + i] =
          sampleField(data.height, x, z, true) +
          block[j * 16 + i] * data.detailAmplitude * sampleField(data.roughness, x, z, false);
      }
    }
    tiles.push({ cx, cz, heights: out });
  }

  const result: TileWorkerResult = { tiles };
  port.postMessage(result);
}
