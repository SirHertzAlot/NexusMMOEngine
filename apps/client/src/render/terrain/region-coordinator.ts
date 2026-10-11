import { chunkKey, type ChunkRange, type TerrainTile } from '@mmo-engine/protocol';
import type { ChunkSource } from './chunk-stream.js';

/**
 * Region ownership + handoff coordination for chunk streaming.
 *
 * The world server owns the region registry (which region serves which
 * chunk range, and migrations between them). This coordinator mirrors that
 * ownership on the client so the ChunkStreamManager fetches every tile from
 * the region that actually serves it — and so a region-to-region handoff
 * prefetches the gaining region's tiles *before* the switch, instead of
 * faulting them in after the player has already crossed.
 *
 * Network seam: the client's world-server channel calls announceHandoff()
 * when a migration begins and commitHandoff() when it resolves. Both are
 * idempotent; a commit for an unknown announcement is a no-op.
 */

export interface RegionInfo {
  regionId: string;
  range: ChunkRange;
  /** Connection to that region's server, as a tile source. */
  source: ChunkSource;
}

interface Handoff {
  range: ChunkRange;
  toRegionId: string;
}

const inRange = (r: ChunkRange, cx: number, cz: number): boolean =>
  cx >= r.minCx && cx <= r.maxCx && cz >= r.minCz && cz <= r.maxCz;

export function keysInRange(r: ChunkRange): string[] {
  const keys: string[] = [];
  for (let cz = r.minCz; cz <= r.maxCz; cz++)
    for (let cx = r.minCx; cx <= r.maxCx; cx++) keys.push(chunkKey(cx, cz));
  return keys;
}

export class RegionCoordinator {
  private readonly regions = new Map<string, RegionInfo>();
  /** regionId -> in-progress handoff gaining *to* that region. */
  private readonly handoffs = new Map<string, Handoff>();
  /** Called with low-priority prefetch keys during a handoff announcement. */
  private readonly onPrefetch: (keys: string[]) => void;

  constructor(onPrefetch: (keys: string[]) => void) {
    this.onPrefetch = onPrefetch;
  }

  /** Register or update a region (join, registry refresh). */
  setRegion(info: RegionInfo): void {
    this.regions.set(info.regionId, info);
  }

  /** Drop a region (deregister). In-flight fetches finish; new ones route elsewhere. */
  removeRegion(regionId: string): void {
    this.regions.delete(regionId);
  }

  /** Which region currently serves chunk (cx, cz)? */
  ownerOf(cx: number, cz: number): RegionInfo | null {
    for (const info of this.regions.values()) {
      if (inRange(info.range, cx, cz)) return info;
    }
    return null;
  }

  /**
   * A ChunkSource that routes every key to its owning region's source.
   * Pass this to the ChunkStreamManager; ownership changes apply live.
   */
  routingSource(): ChunkSource {
    return {
      fetchTiles: async (keys: string[]): Promise<TerrainTile[]> => {
        const byRegion = new Map<RegionInfo, string[]>();
        for (const k of keys) {
          const [cx, cz] = k.split(',').map(Number);
          const owner = this.ownerOf(cx, cz);
          if (!owner) continue; // no owner: tile omitted (streamed as flat)
          const list = byRegion.get(owner);
          if (list) list.push(k); else byRegion.set(owner, [k]);
        }
        const results = await Promise.all(
          [...byRegion].map(([info, ks]) => info.source.fetchTiles(ks)),
        );
        return results.flat();
      },
    };
  }

  /**
   * The world server began a migration: `range` moves to `toRegionId`.
   * Prefetch the range from the gaining region now, at low priority, so
   * tiles are warm when commitHandoff() flips routing.
   */
  announceHandoff(range: ChunkRange, toRegionId: string): void {
    const to = this.regions.get(toRegionId);
    if (!to) return; // unknown region: stay on current routing
    this.handoffs.set(toRegionId, { range, toRegionId });
    // Warm the gaining region's tiles at low priority; routing flips on commit.
    this.onPrefetch(keysInRange(range));
  }

  /**
   * The world server resolved the migration. Routing for `range` now goes
   * to `toRegionId`. Unknown/duplicate commits are no-ops.
   */
  commitHandoff(range: ChunkRange, toRegionId: string): void {
    const pending = this.handoffs.get(toRegionId);
    if (!pending) return;
    this.handoffs.delete(toRegionId);
    const to = this.regions.get(toRegionId);
    if (!to) return;
    // Narrow the losing region(s) and widen the winner to the migrated range.
    for (const info of this.regions.values()) {
      if (info.regionId === toRegionId) continue;
      if (rangesOverlap(info.range, range)) {
        info.range = subtractRange(info.range, range);
      }
    }
    to.range = unionRange(to.range, range);
  }

  /** For tests / diagnostics. */
  get regionCount(): number { return this.regions.size; }
  get pendingHandoffs(): number { return this.handoffs.size; }
}

function rangesOverlap(a: ChunkRange, b: ChunkRange): boolean {
  return a.minCx <= b.maxCx && a.maxCx >= b.minCx && a.minCz <= b.maxCz && a.maxCz >= b.minCz;
}

function unionRange(a: ChunkRange, b: ChunkRange): ChunkRange {
  return {
    minCx: Math.min(a.minCx, b.minCx),
    minCz: Math.min(a.minCz, b.minCz),
    maxCx: Math.max(a.maxCx, b.maxCx),
    maxCz: Math.max(a.maxCz, b.maxCz),
  };
}

/**
 * Subtract b from a. Assumes b is a sub-range touching one edge of a
 * (the migration case); otherwise returns a unchanged.
 */
function subtractRange(a: ChunkRange, b: ChunkRange): ChunkRange {
  const r = { ...a };
  if (b.minCx <= a.minCx && b.maxCx < a.maxCx && b.minCz <= a.minCz && b.maxCz >= a.maxCz) {
    r.minCx = b.maxCx + 1; // b took the west strip
  } else if (b.maxCx >= a.maxCx && b.minCx > a.minCx && b.minCz <= a.minCz && b.maxCz >= a.maxCz) {
    r.maxCx = b.minCx - 1; // b took the east strip
  } else if (b.minCz <= a.minCz && b.maxCz < a.maxCz && b.minCx <= a.minCx && b.maxCx >= a.maxCx) {
    r.minCz = b.maxCz + 1; // b took the north strip
  } else if (b.maxCz >= a.maxCz && b.minCz > a.minCz && b.minCx <= a.minCx && b.maxCx >= a.maxCx) {
    r.maxCz = b.minCz - 1; // b took the south strip
  }
  return r;
}
