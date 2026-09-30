/**
 * Navmesh bake worker for ChunkNavmesh: bakes a chunk's tile and registers
 * it (Recast + a tile file + a registry row, 5-40 ms on Windows) off the
 * tick thread. The main thread loads the returned blob into its own
 * navigation service.
 *
 * Jobs are queued and run one per event-loop turn, so a "cancel" posted
 * for a chunk that unloaded meanwhile is seen before its job runs.
 *
 * Protocol (from ChunkNavmesh):
 *   { kind: "bake", ticket, cx, cz, heights, key } ->   (heights: the chunk's,
 *       or in layer mode its 3x3 neighbourhood's, row by row from (-1, -1))
 *       { ticket, blob } | { ticket, empty: true } | { ticket, error }
 *   { kind: "cancel", ticket }      drop a queued job (no reply)
 *   { kind: "close" }               finish, close the registry, exit
 */

import { parentPort, workerData } from "node:worker_threads";
import type { ChunkDataSource } from "../procgen/chunk-source.js";
import { NavmeshTileRegistry, type NavmeshTileKey } from "../persist/navmesh.js";
import { createNavigationBackend, type BakeTileConfig } from "./backend.js";
import { bakeChunkLayers, bakeChunkTile, isNothingWalkable, TILE_CACHE_SETTINGS } from "./chunk-baker.js";

export interface NavmeshWorkerData {
  registryDir: string;
  chunkWorldSize: number;
  bakeConfig: Omit<BakeTileConfig, "tileX" | "tileZ">;
  /** Bake tile-cache layers instead of whole tiles. */
  layers: boolean;
}

export type NavmeshWorkerRequest =
  | { kind: "bake"; ticket: number; cx: number; cz: number; heights: Float32Array[]; key: NavmeshTileKey }
  | { kind: "cancel"; ticket: number }
  | { kind: "close" };

export type NavmeshWorkerReply =
  | { ticket: number; blob: Uint8Array }
  | { ticket: number; empty: true }
  | { ticket: number; error: string };

if (parentPort) {
  const port = parentPort;
  const data = workerData as NavmeshWorkerData;
  // Bake-only service: the tile bounds come from origin + tile size, which
  // must match the main thread's service (both are chunk-aligned at 0,0).
  const backend = createNavigationBackend({
    originX: 0,
    originZ: 0,
    tileWorldSize: data.chunkWorldSize,
    profiles: [{ id: 0, agentHeight: data.bakeConfig.agentHeight, agentRadius: data.bakeConfig.agentRadius, agentMaxClimb: data.bakeConfig.agentMaxClimb }],
    tileCache: data.layers
      ? {
          ...TILE_CACHE_SETTINGS,
          cellSize: data.bakeConfig.cellSize,
          cellHeight: data.bakeConfig.cellHeight,
          agentHeight: data.bakeConfig.agentHeight,
          agentRadius: data.bakeConfig.agentRadius,
          agentMaxClimb: data.bakeConfig.agentMaxClimb,
        }
      : undefined,
  });
  const registry = new NavmeshTileRegistry({ dir: data.registryDir });
  const queue: Array<Extract<NavmeshWorkerRequest, { kind: "bake" }>> = [];
  const cancelled = new Set<number>();
  let draining = false;
  let closing = false;

  const shutdown = (): void => {
    registry.close();
    backend.destroy();
    port.close();
  };

  const runOne = (): void => {
    const job = queue.shift();
    if (job && !cancelled.delete(job.ticket)) {
      const heights = job.heights;
      // The chunk's heights, or its neighbourhood's (3x3, row by row from (-1, -1)).
      const source: ChunkDataSource = {
        chunkSamples: heights[0].length,
        generateChunk: (_s, x, z, _l, out) => out.set(heights.length === 1 ? heights[0] : heights[(z - job.cz + 1) * 3 + (x - job.cx + 1)]),
      };
      let reply: NavmeshWorkerReply;
      try {
        const options = { backend, source, seed: 0n, chunkWorldSize: data.chunkWorldSize, bakeConfig: data.bakeConfig };
        const { blob } = data.layers ? bakeChunkLayers(options, job.cx, job.cz) : bakeChunkTile(options, job.cx, job.cz);
        registry.register(job.key, blob);
        reply = { ticket: job.ticket, blob };
      } catch (err) {
        reply = isNothingWalkable(err) ? { ticket: job.ticket, empty: true } : { ticket: job.ticket, error: (err as Error).message };
      }
      port.postMessage(reply);
    }
    if (queue.length > 0) {
      setImmediate(runOne);
    } else {
      draining = false;
      cancelled.clear(); // every cancelled ticket was for a job already run or dropped
      if (closing) shutdown();
    }
  };

  port.on("message", (msg: NavmeshWorkerRequest) => {
    if (msg.kind === "bake") {
      queue.push(msg);
      if (!draining) {
        draining = true;
        setImmediate(runOne);
      }
    } else if (msg.kind === "cancel") {
      cancelled.add(msg.ticket);
    } else if (msg.kind === "close") {
      closing = true;
      queue.length = 0;
      if (!draining) shutdown();
    }
  });
}
