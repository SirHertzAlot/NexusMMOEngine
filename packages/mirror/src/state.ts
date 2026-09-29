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
  AppearanceRow,
  AssetRefRow,
  BodyConfigRow,
  ChunkRow,
  CollectedState,
  HealthRow,
  IntentRow,
  LocomotionRow,
  TransformRow,
  VelocityRow,
} from "@mmo-engine/protocol";

export interface EntityMirror {
  wireId: bigint;
  transform?: TransformRow;
  velocity?: VelocityRow;
  intent?: IntentRow;
  chunk?: ChunkRow;
  health?: HealthRow;
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

export class MirrorState {
  readonly entities = new Map<bigint, EntityMirror>();
  /** Last authoritative tick applied (snapshot or delta). */
  lastTick = 0;

  get entityCount(): number {
    return this.entities.size;
  }

  /** Full replace from a welcome/periodic Snapshot. */
  applySnapshot(s: CollectedState): void {
    this.entities.clear();
    this.applyDelta(s);
  }

  /** Fold a per-tick Delta onto the current state, in place. */
  applyDelta(d: CollectedState): void {
    for (const wid of d.despawned) this.entities.delete(wid);
    // spawned[] needs no action: spawned entities always arrive fully
    // in the component blocks (server contract, MESSAGE-CATALOG.md).
    for (const r of d.transforms) upsert(this.entities, r.wireId, "transform", r);
    for (const r of d.velocities) upsert(this.entities, r.wireId, "velocity", r);
    for (const r of d.intents) upsert(this.entities, r.wireId, "intent", r);
    for (const r of d.chunks) upsert(this.entities, r.wireId, "chunk", r);
    for (const r of d.healths) upsert(this.entities, r.wireId, "health", r);
    for (const r of d.bodies) upsert(this.entities, r.wireId, "body", r);
    for (const r of d.assets) upsert(this.entities, r.wireId, "asset", r);
    for (const r of d.locomotions) upsert(this.entities, r.wireId, "locomotion", r);
    for (const r of d.appearances) upsert(this.entities, r.wireId, "appearance", r);
    for (const r of d.actions) upsert(this.entities, r.wireId, "action", r);
    this.lastTick = d.tick;
  }

  get(wireId: bigint): EntityMirror | undefined {
    return this.entities.get(wireId);
  }
}
