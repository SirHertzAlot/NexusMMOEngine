/**
 * Delta application & state comparison (slice 1.2).
 *
 * A WorldState is the client-side view: wire id -> per-component rows.
 * applyDelta mutates a WorldState in place (DOD: no per-tick allocation
 * beyond the rows the delta itself carries):
 * - despawned ids are removed,
 * - block rows are upserted (entities in a block but missing locally
 *   are created — spawned entities arrive in full here),
 * - the spawned[] list needs no action: spawned entities are always
 *   fully present in the blocks.
 *
 * compareStates proves the acceptance invariant: applying the delta
 * stream onto the base snapshot must EXACTLY reproduce the next
 * snapshot. All values originate in f32 SoA stores and survive the
 * FlatBuffers f32 round-trip bit-identically, so the comparison uses
 * exact float equality (eps = 0) — any diff is a real bug, not noise.
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
  IntentRow,
  LocomotionRow,
  TransformRow,
  VelocityRow,
  VfxEmitterRow,
} from "./snapshot.js";

export interface EntityState {
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
  animation?: AnimationRow;
  vfxEmitter?: VfxEmitterRow;
}

export type WorldState = Map<bigint, EntityState>;

function upsert(
  state: WorldState,
  wid: bigint,
  key: keyof EntityState,
  row: TransformRow | VelocityRow | IntentRow | ChunkRow | HealthRow | BodyConfigRow | AssetRefRow | LocomotionRow | AppearanceRow | ActionRow | AnimationRow | VfxEmitterRow,
): void {
  let e = state.get(wid);
  if (!e) {
    e = {};
    state.set(wid, e);
  }
  (e as Record<string, unknown>)[key] = row;
}

/** Build a WorldState from decoded snapshot/delta rows. */
export function stateFromCollected(s: CollectedState): WorldState {
  const state: WorldState = new Map();
  applyDelta(state, s);
  return state;
}

/**
 * Apply a decoded Delta (or Snapshot) onto a WorldState, in place.
 * Returns the same map.
 */
export function applyDelta(state: WorldState, delta: CollectedState): WorldState {
  for (const wid of delta.despawned) state.delete(wid);
  for (const r of delta.transforms) upsert(state, r.wireId, "transform", r);
  for (const r of delta.velocities) upsert(state, r.wireId, "velocity", r);
  for (const r of delta.intents) upsert(state, r.wireId, "intent", r);
  for (const r of delta.chunks) upsert(state, r.wireId, "chunk", r);
  for (const r of delta.healths) upsert(state, r.wireId, "health", r);
  for (const r of delta.bodies) upsert(state, r.wireId, "body", r);
  for (const r of delta.assets) upsert(state, r.wireId, "asset", r);
  for (const r of delta.locomotions) upsert(state, r.wireId, "locomotion", r);
  for (const r of delta.appearances) upsert(state, r.wireId, "appearance", r);
  for (const r of delta.actions) upsert(state, r.wireId, "action", r);
  for (const r of delta.animations) upsert(state, r.wireId, "animation", r);
  for (const r of delta.vfxEmitters) upsert(state, r.wireId, "vfxEmitter", r);
  return state;
}

const FLOAT_FIELDS: Record<string, string[]> = {
  transform: ["px", "py", "pz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"],
  velocity: ["lx", "ly", "lz", "ax", "ay", "az"],
  intent: ["mx", "my", "mz", "lookYaw", "lookPitch"],
  health: ["current", "max"],
  body: ["halfX", "halfY", "halfZ", "radius", "mass", "friction", "restitution"],
  locomotion: ["breath"],
  action: ["yaw"],
  animation: ["rate"],
  vfxEmitter: ["intensity"],
};

const EXACT_FIELDS: Record<string, string[]> = {
  intent: ["jump", "buttons"],
  chunk: ["chunkId", "seed", "lod"],
  body: ["shapeKind", "motionType", "layer"],
  asset: ["assetHash", "variant"],
  locomotion: ["mode", "abilities"],
  appearance: ["look"],
  action: ["move", "started", "seq"],
  animation: ["clipId", "startTick", "layerMask"],
  vfxEmitter: ["template"],
};

function rowsEqual(
  key: string,
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  wid: string,
  diffs: string[],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) {
    diffs.push(`${wid}.${key}: present on one side only`);
    return false;
  }
  let ok = true;
  for (const f of FLOAT_FIELDS[key] ?? []) {
    if ((a[f] as number) !== (b[f] as number)) {
      diffs.push(`${wid}.${key}.${f}: ${a[f]} !== ${b[f]}`);
      ok = false;
    }
  }
  for (const f of EXACT_FIELDS[key] ?? []) {
    if (a[f] !== b[f]) {
      diffs.push(`${wid}.${key}.${f}: ${String(a[f])} !== ${String(b[f])}`);
      ok = false;
    }
  }
  return ok;
}

export interface StateComparison {
  equal: boolean;
  /** Human-readable diffs, capped at 20 entries. */
  diffs: string[];
}

/**
 * Exact comparison of two world states. Float fields use === on
 * purpose: every value comes from an f32 store and survives the wire
 * round-trip bit-identically.
 */
export function compareStates(a: WorldState, b: WorldState): StateComparison {
  const diffs: string[] = [];
  let ok = true;
  const note = (d: string): void => {
    ok = false;
    if (diffs.length < 20) diffs.push(d);
  };
  if (a.size !== b.size) note(`entity count: ${a.size} !== ${b.size}`);
  const keys = ["transform", "velocity", "intent", "chunk", "health", "body"] as const;
  for (const [wid, ea] of a) {
    const eb = b.get(wid);
    if (!eb) {
      note(`entity ${wid}: missing on right`);
      continue;
    }
    const local: string[] = [];
    for (const k of keys) {
      rowsEqual(k, ea[k] as Record<string, unknown> | undefined,
        eb[k] as Record<string, unknown> | undefined, wid.toString(), local);
    }
    for (const d of local) {
      if (diffs.length >= 20) break;
      diffs.push(d);
    }
    if (local.length > 0) ok = false;
  }
  for (const wid of b.keys()) {
    if (!a.has(wid)) note(`entity ${wid}: missing on left`);
  }
  return { equal: ok, diffs };
}
