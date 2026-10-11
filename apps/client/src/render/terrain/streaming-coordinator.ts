import type { MirrorClient } from '@mmo-engine/mirror';
import type { ChunkRange, TerrainTile } from '@mmo-engine/protocol';
import { ChunkStreamManager, chunkIdFor, type ChunkSource } from './chunk-stream.js';
import { RegionCoordinator, type RegionInfo } from './region-coordinator.js';
import type { TerrainRenderer } from './terrain-renderer.js';

/**
 * StreamingCoordinator — the intake adapter that ties chunk streaming
 * into the renderer and the region handoff.
 *
 * Wiring:
 *   mirror Client --requestTiles--> MirrorTileSource --tiles--> ChunkStreamManager
 *        --onTile--> TerrainRenderer.ensureChunk (via chunkIdFor wire ids)
 *        --onRegionChange--> coordinator.commitRegionChange (handoff commit)
 *   RegionCoordinator --prefetch--> manager.prefetch (handoff lookahead)
 *                    --routingSource--> manager source (per-key region routing)
 *
 * The app injects its mirror Client and TerrainRenderer, registers each
 * region (id, range, endpoint) as it learns them, and calls onRegionChange
 * from the mirror client's onRegionChange event. Predictive prefetch runs
 * off trackPlayer(); the bye-redirect is the commit signal.
 */

/** A ChunkSource backed by a live mirror Client connection. */
export class MirrorTileSource implements ChunkSource {
  constructor(private readonly client: MirrorClient) {}

  async fetchTiles(keys: string[]): Promise<TerrainTile[]> {
    return this.client.requestTiles(keys);
  }
}

export interface StreamingCoordinatorOptions {
  /** Stream radius in chunks around the camera. Default 6. */
  radius?: number;
  /** Chunks from the camera that trigger neighbor-region prefetch. Default 2. */
  handoffMargin?: number;
}

export class StreamingCoordinator {
  private readonly manager: ChunkStreamManager;
  private readonly coordinator: RegionCoordinator;
  private readonly renderer: TerrainRenderer;
  private readonly radius: number;
  private readonly handoffMargin: number;
  private client: MirrorClient | null = null;
  private primaryRegion: RegionInfo | null = null;

  constructor(renderer: TerrainRenderer, opts: StreamingCoordinatorOptions = {}) {
    this.renderer = renderer;
    this.radius = opts.radius ?? 6;
    this.handoffMargin = opts.handoffMargin ?? 2;
    this.coordinator = new RegionCoordinator((keys) => this.manager.prefetch(keys));
    this.manager = new ChunkStreamManager(this.coordinator.routingSource(), {
      onTile: (tile) => {
        // Feed the renderer: ensureChunk takes a ChunkRow; synthesize the
        // wire id from chunk coords (chunkIdFor round-trips chunkCoords).
        this.renderer.ensureChunk(chunkIdFor(tile.cx, tile.cz), {
          wireId: chunkIdFor(tile.cx, tile.cz),
          chunkId: chunkIdFor(tile.cx, tile.cz),
          seed: 0n,
          lod: 0,
          heights: tile.heights,
        });
      },
      onEvict: (cx, cz) => {
        this.renderer.removeChunk(chunkIdFor(cx, cz));
      },
    });
  }

  /** Inject the live mirror client (called once the app connects). */
  attachClient(client: MirrorClient): void {
    this.client = client;
  }

  /**
   * Register a region the client may stream from. The source routes through
   * the attached mirror client; call attachClient first in production, or
   * pass an explicit source (tests, local bakes).
   */
  addRegion(regionId: string, range: ChunkRange, endpoint: string, source?: ChunkSource): void {
    const src = source ?? (this.client ? new MirrorTileSource(this.client) : null);
    if (!src) throw new Error("streaming: attachClient() before addRegion(), or pass a source");
    const info: RegionInfo = { regionId, range, endpoint, source: src };
    this.coordinator.setRegion(info);
    if (!this.primaryRegion) this.primaryRegion = info;
  }

  /** The mirror client fired onRegionChange: the handoff committed. */
  onRegionChange(endpoint: string): void {
    const info = this.coordinator.findByEndpoint(endpoint);
    if (!info) return; // unknown endpoint: routing still follows ownership
    this.primaryRegion = info;
    // The bye-redirect is authoritative: commit any announced handoff
    // targeting this region so routing flips immediately.
    this.coordinator.commitHandoff(info.range, info.regionId);
  }

  /**
   * Call per frame (or on camera move) with the camera's world position and
   * velocity. Drives demand and predicts region crossings for prefetch.
   */
  trackPlayer(x: number, z: number, vx: number, vz: number, chunkWorldSize: number): void {
    const cx = Math.floor(x / chunkWorldSize);
    const cz = Math.floor(z / chunkWorldSize);
    this.manager.update(cx, cz, this.radius);
    this.predictHandoff(cx, cz, vx, vz, chunkWorldSize);
  }

  /** For tests. */
  get streamManager(): ChunkStreamManager { return this.manager; }
  get regionCoordinator(): RegionCoordinator { return this.coordinator; }

  /**
   * If the player is within handoffMargin chunks of a neighboring region's
   * boundary and moving toward it, announce a handoff so its border tiles
   * prefetch before the bye-redirect arrives.
   */
  private predictHandoff(cx: number, cz: number, vx: number, vz: number, chunkWorldSize: number): void {
    if ((vx === 0 && vz === 0) || !this.primaryRegion) return;
    const stepX = vx * chunkWorldSize;
    const stepZ = vz * chunkWorldSize;
    for (const id of this.coordinator.regionIds()) {
      const info = this.coordinator.getRegion(id);
      if (!info || info.regionId === this.primaryRegion.regionId) continue;
      const r = info.range;
      // Distance from the player chunk to the region's range (0 if inside).
      const dx = cx < r.minCx ? r.minCx - cx : cx > r.maxCx ? cx - r.maxCx : 0;
      const dz = cz < r.minCz ? r.minCz - cz : cz > r.maxCz ? cz - r.maxCz : 0;
      if (Math.max(dx, dz) > this.handoffMargin) continue;
      // Moving toward it?
      const towardX = (cx < r.minCx && stepX > 0) || (cx > r.maxCx && stepX < 0);
      const towardZ = (cz < r.minCz && stepZ > 0) || (cz > r.maxCz && stepZ < 0);
      if (!towardX && !towardZ) continue;
      this.coordinator.announceHandoff(r, info.regionId);
    }
  }
}
