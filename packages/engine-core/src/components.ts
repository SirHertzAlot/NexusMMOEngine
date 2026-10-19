/**
 * Slice-1 component set (skill brief §2, "Component registry").
 *
 * bitECS 0.3.40 SoA components: each field is a typed array indexed by
 * entity id. No per-entity allocation on hot paths (DOD) — systems read
 * and write flat arrays directly.
 *
 * Field naming mirrors the FlatBuffers schema
 * (packages/schema/mmo_engine.fbs) so the mapping is mechanical:
 * - Transform: position (px/py/pz), rotation quaternion (qx/qy/qz/qw),
 *   scale (sx/sy/sz)
 * - Velocity: linear (lx/ly/lz), angular (ax/ay/az)
 * - PlayerIntent: wish-move (mx/my/mz), look yaw/pitch, jump, buttons
 * - Chunk: u64 chunk_id and seed split into hi/lo u32 pairs (bitECS has
 *   no u64 store type; f64 would lose precision above 2^53), lod
 * - Health: current / max
 * - BodyConfig: rigid-body description for the Jolt physics addon —
 *   shape (box half-extents or sphere radius), mass, motion type, layer,
 *   friction, restitution. Entities carrying BodyConfig are simulated
 *   by PhysicsSystem (src/systems.ts); IntegrateSystem skips them.
 *
 * COMPONENT_IDS documents the registry order (Transform=0 …
 * AudioEmitter=20) for future compact wire formats; the current
 * Snapshot/Delta framing carries one block per component, so ids are
 * not on the wire yet.
 */

import { defineComponent, Types } from "bitecs";
import { defineSABComponent } from "./sab-store.js";

export const Transform = defineSABComponent({
  px: Types.f32,
  py: Types.f32,
  pz: Types.f32,
  qx: Types.f32,
  qy: Types.f32,
  qz: Types.f32,
  qw: Types.f32,
  sx: Types.f32,
  sy: Types.f32,
  sz: Types.f32,
});

export const Velocity = defineSABComponent({
  lx: Types.f32,
  ly: Types.f32,
  lz: Types.f32,
  ax: Types.f32,
  ay: Types.f32,
  az: Types.f32,
});

export const PlayerIntent = defineSABComponent({
  mx: Types.f32,
  my: Types.f32,
  mz: Types.f32,
  lookYaw: Types.f32,
  lookPitch: Types.f32,
  jump: Types.ui8,
  buttons: Types.ui8,
});

export const Chunk = defineSABComponent({
  chunkIdHi: Types.ui32,
  chunkIdLo: Types.ui32,
  seedHi: Types.ui32,
  seedLo: Types.ui32,
  lod: Types.ui8,
});

export const Health = defineSABComponent({
  current: Types.f32,
  max: Types.f32,
});

/**
 * Stamina pool (U2): current/max f32, drained by exertion (dodge,
 * attacks, jumps, swimming, running), back after a cooldown. Rides the
 * wire like Health so the client bar is live; max comes from the
 * `maxStamina` drive (StatsSystem), regen from the `staminaRegen` stat.
 */
export const Stamina = defineSABComponent({
  current: Types.f32,
  max: Types.f32,
});

/**
 * Survival needs (U3): hunger and thirst meters, full at spawn, drained by
 * NeedsSystem from the `needs` rules; an empty one hurts Health. Server
 * only for now: no wire field yet, so no HUD (roadmap U3).
 */
export const Needs = defineSABComponent({
  hunger: Types.f32,
  hungerMax: Types.f32,
  thirst: Types.f32,
  thirstMax: Types.f32,
});

/**
 * God mode (A4): a tag, never replicated. Every Health-loss path
 * (combat blows, hunger, drowning, traps) skips a carrier; the `god`
 * admin command adds and removes it.
 */
// Tag: no data, so no SAB backing — plain defineComponent().
export const God = defineComponent();

/**
 * No-clip (A4): a tag, never replicated. Carriers move freely (vertical
 * intent, no ground clamp, no gravity) and dungeon walls let them pass;
 * the `noclip` admin command adds and removes it.
 */
// Tag: no data, so no SAB backing — plain defineComponent().
export const Noclip = defineComponent();

/**
 * BodyConfig — rigid-body description for the Jolt physics addon
 * (Phase 2). JS owns this component (authoritative config); the native
 * world owns the simulated state and writes results back into
 * Transform/Velocity each tick.
 *
 * Conventions (mirror mmo_engine.fbs ShapeKind/MotionType and the
 * addon C ABI):
 * - shapeKind: 0 = box (uses halfX/halfY/halfZ), 1 = sphere (uses radius),
 *   2 = capsule (uses radius and halfY, the straight section's half
 *   length), upright with its base at the entity's position (the feet)
 * - motionType: 0 = static, 1 = kinematic, 2 = dynamic
 * - layer: 0 = NON_MOVING (static geometry), anything else = MOVING
 */
export const BodyConfig = defineSABComponent({
  shapeKind: Types.ui8,
  halfX: Types.f32,
  halfY: Types.f32,
  halfZ: Types.f32,
  radius: Types.f32,
  mass: Types.f32,
  motionType: Types.ui8,
  layer: Types.ui8,
  friction: Types.f32,
  restitution: Types.f32,
});

/** Mirror of the FlatBuffers ShapeKind enum (mmo_engine.fbs). */
export const ShapeKind = {
  Box: 0,
  Sphere: 1,
  Capsule: 2,
} as const;

/** Mirror of the FlatBuffers MotionType enum (mmo_engine.fbs). */
export const MotionType = {
  Static: 0,
  Kinematic: 1,
  Dynamic: 2,
} as const;

export const COMPONENT_IDS = {
  Transform: 0,
  Velocity: 1,
  PlayerIntent: 2,
  Chunk: 3,
  Health: 4,
  BodyConfig: 5,
  PathRequest: 6,
  PathState: 7,
  AssetRef: 8,
  Locomotion: 9,
  Appearance: 10,
  Action: 11,
  Stamina: 12,
  CharacterRef: 13,
  Needs: 14,
  God: 15,
  Noclip: 16,
  Animation: 17,
  FlowRef: 18,
  VfxEmitter: 19,
  AudioEmitter: 20,
} as const;

const U32 = 0xffffffffn;

/** Split a u64 into hi/lo u32 for Chunk's ui32 stores. */
export function splitU64(v: bigint): { hi: number; lo: number } {
  if (v < 0n || v > 0xffffffffffffffffn)
    throw new RangeError(`u64 out of range: ${v}`);
  return { hi: Number((v >> 32n) & U32), lo: Number(v & U32) };
}

/** Rejoin hi/lo u32 stores into a u64. */
export function joinU64(hi: number, lo: number): bigint {
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

// ---------------------------------------------------------------------------
// Slice 2.1 (Phase 2): navigation components.
//
// PathRequest: issued by AI/game logic when an entity needs a path.
//   x, z: destination in world space (y is resolved by the navmesh).
//   profile: agent profile id (body dimensions) for the native NavService.
//   token: monotonic request id; the system echoes it into PathState.token
//     when the request is issued. Bumping token re-issues the request.
//
// PathState: written by NavigationSystem (flat fields only). The variable
// waypoint list lives in the engine-side WaypointStore (paired SoA
// arena, one fixed slot per entity — see navigation/system.ts); this
// component holds a slice descriptor plus status. This is the DOD
// representation of `PathState { status, waypoints }`: the ECS row is the
// status + descriptor, the dense arena holds the vectors. Steering (JS,
// future slice) reads WaypointStore; the snapshot encoder carries
// status/token/count only, never the arena.
// ---------------------------------------------------------------------------

/** Max waypoints per path request (fixed WaypointStore stride). */
export const MAX_PATH_WAYPOINTS = 16;

/** PathState.status lifecycle. */
export const PathRequestStatus = {
  /** No request issued yet. */
  Idle: 0,
  /** Collected by the system this tick, awaiting the native batch call. */
  Pending: 1,
  /** Valid path resident in WaypointStore; steering may consume it. */
  Active: 2,
  /** Terminal: backend reported no path (incl. unreachable target). */
  Failed: 3,
} as const;

export const PathRequest = defineSABComponent({
  x: Types.f32,
  z: Types.f32,
  profile: Types.ui8,
  token: Types.ui32,
});

export const PathState = defineSABComponent({
  status: Types.i8,
  token: Types.ui32,
  waypointOffset: Types.ui32,
  waypointCount: Types.ui8,
});

// ---------------------------------------------------------------------------
// Crowd steering (DetourCrowd, navigation/crowd-system.ts).
//
// Every character (Locomotion) is an agent in the navigation crowd, so
// the ones that steer keep clear of it. An entity that also has NavAgent
// steers: it walks to (tx, ty, tz) at `speed` along the navmesh, round
// what's in the way, and CrowdSystem turns the crowd's velocity into its
// PlayerIntent. To give a new target, write it and bump `seq`; a NaN tx
// stops it. `state` is the crowd's answer (NavAgentState). Server-only:
// never replicated or persisted (a brain sets targets again).
// ---------------------------------------------------------------------------

/** NavAgent.state (mirrors the addon's CrowdAgentState). */
export const NavAgentState = {
  /** Not on the navmesh (no tile loaded under it, swimming, flying). */
  Invalid: 0,
  Idle: 1,
  Moving: 2,
  Arrived: 3,
  NoPath: 4,
} as const;

export const NavAgent = defineSABComponent({
  tx: Types.f32,
  ty: Types.f32,
  tz: Types.f32,
  /** Bumped on every new target. */
  seq: Types.ui16,
  /** Walking speed, m/s. */
  speed: Types.f32,
  state: Types.ui8,
});

// ---------------------------------------------------------------------------
// PCG scatter (slice 1+2): AssetRef component.
//
// Set at spawn from the scatter spawn table (@mmo-engine/scatter), then
// (practically) never changed — spawn-time configuration like BodyConfig.
//   assetHash: fnv1a32 of the art-manifest model id (flat u32; bitECS has
//     no string store type, and DOD wants no strings in SoA).
//   variant: u16 art-variant selector for the asset provider.
// Snapshot/delta/persistence wiring lands with region integration
// (PCG slice 4); the id is reserved here so cooking targets the real id.
// ---------------------------------------------------------------------------

/** PCG scatter asset reference — ComponentId 8. */
export const AssetRef = defineSABComponent({
  assetHash: Types.ui32,
  variant: Types.ui16,
});

// ---------------------------------------------------------------------------
// Locomotion (ComponentId 9): how an entity moves — on the ground,
// swimming, or flying (mode: protocol LocomotionMode), what it can do
// (abilities: protocol Ability bits), and its breath underwater (1 = full,
// 0 = drowning). Owned by CharacterSystem; replicated to clients.
// ---------------------------------------------------------------------------

export const Locomotion = defineSABComponent({
  mode: Types.ui8,
  abilities: Types.ui8,
  breath: Types.f32,
});

// ---------------------------------------------------------------------------
// Appearance (ComponentId 10): how a modular character looks. `look` is an
// id into the SimWorld's look table (SimWorld.setLook / lookJson): looks
// are canonical JSON strings, and SoA stores hold no strings. Equal looks
// share an id, so the delta diff sees a change only when the look does.
// Set at spawn (players: their character; enemy humans: a generated look).
// ---------------------------------------------------------------------------

export const Appearance = defineSABComponent({
  look: Types.ui32,
});

// ---------------------------------------------------------------------------
// Action (ComponentId 11): the combat move an entity is in — protocol Move
// id (0 = none), the server tick it started, a sequence bumped with every
// new move, and the facing it was made in (radians about +Y). Owned by
// CombatSystem; clients play the move's clip from its start tick.
// ---------------------------------------------------------------------------

export const Action = defineSABComponent({
  move: Types.ui16,
  started: Types.ui32,
  seq: Types.ui8,
  yaw: Types.f32,
});

// ---------------------------------------------------------------------------
// CharacterRef: the character an entity plays as (C3) — the
// character-store id split hi/lo (bitECS has no u64 store). Set at spawn
// for player avatars; bots and props carry no row. Replicated so every
// client can tie entities to names (the `names` control message).
// ---------------------------------------------------------------------------

export const CharacterRef = defineSABComponent({
  idHi: Types.ui32,
  idLo: Types.ui32,
});

// ---------------------------------------------------------------------------
// WorldItem: an item lying on the ground (roadmap M3a). Server-only: never
// replicated or persisted (clients see the entity's Transform and AssetRef,
// variant GROUND_ITEM_VARIANT, and its name from the drops message). `item`
// is the ItemStore id; `owner` the character the drop belongs to (0:
// anyone) until tick `ownedUntil`; it disappears at tick `despawnAt`.
// ---------------------------------------------------------------------------

export const WorldItem = defineSABComponent({
  item: Types.ui32,
  owner: Types.f64,
  ownedUntil: Types.ui32,
  despawnAt: Types.ui32,
});

// ---------------------------------------------------------------------------
// Animation (EA21): the server's clip decision for an entity — which clip,
// when it started, at what rate, on which layers. The client renders bone
// matrices from this; the server never computes bones. clipId 0 = no clip
// (use locomotion fallback). layerMask bits: 1 = base (full body),
// 2 = upper body only.
// ---------------------------------------------------------------------------

export const Animation = defineSABComponent({
  clipId: Types.ui16,
  startTick: Types.ui32,
  rate: Types.f32,
  layerMask: Types.ui8,
});

// ---------------------------------------------------------------------------
// Per-object flow/vfx/audio markers (viewport authoring, code-first cut).
//
// Set by the designer in the viewport authoring tool; no tick logic —
// markers only, no systems read them yet. The widgets for flow, VFX, and
// audio summon on selection only when one of these rows exists on the
// entity (the "available-to-add shelf" adds it; editing mutates fields).
// SoA carries no strings (bitECS has no string store type): each id field
// is the fnv1a32 hash of the content's string id, the same convention as
// AssetRef.assetHash (packages/art/src/provider.ts, engine-core spawn
// tables). The runtime resolves the hash back through the content index.
// ---------------------------------------------------------------------------

/**
 * FlowRef (ComponentId 18): binds a flow graph to an entity — the authored
 * trigger/logic (dialog, scripted sequence, trap behavior) that the flow
 * runtime runs against this object. `graph` is the fnv1a32 hash of the
 * flow-graph id (content/flow/<id>.flow.json); `enabled` (0/1) is the
 * gate the runner checks before firing. Owned by the designer; server
 * only for now (the flow runtime lives on the server — no wire field
 * yet).
 */
export const FlowRef = defineSABComponent({
  graph: Types.ui32,
  enabled: Types.ui8,
});

/**
 * VfxEmitter (ComponentId 19): per-object particle emitter binding.
 * `template` is the fnv1a32 hash of the VfxEffect id
 * (content/vfx/effects/<id>.json — v1 scope is one emitter per effect, so
 * the effect id selects the emitter template); `intensity` scales the
 * authored emission (rate/duration multipliers stay in the template).
 * Owned by the designer; replicated so clients spawn the effect at the
 * entity's Transform.
 */
export const VfxEmitter = defineSABComponent({
  template: Types.ui32,
  intensity: Types.f32,
});

/**
 * AudioEmitter (ComponentId 20): per-object audio emitter.
 * `clip` is the fnv1a32 hash of the sound-bank event name
 * (content/audio/events.json — audio events are named, so the hash of
 * the name is the id); `radius` is the audible range in meters for
 * positional falloff. Owned by the designer; replicated so clients play
 * the event positioned at the entity's Transform.
 */
export const AudioEmitter = defineSABComponent({
  clip: Types.ui32,
  radius: Types.f32,
});
