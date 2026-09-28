/**
 * ChunkStreamer — the live world holds only the chunks near players.
 *
 * It runs as the first system of every tick:
 *  - every `planEveryTicks` it works out the wanted chunks — within
 *    `loadRadius` of any player, plus the pinned spawn area, inside the
 *    world bounds — and queues the missing ones, nearest first. Loaded
 *    chunks farther than `unloadRadius` from every player for
 *    `unloadDelayTicks` are unloaded (the gap between the two radii and
 *    the delay stop a player on a chunk border from thrashing loads);
 *  - every tick it loads queued chunks until `loadBudgetMs` is spent.
 *
 * Load: the chunk entity (terrain reaches clients through it), then the
 * chunk's contents — spawned back from its ChunkEntityStore row when it
 * has been unloaded before, otherwise populated fresh (scatter). A chunk
 * is populated once, ever: every unload writes a row, even an empty one.
 * Unload: the non-player entities standing in the chunk are written to
 * its row (one transaction per pass, before anything is despawned), then
 * despawned with the chunk entity. Physics bodies follow on their own
 * (PhysicsSystem diffs its membership); terrain colliders and navmesh
 * tiles follow through the optional `colliders` and `navmesh` hooks.
 *
 * Players (PlayerIntent) are never unloaded. Entities standing outside
 * every loaded chunk (movers that wandered off) stay live until the chunk
 * they stand in loads and unloads again.
 *
 * Restarts: `adopt()` takes over the chunk entities of a restored
 * snapshot — those chunks are loaded, and their rows are ignored until
 * they unload again (see ChunkEntityStore for why that is consistent).
 */

import { defineQuery, Not } from "bitecs";
import * as C from "../components.js";
import { joinU64 } from "../components.js";
import type { ChunkEntityStore, ChunkEntitiesRow } from "../persist/chunk-entities.js";
import { chunkCoordsFor, spawnChunk, type ChunkDataSource } from "../procgen/chunk-source.js";
import { collectEntitiesState, decodeSnapshot, encodeSnapshot, type CollectedState } from "../snapshot.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

/** Inclusive chunk range a streamer may load. */
export interface ChunkBounds {
  minCx: number;
  minCz: number;
  maxCx: number;
  maxCz: number;
}

/** What a chunk holds the first time it loads (scatter). */
export interface ChunkPopulator {
  populate(world: SimWorld, cx: number, cz: number, heights: Float32Array): void;
}

/** Navmesh tiles that follow loaded chunks (see ChunkNavmesh). */
export interface ChunkNavmeshHook {
  load(cx: number, cz: number): unknown;
  unload(cx: number, cz: number): void;
}

/** Static terrain collision that follows loaded chunks (see PhysicsSystem.terrainColliders). */
export interface ChunkColliderHook {
  add(cx: number, cz: number, heights: Float32Array): void;
  remove(cx: number, cz: number): void;
}

export interface ChunkStreamerOptions {
  terrain: ChunkDataSource;
  worldSeed: bigint;
  chunkWorldSize: number;
  /** Where unloaded chunks' entities live. */
  store: ChunkEntityStore;
  /** First-load contents; absent = chunks start empty. */
  populator?: ChunkPopulator;
  navmesh?: ChunkNavmeshHook;
  colliders?: ChunkColliderHook;
  /** Chunks outside never load. Default: unbounded. */
  bounds?: ChunkBounds | null;
  /** Chunks kept loaded whether or not a player is near (the spawn area). */
  pinned?: ReadonlyArray<readonly [number, number]>;
  /** Chebyshev radius, in chunks, loaded around each player. Default 8 (17x17). */
  loadRadius?: number;
  /** Chunks farther than this from every player unload. Default loadRadius + 2. */
  unloadRadius?: number;
  /** Ticks a chunk must stay out of range before it unloads. Default 150 (5 s). */
  unloadDelayTicks?: number;
  /** Replan every N ticks. Default 10. */
  planEveryTicks?: number;
  /** Per-tick time budget for loads, ms (at least one load always runs). Default 6. */
  loadBudgetMs?: number;
  /** Per-tick load cap. Default 32. */
  maxLoadsPerTick?: number;
  /**
   * Stop loading new chunks while the world holds this many live
   * entities: bitECS worlds have a fixed capacity (100,000 by default)
   * and running out would throw mid-tick. Default 90,000.
   */
  entityBudget?: number;
  /** Warnings (navmesh failures). Default console.warn. */
  warn?: (message: string) => void;
}

export interface ChunkStreamerStats {
  loaded: number;
  queued: number;
  /** Chunks loaded / unloaded since start. */
  loads: number;
  unloads: number;
  /** Loads that populated a chunk fresh vs. restored it from its row. */
  populated: number;
  restored: number;
}

// Chunk coords packed into one number: exact for |cx|, |cz| < 2^25.
const OFFSET = 0x2000000;
const SPAN = 0x4000000;
export const packChunk = (cx: number, cz: number): number => (cx + OFFSET) * SPAN + (cz + OFFSET);
export function unpackChunk(key: number): [number, number] {
  const cz = (key % SPAN) - OFFSET;
  return [(key - (cz + OFFSET)) / SPAN - OFFSET, cz];
}

const playerQuery = defineQuery([C.PlayerIntent, C.Transform]);
const propQuery = defineQuery([C.Transform, Not(C.PlayerIntent)]);
const chunkQuery = defineQuery([C.Chunk]);

function emptyState(tick: number): CollectedState {
  return {
    tick, baseTick: 0, transforms: [], velocities: [], intents: [], chunks: [],
    healths: [], bodies: [], assets: [], spawned: [], despawned: [],
  };
}

export class ChunkStreamer implements SimSystem {
  readonly name = "chunk-streamer";
  private readonly loaded = new Map<number, { cx: number; cz: number; eid: number }>();
  /** Loaded chunk -> tick it was first seen out of range. */
  private readonly outOfRangeSince = new Map<number, number>();
  private readonly pinned: Set<number>;
  private queue: number[] = [];
  private queueAt = 0;
  private tick = 0;
  private readonly loadRadius: number;
  private readonly unloadRadius: number;
  private readonly unloadDelayTicks: number;
  private readonly planEveryTicks: number;
  private readonly loadBudgetMs: number;
  private readonly maxLoadsPerTick: number;
  private readonly entityBudget: number;
  private overBudget = false;
  private readonly warn: (message: string) => void;
  private readonly counters = { loads: 0, unloads: 0, populated: 0, restored: 0 };

  constructor(private readonly opts: ChunkStreamerOptions) {
    this.loadRadius = opts.loadRadius ?? 8;
    this.unloadRadius = opts.unloadRadius ?? this.loadRadius + 2;
    this.unloadDelayTicks = opts.unloadDelayTicks ?? 150;
    this.planEveryTicks = opts.planEveryTicks ?? 10;
    this.loadBudgetMs = opts.loadBudgetMs ?? 6;
    this.maxLoadsPerTick = opts.maxLoadsPerTick ?? 32;
    this.entityBudget = opts.entityBudget ?? 90_000;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    for (const [name, v] of [["loadRadius", this.loadRadius], ["unloadRadius", this.unloadRadius], ["unloadDelayTicks", this.unloadDelayTicks]] as const) {
      if (!Number.isInteger(v) || v < 0) throw new RangeError(`chunk streamer: ${name} must be a non-negative integer (got ${v})`);
    }
    if (this.unloadRadius < this.loadRadius) {
      throw new RangeError(`chunk streamer: unloadRadius (${this.unloadRadius}) must be >= loadRadius (${this.loadRadius})`);
    }
    if (!Number.isInteger(this.planEveryTicks) || this.planEveryTicks < 1) {
      throw new RangeError(`chunk streamer: planEveryTicks must be a positive integer (got ${this.planEveryTicks})`);
    }
    this.pinned = new Set(
      (opts.pinned ?? []).filter(([cx, cz]) => this.inBounds(cx, cz)).map(([cx, cz]) => packChunk(cx, cz)),
    );
  }

  get stats(): ChunkStreamerStats {
    return { loaded: this.loaded.size, queued: this.queue.length - this.queueAt, ...this.counters };
  }

  isLoaded(cx: number, cz: number): boolean {
    return this.loaded.has(packChunk(cx, cz));
  }

  /** Loaded chunk coords (tests, debug). */
  loadedChunks(): Array<[number, number]> {
    return [...this.loaded.values()].map((c) => [c.cx, c.cz]);
  }

  /**
   * Take over the chunk entities already in the world (a restored
   * snapshot, a baked spawn area). A second entity for the same chunk (a
   * corrupt save) is despawned. Returns how many chunks were adopted.
   */
  adopt(sim: SimWorld): number {
    let adopted = 0;
    for (const eid of Array.from(chunkQuery(sim.ecs))) {
      const { cx, cz } = chunkCoordsFor(joinU64(C.Chunk.chunkIdHi[eid], C.Chunk.chunkIdLo[eid]));
      const key = packChunk(cx, cz);
      if (this.loaded.has(key)) {
        this.warn(`[stream] duplicate chunk entity for ${cx},${cz} in the world; despawned it`);
        sim.despawn(eid);
        continue;
      }
      this.loaded.set(key, { cx, cz, eid });
      if (this.opts.colliders) {
        const heights = new Float32Array(this.opts.terrain.chunkSamples);
        this.opts.terrain.generateChunk(this.opts.worldSeed, cx, cz, 0, heights);
        this.opts.colliders.add(cx, cz, heights);
      }
      this.loadNavmesh(cx, cz);
      adopted++;
    }
    return adopted;
  }

  /** Load the pinned chunks now, unbudgeted (boot: the spawn area is ready before anyone connects). */
  warm(sim: SimWorld): number {
    let n = 0;
    for (const key of this.pinned) {
      if (!this.loaded.has(key)) {
        this.load(sim, key);
        n++;
      }
    }
    return n;
  }

  step(sim: SimWorld): void {
    this.tick++;
    if ((this.tick - 1) % this.planEveryTicks === 0) this.plan(sim);
    this.loadQueued(sim);
  }

  /**
   * Unload every loaded chunk now (orderly shutdown of a region, tests):
   * all contents go to their rows. Pinned chunks included.
   */
  unloadAll(sim: SimWorld): void {
    this.unload(sim, [...this.loaded.keys()]);
    this.queue = [];
    this.queueAt = 0;
  }

  // ------------------------------------------------------------ planning

  private inBounds(cx: number, cz: number): boolean {
    const b = this.opts.bounds;
    return !b || (cx >= b.minCx && cx <= b.maxCx && cz >= b.minCz && cz <= b.maxCz);
  }

  private plan(sim: SimWorld): void {
    const size = this.opts.chunkWorldSize;
    const wanted = new Map<number, number>(); // chunk -> distance to the nearest player
    for (const key of this.pinned) wanted.set(key, 0);
    const keep = new Set<number>(this.pinned);
    const players = playerQuery(sim.ecs);
    const R = this.loadRadius;
    const U = this.unloadRadius;
    for (let i = 0; i < players.length; i++) {
      const e = players[i];
      const pcx = Math.floor(C.Transform.px[e] / size);
      const pcz = Math.floor(C.Transform.pz[e] / size);
      if (!Number.isFinite(pcx) || !Number.isFinite(pcz)) continue;
      for (let dz = -U; dz <= U; dz++) {
        for (let dx = -U; dx <= U; dx++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          if (!this.inBounds(cx, cz)) continue;
          const key = packChunk(cx, cz);
          keep.add(key);
          const d = Math.max(Math.abs(dx), Math.abs(dz));
          const nearest = wanted.get(key);
          if (d <= R && (nearest === undefined || d < nearest)) wanted.set(key, d);
        }
      }
    }

    // Missing chunks, nearest first (ties by key: deterministic order).
    const missing: Array<[number, number]> = [];
    for (const [key, d] of wanted) if (!this.loaded.has(key)) missing.push([key, d]);
    missing.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    this.queue = missing.map(([key]) => key);
    this.queueAt = 0;

    const expired: number[] = [];
    for (const key of this.loaded.keys()) {
      if (keep.has(key)) {
        this.outOfRangeSince.delete(key);
        continue;
      }
      const since = this.outOfRangeSince.get(key);
      if (since === undefined) this.outOfRangeSince.set(key, this.tick);
      else if (this.tick - since >= this.unloadDelayTicks) expired.push(key);
    }
    if (expired.length > 0) this.unload(sim, expired);
  }

  private loadQueued(sim: SimWorld): void {
    const start = performance.now();
    let n = 0;
    while (this.queueAt < this.queue.length && n < this.maxLoadsPerTick) {
      if (n > 0 && performance.now() - start >= this.loadBudgetMs) break;
      if (sim.liveEntityCount >= this.entityBudget) {
        if (!this.overBudget) {
          this.warn(`[stream] ${sim.liveEntityCount} live entities (budget ${this.entityBudget}): not loading more chunks until some unload`);
          this.overBudget = true;
        }
        return;
      }
      this.overBudget = false;
      const key = this.queue[this.queueAt++];
      if (this.loaded.has(key)) continue;
      this.load(sim, key);
      n++;
    }
  }

  // ------------------------------------------------------------ load / unload

  private load(sim: SimWorld, key: number): void {
    const [cx, cz] = unpackChunk(key);
    const { eid, heights } = spawnChunk(sim, this.opts.terrain, this.opts.worldSeed, cx, cz, 0);
    this.loaded.set(key, { cx, cz, eid });
    this.outOfRangeSince.delete(key);
    // Ground first: bodies restored or scattered below must land on it.
    this.opts.colliders?.add(cx, cz, heights);
    const row = this.opts.store.get(cx, cz);
    if (row) {
      sim.spawnFromState(decodeSnapshot(row.bytes));
      this.counters.restored++;
    } else {
      this.opts.populator?.populate(sim, cx, cz, heights);
      this.counters.populated++;
    }
    this.loadNavmesh(cx, cz);
    this.counters.loads++;
  }

  private loadNavmesh(cx: number, cz: number): void {
    if (!this.opts.navmesh) return;
    try {
      this.opts.navmesh.load(cx, cz);
    } catch (err) {
      // Pathfinding is degraded there, but the world must keep running.
      this.warn(`[stream] navmesh for chunk ${cx},${cz} failed: ${(err as Error).message}`);
    }
  }

  private unload(sim: SimWorld, keys: readonly number[]): void {
    const unloading = new Set(keys);
    const size = this.opts.chunkWorldSize;
    const members = new Map<number, number[]>();
    for (const key of unloading) members.set(key, []);
    const props = propQuery(sim.ecs);
    for (let i = 0; i < props.length; i++) {
      const e = props[i];
      const group = members.get(packChunk(Math.floor(C.Transform.px[e] / size), Math.floor(C.Transform.pz[e] / size)));
      group?.push(e);
    }

    // Every unloading chunk gets a row — an empty one too, so it is never
    // populated a second time. Rows commit before anything is despawned.
    const rows: ChunkEntitiesRow[] = [];
    for (const [key, eids] of members) {
      const [cx, cz] = unpackChunk(key);
      const state = eids.length > 0 ? collectEntitiesState(sim, eids, this.tick) : emptyState(this.tick);
      // Copy: encodeSnapshot may return a view into a reused builder.
      rows.push({ cx, cz, tick: this.tick, bytes: encodeSnapshot(state).slice() });
    }
    this.opts.store.putMany(rows);

    for (const [key, eids] of members) {
      for (const e of eids) sim.despawn(e);
      const chunk = this.loaded.get(key);
      if (chunk) {
        sim.despawn(chunk.eid);
        this.opts.colliders?.remove(chunk.cx, chunk.cz);
        this.opts.navmesh?.unload(chunk.cx, chunk.cz);
      }
      this.loaded.delete(key);
      this.outOfRangeSince.delete(key);
      this.counters.unloads++;
    }
  }
}
