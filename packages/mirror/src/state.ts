/**
 * MirrorState — the client-side world view (skill operating rule 1: the
 * browser holds no game logic, it only mirrors).
 *
 * Applies welcome Snapshots (full replace) and per-tick Deltas (fold)
 * decoded by @mmo-engine/protocol's codec. Deltas carry only changed
 * rows; rows are upserted, despawned ids are dropped. No per-tick
 * allocation beyond the rows the delta itself carries (DOD).
 */

import type {
  ActionRow,
  AnimationRow,
  AppearanceRow,
  AssetRefRow,
  BodyConfigRow,
  ChunkRow,
  CollectedState,
  HealthRow,
  CharacterRefRow,
  IntentRow,
  LocomotionRow,
  StaminaRow,
  TransformRow,
  VelocityRow,
  VfxEmitterRow,
} from "@mmo-engine/protocol";

export interface EntityMirror {
  wireId: bigint;
  transform?: TransformRow;
  velocity?: VelocityRow;
  intent?: IntentRow;
  chunk?: ChunkRow;
  health?: HealthRow;
  stamina?: StaminaRow;
  characterRef?: CharacterRefRow;
  animation?: AnimationRow;
  vfxEmitter?: VfxEmitterRow;
  body?: BodyConfigRow;
  asset?: AssetRefRow;
  locomotion?: LocomotionRow;
  appearance?: AppearanceRow;
  action?: ActionRow;
}

function upsert<K extends keyof Omit<EntityMirror, "wireId">>(
  state: Map<bigint, EntityMirror>,
  wid: bigint,
  key: K,
  row: EntityMirror[K],
): void {
  let e = state.get(wid);
  if (!e) {
    e = { wireId: wid };
    state.set(wid, e);
  }
  e[key] = row;
}

/** What a DeltaSet did beyond upserting rows (applyDeltaSet). */
export interface DeltaSetResult {
  /** Entities gone from the world (died, picked up, unloaded). */
  despawned: bigint[];
  /** Entities gone from this client's view only (their sector left its interest). */
  left: bigint[];
  /** Entities new to this client that already existed (came into view, not spawned). */
  entered: bigint[];
  /** Every transform row the set carried, for one interpolator push. */
  transforms: TransformRow[];
}

export class MirrorState {
  readonly entities = new Map<bigint, EntityMirror>();
  /** wireId -> the DeltaSet sector its rows last arrived in (interest management). */
  readonly home = new Map<bigint, string>();
  /** Came into view rather than spawned; the renderer takes them out (`delete`) to skip the spawn effect. */
  readonly entered = new Set<bigint>();
  /** Last authoritative tick applied (snapshot or delta). */
  lastTick = 0;

  get entityCount(): number {
    return this.entities.size;
  }

  /** Full replace from a welcome/periodic Snapshot. */
  applySnapshot(s: CollectedState): void {
    this.entities.clear();
    this.home.clear();
    this.entered.clear();
    this.applyDelta(s);
  }

  /** Fold a per-tick Delta onto the current state, in place. */
  applyDelta(d: CollectedState): void {
    for (const wid of d.despawned) {
      this.entities.delete(wid);
      this.home.delete(wid);
    }
    // spawned[] needs no action: spawned entities always arrive fully
    // in the component blocks (server contract, MESSAGE-CATALOG.md).
    for (const r of d.transforms) upsert(this.entities, r.wireId, "transform", r);
    for (const r of d.velocities) upsert(this.entities, r.wireId, "velocity", r);
    for (const r of d.intents) upsert(this.entities, r.wireId, "intent", r);
    for (const r of d.chunks) upsert(this.entities, r.wireId, "chunk", r);
    for (const r of d.healths) upsert(this.entities, r.wireId, "health", r);
    for (const r of d.staminas) upsert(this.entities, r.wireId, "stamina", r);
    for (const r of d.characterRefs) upsert(this.entities, r.wireId, "characterRef", r);
    for (const r of d.animations) upsert(this.entities, r.wireId, "animation", r);
    for (const r of d.vfxEmitters) upsert(this.entities, r.wireId, "vfxEmitter", r);
    for (const r of d.bodies) upsert(this.entities, r.wireId, "body", r);
    for (const r of d.assets) upsert(this.entities, r.wireId, "asset", r);
    for (const r of d.locomotions) upsert(this.entities, r.wireId, "locomotion", r);
    for (const r of d.appearances) upsert(this.entities, r.wireId, "appearance", r);
    for (const r of d.actions) upsert(this.entities, r.wireId, "action", r);
    this.lastTick = d.tick;
  }

  /**
   * Apply one tick's DeltaSet atomically (interest management): leave
   * entries drop what lived in their sector, then every despawned list
   * (the global entry's are real despawns, a sector's are moves out of
   * it), then all upserts, re-homing each entity to the entry it came in.
   * Despawns before upserts keep an entity crossing between two visible
   * sectors present. `entries` are the decoded Delta payloads (null for a
   * leave), in set order.
   */
  applyDeltaSet(
    tick: number,
    replace: boolean,
    entries: ReadonlyArray<{ sector: string; leave: boolean; delta: CollectedState | null }>,
    globalSector = "g",
  ): DeltaSetResult {
    const before = replace ? new Set(this.entities.keys()) : null;
    if (replace) {
      this.entities.clear();
      this.home.clear();
    }
    const gone = new Map<bigint, boolean>(); // wid -> true when a real despawn
    for (const e of entries) {
      if (!e.leave) continue;
      for (const [wid, h] of this.home) if (h === e.sector) gone.set(wid, false);
    }
    const spawned = new Set<bigint>();
    for (const e of entries) {
      if (!e.delta) continue;
      const real = e.sector === globalSector;
      for (const wid of e.delta.despawned) if (real || !gone.has(wid)) gone.set(wid, real);
      if (real) for (const wid of e.delta.spawned) spawned.add(wid);
    }
    for (const wid of gone.keys()) {
      if (!this.entities.has(wid)) gone.delete(wid);
      this.entities.delete(wid);
      this.home.delete(wid);
    }
    const transforms: TransformRow[] = [];
    const entered: bigint[] = [];
    for (const e of entries) {
      if (!e.delta) continue;
      const d = e.delta;
      const fresh = (wid: bigint): void => {
        if (this.home.get(wid) !== e.sector) {
          if (!this.entities.has(wid) && !gone.has(wid) && !spawned.has(wid) && !before?.has(wid)) entered.push(wid);
          this.home.set(wid, e.sector);
        }
      };
      for (const r of d.transforms) fresh(r.wireId);
      for (const r of d.chunks) fresh(r.wireId);
      for (const r of d.healths) fresh(r.wireId);
      this.applyDelta({ ...d, despawned: [] });
      for (const r of d.transforms) transforms.push(r);
    }
    this.lastTick = tick;
    const despawned: bigint[] = [];
    const left: bigint[] = [];
    for (const [wid, real] of gone) {
      if (this.entities.has(wid)) continue; // left one sector, entered another
      (real ? despawned : left).push(wid);
      this.entered.delete(wid);
    }
    for (const wid of entered) this.entered.add(wid);
    return { despawned, left, entered, transforms };
  }

  get(wireId: bigint): EntityMirror | undefined {
    return this.entities.get(wireId);
  }
}
