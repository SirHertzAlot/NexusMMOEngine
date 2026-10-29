/**
 * ChunkNavmesh — navmesh tiles that follow the loaded chunks (streaming).
 *
 * load(cx, cz) puts the chunk's tile into the navigation backend: from the
 * registry when cached (keyed to the chunk's exact heights, so a sculpted
 * chunk re-bakes and an untouched one reuses its tile), else baked and
 * registered. unload(cx, cz) takes it out again. A chunk with no walkable
 * surface — a cliff steeper than the agent's slope limit — has no tile;
 * that is remembered per heights fingerprint instead of re-baked.
 *
 * Baking a new tile costs 5-40 ms (Recast plus a file write). With
 * `worker: true` it happens on a worker thread and the tile arrives a few
 * ticks later; pathfinding there waits for it. Every bake carries a
 * ticket, and only the current ticket of a still-loaded chunk may install
 * its result — a chunk that unloaded (or unloaded and loaded again) while
 * its bake ran never gets a stale tile. Without the worker (tests, tools),
 * bakes run inline.
 *
 * With a tile cache (the backend was made with one), tiles are baked to
 * heightfield layers from the chunk and its eight neighbours (so edges
 * aren't eroded where the ground carries on), and the cache builds the
 * navmesh tiles from the layers plus the obstacles standing on them
 * (navigation/obstacle-system.ts). `onLoaded` hears when a chunk's tile
 * goes in, so obstacles added before it can be applied to it.
 */

import { Worker } from "node:worker_threads";
import type { ChunkDataSource } from "../procgen/chunk-source.js";
import { heightsFingerprint } from "../procgen/chunk-source.js";
import type { NavmeshTileKey, NavmeshTileRegistry } from "../persist/navmesh.js";
import type { BakeTileConfig, NavigationBackend } from "./backend.js";
import { stdioWarn } from "../logging/index.js";
import {
  bakeChunkLayers,
  bakeChunkTile,
  bakeConfigHash,
  DEFAULT_BAKE_CONFIG,
  isNothingWalkable,
  LAYERS_FORMAT,
  TILE_CACHE_SETTINGS,
} from "./chunk-baker.js";
import type { NavmeshWorkerData, NavmeshWorkerReply, NavmeshWorkerRequest } from "./navmesh-worker.js";

export interface ChunkNavmeshOptions {
  backend: NavigationBackend;
  registry: NavmeshTileRegistry;
  /** Directory of `registry` (the worker opens its own connection). Required with `worker`. */
  registryDir?: string;
  /** The same terrain source the world streams. */
  source: ChunkDataSource;
  seed: bigint;
  chunkWorldSize: number;
  bakeConfig?: Partial<Omit<BakeTileConfig, "tileX" | "tileZ">>;
  /** Agent profile id the tiles are baked for. Default 0. */
  agentProfile?: number;
  /** Bake new tiles on a worker thread. Default false (inline). */
  worker?: boolean;
  warn?: (message: string) => void;
  /** A chunk's tile went into the navmesh (tile-cache mode: obstacles can reach it now). */
  onLoaded?: (cx: number, cz: number) => void;
}

/** What a load did. "pending": a worker is baking the tile. */
export type ChunkNavmeshLoad = "cached" | "baked" | "pending" | "empty" | "already-loaded";

export class ChunkNavmesh {
  private readonly loaded = new Map<string, BigUint64Array>();
  /** Chunk -> ticket of its bake in flight. */
  private readonly pending = new Map<string, number>();
  /** Ticket -> chunk and the heights fingerprint it was baked from. */
  private readonly tickets = new Map<number, { id: string; fingerprint: number }>();
  /** Chunk -> heights fingerprint known to have no walkable surface. */
  private readonly empty = new Map<string, number>();
  private readonly config: Omit<BakeTileConfig, "tileX" | "tileZ">;
  private readonly scratch: Float32Array;
  private readonly warn: (message: string) => void;
  private worker: Worker | null = null;
  private nextTicket = 0;
  private idleWaiters: Array<() => void> = [];
  polys = 0;

  /** Tile-cache mode: layers, not whole tiles. */
  private readonly layers: boolean;

  constructor(private readonly opts: ChunkNavmeshOptions) {
    this.layers = opts.backend.tileCache !== undefined;
    this.config = this.layers
      ? { ...DEFAULT_BAKE_CONFIG, cellSize: TILE_CACHE_SETTINGS.cellSize, ...opts.bakeConfig }
      : { ...DEFAULT_BAKE_CONFIG, ...opts.bakeConfig };
    this.scratch = new Float32Array(opts.source.chunkSamples);
    this.warn = opts.warn ?? stdioWarn;
    if (opts.worker) {
      if (!opts.registryDir) throw new Error("ChunkNavmesh: `registryDir` is required with `worker`");
      this.startWorker(opts.registryDir);
    }
  }

  load(cx: number, cz: number): ChunkNavmeshLoad {
    const id = `${cx},${cz}`;
    if (this.loaded.has(id) || this.pending.has(id)) return "already-loaded";
    const { registry, source, seed } = this.opts;
    // A layer tile also depends on its neighbours' edges: all nine heightmaps.
    const around: Float32Array[] = [];
    let fingerprint: number;
    if (this.layers) {
      fingerprint = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const h = new Float32Array(source.chunkSamples);
          source.generateChunk(seed, cx + dx, cz + dz, 0, h);
          around.push(h);
          fingerprint = (Math.imul(fingerprint, 31) + heightsFingerprint(h)) | 0;
        }
      }
    } else {
      source.generateChunk(seed, cx, cz, 0, this.scratch);
      fingerprint = heightsFingerprint(this.scratch);
    }
    if (this.empty.get(id) === fingerprint) return "empty";
    const configHash = bakeConfigHash({ ...this.config, tileX: cx, tileZ: cz });
    const key: NavmeshTileKey = {
      worldSeed: seed.toString(),
      chunkX: cx,
      chunkZ: cz,
      terrainVersion: fingerprint,
      agentProfile: this.opts.agentProfile ?? 0,
      bakeConfigHash: this.layers ? `${configHash}:${LAYERS_FORMAT}` : configHash,
    };
    const record = registry.lookup(key);
    const cached = record ? registry.loadBlob(record) : undefined;
    if (cached) {
      this.install(id, cached);
      return "cached";
    }
    if (this.worker) {
      const ticket = ++this.nextTicket;
      this.pending.set(id, ticket);
      this.tickets.set(ticket, { id, fingerprint });
      const heights = this.layers ? around : [this.scratch.slice()];
      const request: NavmeshWorkerRequest = { kind: "bake", ticket, cx, cz, heights, key };
      this.worker.postMessage(request, heights.map((h) => h.buffer as ArrayBuffer));
      return "pending";
    }
    return this.bakeInline(id, cx, cz, key, fingerprint);
  }

  unload(cx: number, cz: number): void {
    const id = `${cx},${cz}`;
    const refs = this.loaded.get(id);
    if (refs) {
      if (this.layers) this.opts.backend.tileCache!.unloadLayers(refs);
      else this.opts.backend.unloadTiles(refs);
      this.loaded.delete(id);
    }
    const ticket = this.pending.get(id);
    if (ticket !== undefined) {
      this.pending.delete(id);
      this.tickets.delete(ticket);
      this.worker?.postMessage({ kind: "cancel", ticket } satisfies NavmeshWorkerRequest);
      this.settleIfIdle();
    }
  }

  /** Tiles currently in the backend. */
  get size(): number {
    return this.loaded.size;
  }

  /** Bakes in flight on the worker. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Resolves once no bake is in flight (tests, orderly shutdown). */
  whenIdle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** World-space bounds [x0, z0, x1, z1] of the loaded tiles (editor debug overlay). */
  bounds(): Array<[number, number, number, number]> {
    const s = this.opts.chunkWorldSize;
    return [...this.loaded.keys()].map((id) => {
      const [cx, cz] = id.split(",").map(Number);
      return [cx * s, cz * s, (cx + 1) * s, (cz + 1) * s];
    });
  }

  /** Stop the worker (pending bakes are dropped). */
  close(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.postMessage({ kind: "close" } satisfies NavmeshWorkerRequest);
    this.pending.clear();
    this.tickets.clear();
    this.settleIfIdle();
  }

  // ------------------------------------------------------------ internals

  private install(id: string, blob: Uint8Array): void {
    const [cx, cz] = id.split(",").map(Number);
    this.loaded.set(id, this.layers ? this.opts.backend.tileCache!.loadLayers(cx, cz, blob) : this.opts.backend.loadTiles([blob]));
    this.opts.onLoaded?.(cx, cz);
  }

  /** Whether chunk (cx, cz)'s tile is in the navmesh. */
  isLoaded(cx: number, cz: number): boolean {
    return this.loaded.has(`${cx},${cz}`);
  }

  private bakeInline(id: string, cx: number, cz: number, key: NavmeshTileKey, fingerprint: number): ChunkNavmeshLoad {
    const { backend, source, seed, chunkWorldSize, registry } = this.opts;
    let blob: Uint8Array;
    try {
      if (this.layers) {
        blob = bakeChunkLayers({ backend, source, seed, chunkWorldSize, bakeConfig: this.config }, cx, cz).blob;
      } else {
        const baked = bakeChunkTile({ backend, source, seed, chunkWorldSize, bakeConfig: this.config }, cx, cz);
        blob = baked.blob;
        this.polys += baked.stats.polyCount;
      }
    } catch (err) {
      if (!isNothingWalkable(err)) throw err;
      this.empty.set(id, fingerprint);
      return "empty";
    }
    registry.register(key, blob);
    this.install(id, blob);
    return "baked";
  }

  private startWorker(registryDir: string): void {
    const workerData: NavmeshWorkerData = {
      registryDir,
      chunkWorldSize: this.opts.chunkWorldSize,
      bakeConfig: this.config,
      layers: this.layers,
    };
    const worker = new Worker(new URL("./navmesh-worker.js", import.meta.url), { workerData });
    worker.on("message", (reply: NavmeshWorkerReply) => this.onReply(reply));
    const fail = (reason: string): void => {
      if (this.worker !== worker) return; // closed deliberately
      this.warn(`[navmesh] bake worker ${reason}; baking inline from now on`);
      this.worker = null;
      // The chunks still waiting are loaded: bake them here instead.
      const waiting = [...this.pending.keys()];
      this.pending.clear();
      this.tickets.clear();
      for (const id of waiting) {
        const [cx, cz] = id.split(",").map(Number);
        try {
          this.load(cx, cz);
        } catch (err) {
          this.warn(`[navmesh] chunk ${id}: ${(err as Error).message}`);
        }
      }
      this.settleIfIdle();
    };
    worker.on("error", (err) => fail(`crashed: ${(err as Error).message}`));
    worker.on("exit", (code) => fail(`exited (code ${code})`));
    // Never keep the process alive for bakes. unref() must come AFTER the
    // listeners: attaching a "message" listener re-refs the worker.
    worker.unref();
    this.worker = worker;
  }

  private onReply(reply: NavmeshWorkerReply): void {
    const job = this.tickets.get(reply.ticket);
    if (!job) return; // the chunk unloaded meanwhile (its tile is cached for next time)
    this.tickets.delete(reply.ticket);
    if (this.pending.get(job.id) !== reply.ticket) return;
    this.pending.delete(job.id);
    if ("blob" in reply) {
      this.install(job.id, reply.blob);
    } else if ("empty" in reply) {
      this.empty.set(job.id, job.fingerprint);
    } else {
      this.warn(`[navmesh] chunk ${job.id}: ${reply.error}`);
    }
    this.settleIfIdle();
  }

  private settleIfIdle(): void {
    if (this.pending.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
