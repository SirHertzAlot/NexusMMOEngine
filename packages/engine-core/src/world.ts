/**
 * SimWorld — the authoritative ECS world (slice 1.2).
 *
 * Owns the bitECS world and the identity mapping between bitECS slot ids
 * and wire ids:
 * - bitECS eid = slot index (recycled by bitECS).
 * - wire id   = (generation << 32) | slot  (see ./entity-id.ts, DRY).
 *   The generation bumps every time a slot is reused, so a client can
 *   never confuse a new entity for a despawned one (ABA guard).
 *
 * Slot reuse: bitECS only recycles removed eids once its removed-pool
 * exceeds 1% of world size by default. A long-lived authoritative server
 * wants a bounded eid space, so the constructor sets the recycle
 * threshold to 0 (eager reuse). This is process-global bitECS config —
 * safe because the server runs exactly one world per process.
 *
 * Per-tick change lists (spawned/despawned wire ids) accumulate between
 * delta builds: anything spawned/despawned after the previous tick's
 * delta is captured by the next one. Call endTick() after the delta is
 * built and the tracker committed.
 *
 * EDA: intent events flow in through queueIntent() and are drained into
 * PlayerIntent components at the start of each tick (beginTick). The
 * world also emits spawned/despawned/tick events for downstream
 * consumers (the slice-1.3 gateway subscribes to these).
 *
 * Multiplayer-ready by construction: player entities are just entities
 * carrying PlayerIntent. Nothing here assumes a single player.
 */

import {
  addComponent,
  addEntity,
  createWorld,
  entityExists,
  hasComponent,
  removeEntity,
  setRemovedRecycleThreshold,
  type IWorld,
} from "bitecs";
import * as bitECS from "bitecs";
import * as C from "./components.js";
import { splitU64 } from "./components.js";
import { makeWireEntityId, parseWireEntityId } from "./entity-id.js";
import type { CollectedState } from "./snapshot.js";

export interface QueuedIntent {
  mx: number;
  my: number;
  mz: number;
  lookYaw: number;
  lookPitch: number;
  jump: boolean;
  buttons: number;
}

export type SimEventName = "spawned" | "despawned" | "tick";
export type SimEventPayload = bigint | number; // wire id for spawn/despawn, tick index for tick
export type SimEventHandler = (payload: SimEventPayload) => void;

/** Minimal typed event emitter — push channel for sim state changes. */
export class SimEventEmitter {
  private handlers = new Map<SimEventName, SimEventHandler[]>();

  on(name: SimEventName, fn: SimEventHandler): void {
    const list = this.handlers.get(name);
    if (list) list.push(fn);
    else this.handlers.set(name, [fn]);
  }

  emit(name: SimEventName, payload: SimEventPayload): void {
    const list = this.handlers.get(name);
    if (!list) return;
    for (const fn of list) fn(payload);
  }
}

/**
 * Attach every component in `state` and write its rows into the SoA
 * stores; `eidOf` maps a row's wire id to the local entity.
 */
function writeComponentRows(
  ecs: IWorld,
  state: CollectedState,
  eidOf: (wireId: bigint) => number,
  lookId: (json: string) => number,
): void {
  const T = C.Transform;
  for (const r of state.transforms) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, T, eid);
    T.px[eid] = r.px; T.py[eid] = r.py; T.pz[eid] = r.pz;
    T.qx[eid] = r.qx; T.qy[eid] = r.qy; T.qz[eid] = r.qz; T.qw[eid] = r.qw;
    T.sx[eid] = r.sx; T.sy[eid] = r.sy; T.sz[eid] = r.sz;
  }
  const V = C.Velocity;
  for (const r of state.velocities) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, V, eid);
    V.lx[eid] = r.lx; V.ly[eid] = r.ly; V.lz[eid] = r.lz;
    V.ax[eid] = r.ax; V.ay[eid] = r.ay; V.az[eid] = r.az;
  }
  const I = C.PlayerIntent;
  for (const r of state.intents) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, I, eid);
    I.mx[eid] = r.mx; I.my[eid] = r.my; I.mz[eid] = r.mz;
    I.lookYaw[eid] = r.lookYaw; I.lookPitch[eid] = r.lookPitch;
    I.jump[eid] = r.jump ? 1 : 0; I.buttons[eid] = r.buttons;
  }
  const Ch = C.Chunk;
  for (const r of state.chunks) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, Ch, eid);
    const id = splitU64(r.chunkId);
    const seed = splitU64(r.seed);
    Ch.chunkIdHi[eid] = id.hi; Ch.chunkIdLo[eid] = id.lo;
    Ch.seedHi[eid] = seed.hi; Ch.seedLo[eid] = seed.lo;
    Ch.lod[eid] = r.lod;
  }
  const H = C.Health;
  for (const r of state.healths) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, H, eid);
    H.current[eid] = r.current;
    H.max[eid] = r.max;
  }
  const Bc = C.BodyConfig;
  for (const r of state.bodies) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, Bc, eid);
    Bc.shapeKind[eid] = r.shapeKind;
    Bc.halfX[eid] = r.halfX; Bc.halfY[eid] = r.halfY; Bc.halfZ[eid] = r.halfZ;
    Bc.radius[eid] = r.radius;
    Bc.mass[eid] = r.mass;
    Bc.motionType[eid] = r.motionType;
    Bc.layer[eid] = r.layer;
    Bc.friction[eid] = r.friction;
    Bc.restitution[eid] = r.restitution;
  }
  const Ar = C.AssetRef;
  for (const r of state.assets) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, Ar, eid);
    Ar.assetHash[eid] = r.assetHash;
    Ar.variant[eid] = r.variant;
  }
  const Lo = C.Locomotion;
  for (const r of state.locomotions) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, Lo, eid);
    Lo.mode[eid] = r.mode;
    Lo.abilities[eid] = r.abilities;
    Lo.breath[eid] = r.breath;
  }
  const Ap = C.Appearance;
  for (const r of state.appearances) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, Ap, eid);
    Ap.look[eid] = lookId(r.look);
  }
  const Ac = C.Action;
  for (const r of state.actions) {
    const eid = eidOf(r.wireId);
    addComponent(ecs, Ac, eid);
    Ac.move[eid] = r.move;
    Ac.started[eid] = r.started;
    Ac.seq[eid] = r.seq;
    Ac.yaw[eid] = r.yaw;
  }
}

export class SimWorld {
  /** The raw bitECS world — systems query and read/write components here. */
  readonly ecs: IWorld;
  readonly events = new SimEventEmitter();

  private generations = new Map<number, number>();
  private freed = new Set<number>();
  private spawned: bigint[] = [];
  private despawned: bigint[] = [];
  private intentQueue = new Map<number, QueuedIntent>();
  private maxSlot = -1;
  private liveCount = 0;
  /** The tick being simulated (beginTick sets it): systems stamp events with it. */
  currentTick = 0;
  /** Look table for the Appearance component: id -> canonical look JSON (0 = none). */
  private readonly looks: string[] = [""];
  private readonly lookIds = new Map<string, number>([["", 0]]);

  constructor() {
    // Eager slot reuse: bounded eid space for a long-lived server.
    // Identity across reuse is preserved by the generation counter.
    setRemovedRecycleThreshold(0);
    this.ecs = createWorld();
  }

  /**
   * TEST-ONLY: reset the process-global bitECS entity cursor.
   *
   * Production runs one SimWorld per process, so bitECS globals are
   * always fresh and restoreFromState's dense-eid assumption holds.
   * Tests that build a source world AND a restored world in the same
   * process must call this after capturing the source state and before
   * creating the restored world. NEVER call with a live world — it
   * invalidates every existing eid.
   */
  static resetEntityCursorForTesting(): void {
    (bitECS as unknown as { resetGlobals(): void }).resetGlobals();
  }

  /** Highest slot index ever issued — bounds DeltaTracker copies. */
  get maxSlotSeen(): number {
    return this.maxSlot;
  }

  /** Number of currently-live entities (O(1), maintained on spawn/despawn). */
  get liveEntityCount(): number {
    return this.liveCount;
  }

  /** Wire id for a live slot. */
  wireId(eid: number): bigint {
    return makeWireEntityId(this.generations.get(eid) ?? 0, eid);
  }

  /**
   * Resolve a wire entity id to its live slot, or -1 when the id is
   * stale (generation mismatch), despawned, or never existed.
   * Read-only helper for editor/debug tooling that answers queries by
   * wire id without touching component state.
   */
  resolveWireId(wireId: bigint): number {
    const { slot, generation } = parseWireEntityId(wireId);
    if (this.freed.has(slot)) return -1;
    const gen = this.generations.get(slot);
    if (gen === undefined || gen !== generation) return -1;
    return slot;
  }

  /**
   * Spawn a bare entity. The caller adds components with
   * addComponent(sim.ecs, C.Some, eid) and writes initial data into the
   * SoA stores directly (DOD). The wire id is recorded in this tick's
   * spawned list and emitted.
   */
  spawn(): number {
    const eid = addEntity(this.ecs);
    if (eid > this.maxSlot) this.maxSlot = eid;
    let gen = this.generations.get(eid) ?? 0;
    if (this.freed.has(eid)) {
      gen += 1; // slot reuse: bump the generation (ABA guard)
      this.freed.delete(eid);
    }
    this.generations.set(eid, gen);
    const wid = makeWireEntityId(gen, eid);
    this.spawned.push(wid);
    this.events.emit("spawned", wid);
    this.liveCount++;
    return eid;
  }

  /**
   * Despawn an entity. Its wire id is recorded in this tick's despawned
   * list and emitted. Despawning an already-dead entity is a no-op.
   */
  despawn(eid: number): void {
    if (!entityExists(this.ecs, eid)) return;
    const wid = this.wireId(eid);
    this.despawned.push(wid);
    this.events.emit("despawned", wid);
    removeEntity(this.ecs, eid);
    this.freed.add(eid);
    this.liveCount--;
  }

  /** Wire ids spawned since the last endTick(). */
  spawnedWireIds(): readonly bigint[] {
    return this.spawned;
  }

  /** Wire ids despawned since the last endTick(). */
  despawnedWireIds(): readonly bigint[] {
    return this.despawned;
  }

  /**
   * Export the per-slot generation counters as a dense u32 array
   * (slice 1.4 persistence). Index = slot; unset slots read 0.
   * Includes freed slots so a later save/load round-trip resumes
   * generation bumps exactly where they left off.
   */
  exportGenerations(): Uint32Array {
    const out = new Uint32Array(this.maxSlot + 1);
    for (const [slot, gen] of this.generations) out[slot] = gen;
    return out;
  }

  /**
   * Restore this world from a decoded snapshot plus its per-slot
   * generation table (slice 1.4 persistence). Only valid on a FRESH
   * world (nothing spawned yet).
   *
   * Identity: bitECS issues eids densely from 0 on a fresh world, so
   * adopting slots 0..maxSlot in ascending order reproduces the saved
   * slot layout exactly; the eid !== slot assertion guards that
   * assumption loudly instead of silently corrupting identity.
   * Gap slots (freed before the save) are re-created and immediately
   * removed so the slot space stays dense, and their generations come
   * from the saved table so a later reuse bumps correctly.
   *
   * No spawn/despawn events fire and the change lists stay empty: the
   * restore IS the baseline for the next tick, not a change to it.
   */
  restoreFromState(state: CollectedState, generations: Map<number, number>): void {
    if (this.maxSlot !== -1) {
      throw new Error("restoreFromState: world is not fresh");
    }

    // Slot -> generation, collected from every component block. A wire
    // id appears in several blocks; conflicting generations mean a
    // corrupt snapshot, so fail loudly.
    const wanted = new Map<number, number>();
    const take = (wireId: bigint): void => {
      const { slot, generation } = parseWireEntityId(wireId);
      const prev = wanted.get(slot);
      if (prev !== undefined && prev !== generation) {
        throw new Error(
          `restoreFromState: conflicting generations for slot ${slot}`,
        );
      }
      wanted.set(slot, generation);
    };
    for (const r of state.transforms) take(r.wireId);
    for (const r of state.velocities) take(r.wireId);
    for (const r of state.intents) take(r.wireId);
    for (const r of state.chunks) take(r.wireId);
    for (const r of state.healths) take(r.wireId);
    for (const r of state.bodies) take(r.wireId);
    for (const r of state.assets) take(r.wireId);
    for (const r of state.locomotions) take(r.wireId);
    for (const r of state.appearances) take(r.wireId);
    for (const r of state.actions) take(r.wireId);

    let maxSlot = -1;
    for (const slot of wanted.keys()) if (slot > maxSlot) maxSlot = slot;

    // Phase 1: allocate 0..maxSlot densely (fresh world => sequential eids).
    for (let s = 0; s <= maxSlot; s++) {
      const eid = addEntity(this.ecs);
      if (eid !== s) {
        throw new Error(`restoreFromState: non-dense eid (want ${s}, got ${eid})`);
      }
    }
    this.maxSlot = maxSlot;

    // Phase 2: free the gap slots; adopt the saved generations for live
    // slots and the saved table for freed ones.
    for (let s = 0; s <= maxSlot; s++) {
      const gen = wanted.get(s);
      if (gen === undefined) {
        removeEntity(this.ecs, s);
        this.freed.add(s);
        this.generations.set(s, generations.get(s) ?? 0);
      } else {
        this.generations.set(s, gen);
      }
    }
    this.liveCount = wanted.size;

    // Phase 3: attach components and write the row data into the SoA stores.
    writeComponentRows(this.ecs, state, (wireId) => parseWireEntityId(wireId).slot, (json) => this.lookId(json));
  }

  /**
   * Spawn fresh entities from stored rows (an unloaded chunk's contents,
   * see ChunkEntityStore): one new entity per distinct wire id, created in
   * ascending wire-id order, with every component row written. The stored
   * wire ids are only row keys — the entities get new slots and ids, like
   * any spawn, and appear in this tick's spawned list. Returns the eids.
   */
  spawnFromState(state: CollectedState): number[] {
    const ids = new Set<bigint>();
    for (const block of [state.transforms, state.velocities, state.intents, state.chunks, state.healths, state.bodies, state.assets, state.locomotions, state.appearances, state.actions]) {
      for (const r of block) ids.add(r.wireId);
    }
    const eids = new Map<bigint, number>();
    for (const wireId of [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) eids.set(wireId, this.spawn());
    writeComponentRows(this.ecs, state, (wireId) => eids.get(wireId)!, (json) => this.lookId(json));
    return [...eids.values()];
  }

  /**
   * The look table id of a look (canonical JSON), added on first use.
   * Looks are few (one per distinct character), so the table only grows.
   */
  lookId(json: string): number {
    let id = this.lookIds.get(json);
    if (id === undefined) {
      id = this.looks.length;
      this.looks.push(json);
      this.lookIds.set(json, id);
    }
    return id;
  }

  /** A look table entry's JSON ("" for none or an unknown id). */
  lookJson(id: number): string {
    return this.looks[id] ?? "";
  }

  /** Give an entity an Appearance with this look (canonical JSON). */
  setLook(eid: number, json: string): void {
    addComponent(this.ecs, C.Appearance, eid);
    C.Appearance.look[eid] = this.lookId(json);
  }

  /**
   * Queue a player-intent event (EDA). Drained into PlayerIntent
   * components by beginTick(); intents for dead entities or entities
   * without PlayerIntent are dropped.
   */
  queueIntent(eid: number, intent: QueuedIntent): void {
    this.intentQueue.set(eid, intent);
  }

  /**
   * Start-of-tick: record the tick (the next one when not given) and drain
   * queued intent events into components.
   */
  beginTick(tick?: number): void {
    this.currentTick = tick ?? this.currentTick + 1;
    if (this.intentQueue.size === 0) return;
    for (const [eid, intent] of this.intentQueue) {
      if (entityExists(this.ecs, eid) && hasComponent(this.ecs, C.PlayerIntent, eid)) {
        C.PlayerIntent.mx[eid] = intent.mx;
        C.PlayerIntent.my[eid] = intent.my;
        C.PlayerIntent.mz[eid] = intent.mz;
        C.PlayerIntent.lookYaw[eid] = intent.lookYaw;
        C.PlayerIntent.lookPitch[eid] = intent.lookPitch;
        C.PlayerIntent.jump[eid] = intent.jump ? 1 : 0;
        C.PlayerIntent.buttons[eid] = intent.buttons;
      }
    }
    this.intentQueue.clear();
  }

  /**
   * End-of-tick: clear the change lists. Call after the tick's delta is
   * built and the DeltaTracker committed.
   */
  endTick(): void {
    this.spawned.length = 0;
    this.despawned.length = 0;
  }

  /** Emit the tick event for downstream consumers (gateway, metrics). */
  emitTick(tick: number): void {
    this.events.emit("tick", tick);
  }

  /** Convenience: add a component to an entity (re-export for callers). */
  addComponentTo(eid: number, component: Parameters<typeof addComponent>[1]): void {
    addComponent(this.ecs, component, eid);
  }
}
