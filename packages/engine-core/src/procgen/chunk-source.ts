/**
 * chunk-source.ts — fills Chunk-component data from the procgen addon
 * (slice 1.6).
 *
 * The `Chunk` component carries chunk *metadata* (chunk id, seed, lod) in
 * the ECS world; the heightmap itself is generated on demand through the
 * narrow `ChunkDataSource` interface and handed back to the caller. Chunk
 * data is never persisted: it is deterministically regenerable from
 * (seed, cx, cz, lod), so snapshots stay small and a reboot reproduces
 * identical terrain.
 *
 * SOLID: engine code depends only on `ChunkDataSource`, so the native
 * addon can be swapped (e.g. a different noise library, or a pure-JS
 * fallback) without touching callers.
 */

import { createRequire } from "node:module";
import { addComponent } from "bitecs";
import { Chunk, splitU64 } from "../components.js";
import type { SimWorld } from "../world.js";

/** Narrow interface for chunk heightmap generation. */
export interface ChunkDataSource {
  /** Number of height samples per chunk (16x16 = 256). */
  readonly chunkSamples: number;
  /**
   * Write the chunk heightmap into `out` (must hold >= chunkSamples
   * floats). Row-major, X as the inner loop.
   */
  generateChunk(
    seed: bigint,
    cx: number,
    cz: number,
    lod: number,
    out: Float32Array,
  ): void;
}

/**
 * World-space terrain shape. The server, the offline baker, and every
 * heightfield consumer (grounding, scatter, navmesh, mirror) must agree on
 * these, so they are resolved in one place (terrainOptionsFromEnv) and
 * fingerprinted into `terrainVersion`.
 */
export interface TerrainOptions {
  /** World-unit height scale applied to the addon's (-1, 1) output. */
  amplitude?: number;
  /** Noise frequency in (0, 1]; lower = broader hills. Addon default when omitted. */
  frequency?: number;
}

/**
 * Gently rolling ground with plenty of flat space (99% of slopes under
 * ~20°). A single global scale for now: dramatic relief (mountains) is
 * meant to come from biomes driving amplitude/frequency per region.
 */
export const DEFAULT_TERRAIN_AMPLITUDE = 2;

/** Bumped whenever the native sampling scheme changes (v2: shared chunk edges + FBm). */
const TERRAIN_GENERATOR_VERSION = 2;

/** A procgen-backed source plus the resolved terrain shape it produces. */
export interface ProcgenChunkSource extends ChunkDataSource {
  readonly amplitude: number;
  readonly frequency: number;
  /**
   * u32 fingerprint of (generator version, amplitude, frequency). Keys
   * cached navmesh tiles and is recorded with persisted snapshots, so
   * terrain changes never silently reuse data baked for other terrain.
   */
  readonly terrainVersion: number;
}

/**
 * Read MMO_TERRAIN_AMPLITUDE / MMO_TERRAIN_FREQUENCY. Unset values fall
 * back to the defaults; invalid values throw (a typo must not silently
 * produce a different world).
 */
export function terrainOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TerrainOptions {
  const opts: TerrainOptions = {};
  const amp = env.MMO_TERRAIN_AMPLITUDE;
  if (amp !== undefined && amp !== "") {
    const v = Number(amp);
    if (!Number.isFinite(v) || v <= 0) {
      throw new RangeError(`MMO_TERRAIN_AMPLITUDE must be a positive number (got ${amp})`);
    }
    opts.amplitude = v;
  }
  const freq = env.MMO_TERRAIN_FREQUENCY;
  if (freq !== undefined && freq !== "") {
    const v = Number(freq);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      throw new RangeError(`MMO_TERRAIN_FREQUENCY must be in (0, 1] (got ${freq})`);
    }
    opts.frequency = v;
  }
  return opts;
}

/** FNV-1a over a string, as u32. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Build a ChunkDataSource backed by @mmo-engine/addon-procgen, scaled to
 * world units by `opts.amplitude`. Throws a helpful error when the native
 * binding is not built (run `npm install` at the repo root first).
 */
export function makeProcgenChunkSource(
  opts: TerrainOptions = {},
): ProcgenChunkSource {
  const require = createRequire(import.meta.url);
  let addon: {
    CHUNK_SAMPLES: number;
    DEFAULT_FREQUENCY: number;
    generateChunk(
      seed: bigint,
      cx: number,
      cz: number,
      lod: number,
      out: Float32Array,
      frequency?: number,
    ): void;
  };
  try {
    // The addon is a CJS native binding; require keeps ESM/CJS interop simple.
    addon = require("@mmo-engine/addon-procgen");
  } catch (err) {
    throw new Error(
      "chunk-source: @mmo-engine/addon-procgen is not built. " +
        "Run `npm install` at the repo root to build the native addon. " +
        `Underlying error: ${(err as Error).message}`,
    );
  }
  const amplitude = opts.amplitude ?? DEFAULT_TERRAIN_AMPLITUDE;
  const frequency = opts.frequency ?? addon.DEFAULT_FREQUENCY;
  const samples = addon.CHUNK_SAMPLES;
  return {
    chunkSamples: samples,
    amplitude,
    frequency,
    terrainVersion: fnv1a32(
      `procgen-v${TERRAIN_GENERATOR_VERSION}|${amplitude}|${frequency}`,
    ),
    generateChunk: (seed, cx, cz, lod, out) => {
      addon.generateChunk(seed, cx, cz, lod, out, frequency);
      for (let i = 0; i < samples; i++) out[i] *= amplitude;
    },
  };
}

/**
 * Chunk source backed by the stored world heightmap (TerrainTileStore):
 * chunks with a tile return it; chunks without one (never baked — the
 * world beyond the edge) and LOD > 0 come from `fallback`, typically the
 * procgen source. Stored tiles belong to this world, so `seed` only
 * matters for the fallback.
 */
export function makeTileChunkSource(
  tiles: { get(cx: number, cz: number): Float32Array | null },
  fallback: ChunkDataSource,
): ChunkDataSource {
  return {
    chunkSamples: fallback.chunkSamples,
    generateChunk(seed, cx, cz, lod, out) {
      const stored = lod === 0 ? tiles.get(cx, cz) : null;
      if (stored !== null) out.set(stored);
      else fallback.generateChunk(seed, cx, cz, lod, out);
    },
  };
}

/**
 * u32 FNV-1a over a heightfield's bytes. Keys cached navmesh tiles to the
 * exact terrain they were baked from, so a sculpted chunk re-bakes and an
 * untouched one reuses its cache.
 */
export function heightsFingerprint(heights: Float32Array): number {
  const bytes = new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Memoize a ChunkDataSource per (seed, cx, cz, lod). Heights are a pure
 * function of those inputs, so repeat requests (every network snapshot,
 * every reconnect, grounding, baking) copy 256 floats instead of
 * re-running native noise. Bounded LRU: at most `capacity` chunks
 * (~1 KiB each) stay resident, so a streaming world can't grow it
 * without limit. Callers still own `out` — cached arrays never escape.
 */
export function createCachedChunkSource<T extends ChunkDataSource>(
  inner: T,
  capacity = 1024,
): T {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`chunk cache capacity must be a positive integer (got ${capacity})`);
  }
  const cache = new Map<string, Float32Array>();
  return {
    ...inner,
    generateChunk(seed, cx, cz, lod, out) {
      const key = `${seed}:${cx}:${cz}:${lod}`;
      let heights = cache.get(key);
      if (heights !== undefined) {
        cache.delete(key); // refresh recency
      } else {
        heights = new Float32Array(inner.chunkSamples);
        inner.generateChunk(seed, cx, cz, lod, heights);
        if (cache.size >= capacity) {
          cache.delete(cache.keys().next().value as string);
        }
      }
      cache.set(key, heights);
      out.set(heights);
    },
  };
}

/**
 * Pack (cx, cz) int32 chunk coordinates into a u64 chunk id:
 * high 32 bits = cx, low 32 bits = cz (two's complement preserved).
 */
export function chunkIdFor(cx: number, cz: number): bigint {
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) {
    throw new RangeError("chunk coords must be integers");
  }
  return ((BigInt(cx) & 0xffffffffn) << 32n) | (BigInt(cz) & 0xffffffffn);
}

/**
 * Inverse of chunkIdFor: recover signed (cx, cz) from a packed chunk id.
 */
export function chunkCoordsFor(chunkId: bigint): { cx: number; cz: number } {
  const cx = Number(BigInt.asIntN(32, chunkId >> 32n));
  const cz = Number(BigInt.asIntN(32, chunkId & 0xffffffffn));
  return { cx, cz };
}

/**
 * Spawn a chunk entity: writes the Chunk component metadata and generates
 * the heightmap through `source`. Returns the entity id and the heights.
 */
export function spawnChunk(
  world: SimWorld,
  source: ChunkDataSource,
  seed: bigint,
  cx: number,
  cz: number,
  lod: number,
): { eid: number; heights: Float32Array } {
  const eid = world.spawn();
  addComponent(world.ecs, Chunk, eid);
  const id = splitU64(chunkIdFor(cx, cz));
  const s = splitU64(seed);
  Chunk.chunkIdHi[eid] = id.hi;
  Chunk.chunkIdLo[eid] = id.lo;
  Chunk.seedHi[eid] = s.hi;
  Chunk.seedLo[eid] = s.lo;
  Chunk.lod[eid] = lod;
  const heights = new Float32Array(source.chunkSamples);
  source.generateChunk(seed, cx, cz, lod, heights);
  return { eid, heights };
}
