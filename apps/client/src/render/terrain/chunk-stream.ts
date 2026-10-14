import { chunkKey, type TerrainTile } from '@mmo-engine/protocol';

/**
 * On-demand chunk streaming: priority queue, in-flight dedup, LRU cache.
 *
 * The manager owns *which* chunks are wanted and *where they come from* —
 * the ChunkSource abstraction. Rendering stays in TerrainRenderer; this
 * layer only decides demand and routes supply. Region handoff swaps the
 * source (see RegionCoordinator); in-flight fetches finish on the old
 * source, new demand goes to the new one.
 */

/** Where chunk tiles come from on demand (a region server connection, a local bake, ...). */
export interface ChunkSource {
  /** Fetch tiles for "cx,cz" keys. Tiles that don't exist are omitted. */
  fetchTiles(keys: string[]): Promise<TerrainTile[]>;
}

export interface StreamEvents {
  /** A tile arrived and is cached — hand it to the renderer. */
  onTile(tile: TerrainTile): void;
  /** A tile was evicted — the renderer may drop it. */
  onEvict(cx: number, cz: number): void;
}

export interface StreamOptions {
  /** Max tiles held in cache before farthest-first eviction. Default 1024. */
  maxCached?: number;
  /** Max concurrent fetch batches. Default 4. */
  maxInflight?: number;
  /** Tiles per fetch batch. Default 16. */
  batchSize?: number;
}

interface CacheEntry {
  tile: TerrainTile;
  /** Last camera chunk when this entry was wanted (for eviction distance). */
  wx: number;
  wz: number;
}

const keyOf = (cx: number, cz: number): string => chunkKey(cx, cz);
const parseKey = (k: string): [number, number] => {
  const [x, z] = k.split(',').map(Number);
  return [x, z];
};

export class ChunkStreamManager {
  private source: ChunkSource;
  private readonly events: StreamEvents;
  private readonly maxCached: number;
  private readonly maxInflight: number;
  private readonly batchSize: number;

  /** key -> entry, insertion-ordered for LRU. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Keys with a fetch in flight. */
  private readonly inflight = new Set<string>();
  /** Queued keys, nearest-first. Rebuilt on every update(). */
  private queue: string[] = [];
  private camCX = 0;
  private camCZ = 0;
  private disposed = false;

  constructor(source: ChunkSource, events: StreamEvents, opts: StreamOptions = {}) {
    this.source = source;
    this.events = events;
    this.maxCached = opts.maxCached ?? 1024;
    this.maxInflight = opts.maxInflight ?? 4;
    this.batchSize = opts.batchSize ?? 16;
  }

  /**
   * Recompute demand around the camera chunk. Call when the camera crosses
   * a chunk boundary (or every few frames while moving). Desired set is the
   * Chebyshev disc of `radius`; the queue is nearest-first.
   */
  update(cameraCX: number, cameraCZ: number, radius: number): void {
    if (this.disposed) return;
    this.camCX = cameraCX;
    this.camCZ = cameraCZ;
    const wanted: Array<{ k: string; d: number }> = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = cameraCX + dx, cz = cameraCZ + dz;
        const k = keyOf(cx, cz);
        const e = this.cache.get(k);
        if (e) {
          // Refresh LRU + eviction anchor.
          this.cache.delete(k);
          this.cache.set(k, { tile: e.tile, wx: cameraCX, wz: cameraCZ });
          continue;
        }
        if (this.inflight.has(k)) continue;
        wanted.push({ k, d: Math.max(Math.abs(dx), Math.abs(dz)) });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    this.queue = wanted.map((w) => w.k);
    this.pump();
    this.evict();
  }

  /** Low-priority lookahead (region-handoff prefetch). Never jumps the queue. */
  prefetch(keys: string[]): void {
    if (this.disposed) return;
    const queued = new Set(this.queue);
    for (const k of keys) {
      if (this.cache.has(k) || this.inflight.has(k) || queued.has(k)) continue;
      queued.add(k);
      this.queue.push(k);
    }
    this.pump();
  }

  /**
   * Swap the tile source (region handoff). In-flight fetches finish against
   * the old source; everything queued or future goes to the new one.
   */
  setSource(source: ChunkSource): void {
    this.source = source;
    this.pump();
  }

  /** Drop everything (disconnect / world change). */
  clear(): void {
    for (const k of this.cache.keys()) {
      const [cx, cz] = parseKey(k);
      this.events.onEvict(cx, cz);
    }
    this.cache.clear();
    this.queue = [];
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
  }

  /** For tests / diagnostics. */
  get cachedCount(): number { return this.cache.size; }
  get inflightCount(): number { return this.inflight.size; }
  get queuedCount(): number { return this.queue.length; }

  private pump(): void {
    if (this.disposed) return;
    while (this.inflight.size < this.maxInflight && this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      for (const k of batch) this.inflight.add(k);
      const source = this.source;
      void source.fetchTiles(batch).then(
        (tiles) => {
          for (const k of batch) this.inflight.delete(k);
          if (this.disposed) return;
          for (const t of tiles) {
            const k = keyOf(t.cx, t.cz);
            if (!this.cache.has(k)) {
              this.cache.set(k, { tile: t, wx: this.camCX, wz: this.camCZ });
              this.events.onTile(t);
            }
          }
          this.evict();
          this.pump();
        },
        () => {
          // Lossy-OK: a failed batch just frees its keys for a later retry.
          for (const k of batch) this.inflight.delete(k);
          if (!this.disposed) this.pump();
        },
      );
    }
  }

  /** Evict farthest-from-camera tiles beyond maxCached. */
  private evict(): void {
    while (this.cache.size > this.maxCached) {
      let farthest: string | null = null;
      let farthestD = -1;
      for (const [k, e] of this.cache) {
        const d = Math.max(Math.abs(e.tile.cx - this.camCX), Math.abs(e.tile.cz - this.camCZ));
        if (d > farthestD) { farthestD = d; farthest = k; }
      }
      if (farthest === null) break;
      const [cx, cz] = parseKey(farthest);
      this.cache.delete(farthest);
      this.events.onEvict(cx, cz);
    }
  }
}

/** Encode (cx, cz) as the u64 chunkId the renderer expects (high 32 = cx, low 32 = cz). */
export function chunkIdFor(cx: number, cz: number): bigint {
  return ((BigInt(cx) & 0xffffffffn) << 32n) | (BigInt(cz) & 0xffffffffn);
}
