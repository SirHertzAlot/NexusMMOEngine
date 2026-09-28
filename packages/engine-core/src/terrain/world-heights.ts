/**
 * World heights — the fine heightmap built on the coarse survey.
 *
 * Every fine sample sits on the world's global sample grid
 * (gx = cx*15 + i, world x = gx * chunkWorldSize / 15), so a chunk's
 * heights are a pure function of (gx, gz): neighbouring chunks compute
 * their shared border samples from identical inputs and seams are exact by
 * construction. Height = the survey elevation (bicubic, smooth across the
 * 8 m cells) + fine detail noise scaled by the blended biome roughness.
 */

import { makeProcgenChunkSource, type ChunkDataSource } from "../procgen/chunk-source.js";
import { fieldSeed, type Survey } from "./survey.js";

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

export class WorldHeights implements ChunkDataSource {
  readonly chunkSamples = 256;
  private readonly detail: ChunkDataSource;
  private readonly detailSeed: bigint;
  private readonly block = new Float32Array(256);

  constructor(private readonly survey: Survey) {
    const spec = survey.spec;
    // Detail noise runs on the fine grid itself (noise coord = gx), with
    // its feature size converted from metres to samples.
    const spacing = spec.chunkWorldSize / 15;
    this.detail = makeProcgenChunkSource({ amplitude: 1, frequency: Math.min(1, spacing / spec.detailScale) });
    this.detailSeed = fieldSeed(spec.seed, 7);
  }

  /** Survey field at world (x, z): bicubic for height, bilinear otherwise. */
  private coarse(field: Float32Array, x: number, z: number, cubic: boolean): number {
    const g = this.survey.grid;
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

  /** One chunk's 16×16 heights (row-major, X inner), the stored tile layout. */
  generateChunk(_seed: bigint, cx: number, cz: number, _lod: number, out: Float32Array): void {
    const spec = this.survey.spec;
    const spacing = spec.chunkWorldSize / 15;
    this.detail.generateChunk(this.detailSeed, cx, cz, 0, this.block);
    for (let j = 0; j < 16; j++) {
      const z = (cz * 15 + j) * spacing;
      for (let i = 0; i < 16; i++) {
        const x = (cx * 15 + i) * spacing;
        out[j * 16 + i] =
          this.coarse(this.survey.height, x, z, true) +
          this.block[j * 16 + i] * spec.detailAmplitude * this.coarse(this.survey.roughness, x, z, false);
      }
    }
  }
}
