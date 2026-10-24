/**
 * Wire codec: FlatBuffers Snapshot/Delta/IntentMessage <-> plain data
 * (docs/MESSAGE-CATALOG.md, packages/schema/mmo_engine.fbs).
 *
 * This module is the decode/encode home for everything that crosses the
 * wire as FlatBuffers. It depends only on `flatbuffers` and the generated
 * schema bindings — never on bitECS or the sim — so both the
 * authoritative server (@mmo-engine/engine-core) and the mirror client
 * (@mmo-engine/client) share it (DRY: one codec, no duplicated wire
 * parsing).
 *
 * Row structs are plain data — no FlatBuffers types leak out of the
 * encode/decode boundary. The schema stays the single source of truth;
 * this module only maps SoA rows <-> wire tables.
 */

import * as flatbuffers from "flatbuffers";
import {
  Action,
  ActionBlock,
  Animation,
  AnimationBlock,
  Appearance,
  AppearanceBlock,
  AssetRef,
  AssetRefBlock,
  BodyConfig,
  BodyConfigBlock,
  CharacterRef,
  CharacterRefBlock,
  Chunk,
  ChunkBlock,
  Delta,
  Health,
  HealthBlock,
  IntentBlock,
  IntentMessage,
  Locomotion,
  LocomotionBlock,
  PlayerIntent,
  Quat,
  Snapshot,
  Stamina,
  StaminaBlock,
  Transform,
  TransformBlock,
  Vec3,
  Velocity,
  VelocityBlock,
} from "@mmo-engine/schema/generated/js/mmo-engine.js";

// ---------------------------------------------------------------- rows

export interface TransformRow {
  wireId: bigint;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  sx: number; sy: number; sz: number;
}

export interface VelocityRow {
  wireId: bigint;
  lx: number; ly: number; lz: number;
  ax: number; ay: number; az: number;
}

export interface IntentRow {
  wireId: bigint;
  mx: number; my: number; mz: number;
  lookYaw: number; lookPitch: number;
  jump: boolean; buttons: number;
}

export interface ChunkRow {
  wireId: bigint;
  chunkId: bigint; seed: bigint; lod: number;
  /**
   * Authoritative heightfield (16x16, row-major) when the server attached
   * it for a network snapshot/delta; null on persisted snapshots and when
   * the sender has no chunk source.
   */
  heights: Float32Array | null;
}

export interface HealthRow {
  wireId: bigint;
  current: number; max: number;
}

/** Stamina pool row (mirrors the FlatBuffers Stamina table). */
export interface StaminaRow {
  wireId: bigint;
  current: number; max: number;
}

/** Character identity row (mirrors the FlatBuffers CharacterRef table). */
export interface CharacterRefRow {
  wireId: bigint;
  /** Character-store id (small integer today, u64-shaped for the world server). */
  characterId: number;
}

/** Rigid-body config row (mirrors the FlatBuffers BodyConfig table). */
export interface BodyConfigRow {
  wireId: bigint;
  shapeKind: number;
  halfX: number; halfY: number; halfZ: number;
  radius: number;
  mass: number;
  motionType: number;
  layer: number;
  friction: number;
  restitution: number;
}

/** Asset reference row (mirrors the FlatBuffers AssetRef table). */
export interface AssetRefRow {
  wireId: bigint;
  assetHash: number;
  variant: number;
}

/** Locomotion row (mirrors the FlatBuffers Locomotion table). */
export interface LocomotionRow {
  wireId: bigint;
  /** LocomotionMode: ground, swimming, or flying. */
  mode: number;
  /** Ability bits: what the entity can do (swim, fly). */
  abilities: number;
  /** Air left, 1 = full, 0 = drowning. */
  breath: number;
}

/**
 * Appearance row (mirrors the FlatBuffers Appearance table): a modular
 * character's look as canonical JSON (parse it with @mmo-engine/art
 * parseLook).
 */
export interface AppearanceRow {
  wireId: bigint;
  look: string;
}

/**
 * Action row (mirrors the FlatBuffers Action table): the combat move an
 * entity is in (protocol Move ids, 0 = none), the tick it started, a
 * sequence that changes with every new move, and its facing (radians).
 */
export interface ActionRow {
  wireId: bigint;
  move: number;
  started: number;
  seq: number;
  yaw: number;
}

/**
 * Animation row (mirrors the FlatBuffers Animation table, EA21): the
 * server's clip decision (protocol ClipId, 0 = none), the tick it started,
 * its playback rate and the layers it plays on (bit 1 base, bit 2 upper).
 */
export interface AnimationRow {
  wireId: bigint;
  clipId: number;
  startTick: number;
  rate: number;
  layerMask: number;
}

/** Plain-data view of world state for one tick. baseTick is 0 for snapshots. */
export interface CollectedState {
  tick: number;
  baseTick: number;
  transforms: TransformRow[];
  velocities: VelocityRow[];
  intents: IntentRow[];
  chunks: ChunkRow[];
  healths: HealthRow[];
  staminas: StaminaRow[];
  characterRefs: CharacterRefRow[];
  bodies: BodyConfigRow[];
  assets: AssetRefRow[];
  locomotions: LocomotionRow[];
  appearances: AppearanceRow[];
  actions: ActionRow[];
  animations: AnimationRow[];
  spawned: bigint[];
  despawned: bigint[];
}

// ------------------------------------------------------------ decode

function readTransformBlock(blk: TransformBlock | null): TransformRow[] {
  const out: TransformRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    const pos = e.position();
    const rot = e.rotation();
    const scl = e.scale();
    out.push({
      wireId: blk.entities(i) ?? 0n,
      px: pos?.x() ?? 0, py: pos?.y() ?? 0, pz: pos?.z() ?? 0,
      qx: rot?.x() ?? 0, qy: rot?.y() ?? 0, qz: rot?.z() ?? 0, qw: rot?.w() ?? 1,
      sx: scl?.x() ?? 1, sy: scl?.y() ?? 1, sz: scl?.z() ?? 1,
    });
  }
  return out;
}

function readVelocityBlock(blk: VelocityBlock | null): VelocityRow[] {
  const out: VelocityRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    const lin = e.linear();
    const ang = e.angular();
    out.push({
      wireId: blk.entities(i) ?? 0n,
      lx: lin?.x() ?? 0, ly: lin?.y() ?? 0, lz: lin?.z() ?? 0,
      ax: ang?.x() ?? 0, ay: ang?.y() ?? 0, az: ang?.z() ?? 0,
    });
  }
  return out;
}

function readIntentBlock(blk: IntentBlock | null): IntentRow[] {
  const out: IntentRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    const mv = e.move();
    out.push({
      wireId: blk.entities(i) ?? 0n,
      mx: mv?.x() ?? 0, my: mv?.y() ?? 0, mz: mv?.z() ?? 0,
      lookYaw: e.lookYaw(), lookPitch: e.lookPitch(),
      jump: e.jump(), buttons: e.buttons(),
    });
  }
  return out;
}

function readChunkBlock(blk: ChunkBlock | null): ChunkRow[] {
  const out: ChunkRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({
      wireId: blk.entities(i) ?? 0n,
      chunkId: e.chunkId(),
      seed: e.seed(),
      lod: e.lod(),
      heights: readHeights(e),
    });
  }
  return out;
}

/**
 * Copy the chunk height vector through the alignment-safe indexed
 * accessor. The generated heightsArray() builds a raw Float32Array view
 * that throws (RangeError) when the wire bytes aren't 4-byte aligned —
 * e.g. Node Buffer pool slices arriving over WebSocket. 256 DataView
 * reads per chunk is negligible (heights only ship on snapshots and
 * newly-spawned-chunk deltas).
 */
function readHeights(e: Chunk): Float32Array | null {
  const n = e.heightsLength();
  if (n === 0) return null;
  const out = new Float32Array(n);
  // heightsLength() > 0 guarantees the vector exists; ?? 0 placates the
  // generated declaration's nullable return.
  for (let i = 0; i < n; i++) out[i] = e.heights(i) ?? 0;
  return out;
}

function readHealthBlock(blk: HealthBlock | null): HealthRow[] {
  const out: HealthRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({
      wireId: blk.entities(i) ?? 0n,
      current: e.current(), max: e.max(),
    });
  }
  return out;
}

function readStaminaBlock(blk: StaminaBlock | null): StaminaRow[] {
  const out: StaminaRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({
      wireId: blk.entities(i) ?? 0n,
      current: e.current(), max: e.max(),
    });
  }
  return out;
}

function readCharacterRefBlock(blk: CharacterRefBlock | null): CharacterRefRow[] {
  const out: CharacterRefRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({
      wireId: blk.entities(i) ?? 0n,
      characterId: e.idHi() * 4294967296 + e.idLo(),
    });
  }
  return out;
}

function readBodyBlock(blk: BodyConfigBlock | null): BodyConfigRow[] {
  const out: BodyConfigRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    const he = e.halfExtents();
    out.push({
      wireId: blk.entities(i) ?? 0n,
      shapeKind: e.shapeKind(),
      halfX: he?.x() ?? 0, halfY: he?.y() ?? 0, halfZ: he?.z() ?? 0,
      radius: e.radius(),
      mass: e.mass(),
      motionType: e.motionType(),
      layer: e.layer(),
      friction: e.friction(),
      restitution: e.restitution(),
    });
  }
  return out;
}

function readAssetRefBlock(blk: AssetRefBlock | null): AssetRefRow[] {
  const out: AssetRefRow[] = [];
  if (!blk) return out;
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({
      wireId: blk.entities(i) ?? 0n,
      assetHash: e.assetHash(),
      variant: e.variant(),
    });
  }
  return out;
}

function readLocomotionBlock(blk: LocomotionBlock | null): LocomotionRow[] {
  const out: LocomotionRow[] = [];
  if (!blk) return out; // absent in snapshots saved before locomotion existed
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({ wireId: blk.entities(i) ?? 0n, mode: e.mode(), abilities: e.abilities(), breath: e.breath() });
  }
  return out;
}

function readAppearanceBlock(blk: AppearanceBlock | null): AppearanceRow[] {
  const out: AppearanceRow[] = [];
  if (!blk) return out; // absent in snapshots saved before appearance existed
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({ wireId: blk.entities(i) ?? 0n, look: e.look() ?? "" });
  }
  return out;
}

function readActionBlock(blk: ActionBlock | null): ActionRow[] {
  const out: ActionRow[] = [];
  if (!blk) return out; // absent in snapshots saved before actions existed
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({ wireId: blk.entities(i) ?? 0n, move: e.move(), started: e.started(), seq: e.seq(), yaw: e.yaw() });
  }
  return out;
}

function readAnimationBlock(blk: AnimationBlock | null): AnimationRow[] {
  const out: AnimationRow[] = [];
  if (!blk) return out; // absent in snapshots saved before animations existed
  const n = blk.itemsLength();
  for (let i = 0; i < n; i++) {
    const e = blk.items(i);
    if (!e) continue;
    out.push({ wireId: blk.entities(i) ?? 0n, clipId: e.clipId(), startTick: e.startTick(), rate: e.rate(), layerMask: e.layerMask() });
  }
  return out;
}

function readIdList(n: number, at: (i: number) => bigint | null): bigint[] {
  const out: bigint[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = at(i) ?? 0n;
  return out;
}

/** Decode Snapshot bytes back into plain rows. */
export function decodeSnapshot(bytes: Uint8Array): CollectedState {
  const bb = new flatbuffers.ByteBuffer(bytes);
  const snap = Snapshot.getRootAsSnapshot(bb);
  return {
    tick: Number(snap.tick()),
    baseTick: 0,
    transforms: readTransformBlock(snap.transforms()),
    velocities: readVelocityBlock(snap.velocities()),
    intents: readIntentBlock(snap.intents()),
    chunks: readChunkBlock(snap.chunks()),
    healths: readHealthBlock(snap.healths()),
    bodies: readBodyBlock(snap.bodies()),
    assets: readAssetRefBlock(snap.assets()),
    locomotions: readLocomotionBlock(snap.locomotions()),
    appearances: readAppearanceBlock(snap.appearances()),
    actions: readActionBlock(snap.actions()),
    animations: readAnimationBlock(snap.animations()),
    staminas: readStaminaBlock(snap.staminas()),
    characterRefs: readCharacterRefBlock(snap.characterRefs()),
    spawned: readIdList(snap.spawnedLength(), (i) => snap.spawned(i)),
    despawned: readIdList(snap.despawnedLength(), (i) => snap.despawned(i) as bigint),
  };
}

/** Decode Delta bytes back into plain rows. */
export function decodeDelta(bytes: Uint8Array): CollectedState {
  const bb = new flatbuffers.ByteBuffer(bytes);
  const d = Delta.getRootAsDelta(bb);
  return {
    tick: Number(d.tick()),
    baseTick: Number(d.baseTick()),
    transforms: readTransformBlock(d.transforms()),
    velocities: readVelocityBlock(d.velocities()),
    intents: readIntentBlock(d.intents()),
    chunks: readChunkBlock(d.chunks()),
    healths: readHealthBlock(d.healths()),
    bodies: readBodyBlock(d.bodies()),
    assets: readAssetRefBlock(d.assets()),
    locomotions: readLocomotionBlock(d.locomotions()),
    appearances: readAppearanceBlock(d.appearances()),
    actions: readActionBlock(d.actions()),
    animations: readAnimationBlock(d.animations()),
    staminas: readStaminaBlock(d.staminas()),
    characterRefs: readCharacterRefBlock(d.characterRefs()),
    spawned: readIdList(d.spawnedLength(), (i) => d.spawned(i)),
    despawned: readIdList(d.despawnedLength(), (i) => d.despawned(i) as bigint),
  };
}

// ------------------------------------------------------------ intents

/**
 * Client→server intent fields (docs/MESSAGE-CATALOG.md §0x05). Plain
 * data — the server maps this onto its QueuedIntent; the client builds
 * it from input. Kept here (not in engine-core's world.ts) so the
 * mirror client doesn't depend on the sim.
 */
export interface IntentFields {
  mx: number;
  my: number;
  mz: number;
  lookYaw: number;
  lookPitch: number;
  jump: boolean;
  buttons: number;
}

export interface DecodedIntentMessage {
  clientTick: bigint;
  /** Wire id of the entity the client claims to drive. */
  entity: bigint;
  intent: IntentFields;
}

/** Build the wire bytes for one client→server intent event. */
export function encodeIntentMessage(
  clientTick: bigint,
  entity: bigint,
  intent: IntentFields,
): Uint8Array {
  const b = new flatbuffers.Builder(128);
  // The move Vec3 is created inline as the argument so it is the most
  // recent write when createPlayerIntent opens the table.
  const intentOff = PlayerIntent.createPlayerIntent(
    b,
    Vec3.createVec3(b, intent.mx, intent.my, intent.mz),
    intent.lookYaw,
    intent.lookPitch,
    intent.jump,
    intent.buttons,
  );
  IntentMessage.startIntentMessage(b);
  IntentMessage.addClientTick(b, clientTick);
  IntentMessage.addEntity(b, entity);
  IntentMessage.addIntent(b, intentOff);
  const root = IntentMessage.endIntentMessage(b);
  b.finish(root);
  return b.asUint8Array();
}

/** Parse and validate one client→server intent event. Throws on garbage. */
export function decodeIntentMessage(bytes: Uint8Array): DecodedIntentMessage {
  const msg = IntentMessage.getRootAsIntentMessage(
    new flatbuffers.ByteBuffer(bytes),
  );
  const pi = msg.intent();
  if (!pi) throw new Error("intent: missing PlayerIntent table");
  const mv = pi.move();
  return {
    clientTick: msg.clientTick(),
    entity: msg.entity(),
    intent: {
      mx: mv?.x() ?? 0,
      my: mv?.y() ?? 0,
      mz: mv?.z() ?? 0,
      lookYaw: pi.lookYaw(),
      lookPitch: pi.lookPitch(),
      jump: pi.jump(),
      buttons: pi.buttons(),
    },
  };
}

// -------------------------------------------------------------- encode
//
// Snapshot/Delta encoding also lives here: encoding maps plain
// CollectedState rows to wire tables with no sim dependency, so the
// server (engine-core collects + commits) and any test or tooling that
// builds fixtures share one implementation.

function buildTransformBlock(b: flatbuffers.Builder, rows: TransformRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    // Structs must be serialized inline: create each Vec3/Quat as the
    // argument of its add call, while the table is open.
    Transform.startTransform(b);
    Transform.addPosition(b, Vec3.createVec3(b, r.px, r.py, r.pz));
    Transform.addRotation(b, Quat.createQuat(b, r.qx, r.qy, r.qz, r.qw));
    Transform.addScale(b, Vec3.createVec3(b, r.sx, r.sy, r.sz));
    items[i] = Transform.endTransform(b);
  }
  const entities = TransformBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = TransformBlock.createItemsVector(b, items);
  TransformBlock.startTransformBlock(b);
  TransformBlock.addEntities(b, entities);
  TransformBlock.addItems(b, vec);
  return TransformBlock.endTransformBlock(b);
}

function buildVelocityBlock(b: flatbuffers.Builder, rows: VelocityRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    Velocity.startVelocity(b);
    Velocity.addLinear(b, Vec3.createVec3(b, r.lx, r.ly, r.lz));
    Velocity.addAngular(b, Vec3.createVec3(b, r.ax, r.ay, r.az));
    items[i] = Velocity.endVelocity(b);
  }
  const entities = VelocityBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = VelocityBlock.createItemsVector(b, items);
  VelocityBlock.startVelocityBlock(b);
  VelocityBlock.addEntities(b, entities);
  VelocityBlock.addItems(b, vec);
  return VelocityBlock.endVelocityBlock(b);
}

function buildIntentBlock(b: flatbuffers.Builder, rows: IntentRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    // The move Vec3 is created inline as the argument so it is the most
    // recent write when createPlayerIntent opens the table.
    items[i] = PlayerIntent.createPlayerIntent(
      b,
      Vec3.createVec3(b, r.mx, r.my, r.mz),
      r.lookYaw, r.lookPitch, r.jump, r.buttons,
    );
  }
  const entities = IntentBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = IntentBlock.createItemsVector(b, items);
  IntentBlock.startIntentBlock(b);
  IntentBlock.addEntities(b, entities);
  IntentBlock.addItems(b, vec);
  return IntentBlock.endIntentBlock(b);
}

function buildChunkBlock(b: flatbuffers.Builder, rows: ChunkRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    // The schema carries chunk_id/seed as full uint64 (bigint); the
    // hi/lo split lives only in the bitECS component stores.
    // Heights ride the wire on network snapshots/deltas only — never
    // persisted (SnapshotStore collects without them).
    const heightsOff =
      r.heights != null ? Chunk.createHeightsVector(b, r.heights) : 0;
    items[i] = Chunk.createChunk(b, r.chunkId, r.seed, r.lod, heightsOff);
  }
  const entities = ChunkBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = ChunkBlock.createItemsVector(b, items);
  ChunkBlock.startChunkBlock(b);
  ChunkBlock.addEntities(b, entities);
  ChunkBlock.addItems(b, vec);
  return ChunkBlock.endChunkBlock(b);
}

function buildHealthBlock(b: flatbuffers.Builder, rows: HealthRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    items[i] = Health.createHealth(b, r.current, r.max);
  }
  const entities = HealthBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = HealthBlock.createItemsVector(b, items);
  HealthBlock.startHealthBlock(b);
  HealthBlock.addEntities(b, entities);
  HealthBlock.addItems(b, vec);
  return HealthBlock.endHealthBlock(b);
}

function buildStaminaBlock(b: flatbuffers.Builder, rows: StaminaRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    items[i] = Stamina.createStamina(b, r.current, r.max);
  }
  const entities = StaminaBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = StaminaBlock.createItemsVector(b, items);
  StaminaBlock.startStaminaBlock(b);
  StaminaBlock.addEntities(b, entities);
  StaminaBlock.addItems(b, vec);
  return StaminaBlock.endStaminaBlock(b);
}

function buildCharacterRefBlock(b: flatbuffers.Builder, rows: CharacterRefRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    items[i] = CharacterRef.createCharacterRef(b, Math.floor(r.characterId / 4294967296), r.characterId % 4294967296);
  }
  const entities = CharacterRefBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = CharacterRefBlock.createItemsVector(b, items);
  CharacterRefBlock.startCharacterRefBlock(b);
  CharacterRefBlock.addEntities(b, entities);
  CharacterRefBlock.addItems(b, vec);
  return CharacterRefBlock.endCharacterRefBlock(b);
}

function buildBodyBlock(b: flatbuffers.Builder, rows: BodyConfigRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    // The half-extents Vec3 struct is created inline as the argument so
    // it is the most recent write when startBodyConfig opens the table.
    BodyConfig.startBodyConfig(b);
    BodyConfig.addShapeKind(b, r.shapeKind);
    BodyConfig.addHalfExtents(b, Vec3.createVec3(b, r.halfX, r.halfY, r.halfZ));
    BodyConfig.addRadius(b, r.radius);
    BodyConfig.addMass(b, r.mass);
    BodyConfig.addMotionType(b, r.motionType);
    BodyConfig.addLayer(b, r.layer);
    BodyConfig.addFriction(b, r.friction);
    BodyConfig.addRestitution(b, r.restitution);
    items[i] = BodyConfig.endBodyConfig(b);
  }
  const entities = BodyConfigBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = BodyConfigBlock.createItemsVector(b, items);
  BodyConfigBlock.startBodyConfigBlock(b);
  BodyConfigBlock.addEntities(b, entities);
  BodyConfigBlock.addItems(b, vec);
  return BodyConfigBlock.endBodyConfigBlock(b);
}

function buildAssetRefBlock(b: flatbuffers.Builder, rows: AssetRefRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    items[i] = AssetRef.createAssetRef(b, r.assetHash, r.variant);
  }
  const entities = AssetRefBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = AssetRefBlock.createItemsVector(b, items);
  AssetRefBlock.startAssetRefBlock(b);
  AssetRefBlock.addEntities(b, entities);
  AssetRefBlock.addItems(b, vec);
  return AssetRefBlock.endAssetRefBlock(b);
}

function buildLocomotionBlock(b: flatbuffers.Builder, rows: LocomotionRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    items[i] = Locomotion.createLocomotion(b, r.mode, r.abilities, r.breath);
  }
  const entities = LocomotionBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = LocomotionBlock.createItemsVector(b, items);
  LocomotionBlock.startLocomotionBlock(b);
  LocomotionBlock.addEntities(b, entities);
  LocomotionBlock.addItems(b, vec);
  return LocomotionBlock.endLocomotionBlock(b);
}

function buildAppearanceBlock(b: flatbuffers.Builder, rows: AppearanceRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    items[i] = Appearance.createAppearance(b, b.createString(rows[i].look));
  }
  const entities = AppearanceBlock.createEntitiesVector(
    b, rows.map((r) => r.wireId),
  );
  const vec = AppearanceBlock.createItemsVector(b, items);
  AppearanceBlock.startAppearanceBlock(b);
  AppearanceBlock.addEntities(b, entities);
  AppearanceBlock.addItems(b, vec);
  return AppearanceBlock.endAppearanceBlock(b);
}

function buildActionBlock(b: flatbuffers.Builder, rows: ActionRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    items[i] = Action.createAction(b, r.move, r.started, r.seq, r.yaw);
  }
  const entities = ActionBlock.createEntitiesVector(b, rows.map((r) => r.wireId));
  const vec = ActionBlock.createItemsVector(b, items);
  ActionBlock.startActionBlock(b);
  ActionBlock.addEntities(b, entities);
  ActionBlock.addItems(b, vec);
  return ActionBlock.endActionBlock(b);
}

function buildAnimationBlock(b: flatbuffers.Builder, rows: AnimationRow[]): number {
  const items: number[] = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    items[i] = Animation.createAnimation(b, r.clipId, r.startTick, r.rate, r.layerMask);
  }
  const entities = AnimationBlock.createEntitiesVector(b, rows.map((r) => r.wireId));
  const vec = AnimationBlock.createItemsVector(b, items);
  AnimationBlock.startAnimationBlock(b);
  AnimationBlock.addEntities(b, entities);
  AnimationBlock.addItems(b, vec);
  return AnimationBlock.endAnimationBlock(b);
}

/**
 * Encode a full Snapshot from collected state.
 *
 * Pass a reused `flatbuffers.Builder` on hot paths to avoid
 * re-allocating the scratch buffer on every call. When a builder is
 * supplied it is `clear()`ed first; the returned Uint8Array is a view
 * into that builder's buffer and is only valid until the builder is
 * used again — copy it if the bytes must outlive the next encode.
 * Without a builder the bytes are freshly owned and safe to keep.
 */
export function encodeSnapshot(
  s: CollectedState,
  builder?: flatbuffers.Builder,
): Uint8Array {
  const b = builder ?? new flatbuffers.Builder(4096);
  if (builder) builder.clear();
  const t = buildTransformBlock(b, s.transforms);
  const v = buildVelocityBlock(b, s.velocities);
  const pi = buildIntentBlock(b, s.intents);
  const ch = buildChunkBlock(b, s.chunks);
  const h = buildHealthBlock(b, s.healths);
  const bd = buildBodyBlock(b, s.bodies);
  const ar = buildAssetRefBlock(b, s.assets);
  const lo = buildLocomotionBlock(b, s.locomotions);
  const ap = buildAppearanceBlock(b, s.appearances);
  const ac = buildActionBlock(b, s.actions);
  const st = buildStaminaBlock(b, s.staminas);
  const cr = buildCharacterRefBlock(b, s.characterRefs);
  const an = buildAnimationBlock(b, s.animations);
  const spawned = Snapshot.createSpawnedVector(b, s.spawned);
  const despawned = Snapshot.createDespawnedVector(b, s.despawned);
  Snapshot.startSnapshot(b);
  Snapshot.addTick(b, BigInt(s.tick));
  Snapshot.addTransforms(b, t);
  Snapshot.addVelocities(b, v);
  Snapshot.addIntents(b, pi);
  Snapshot.addChunks(b, ch);
  Snapshot.addHealths(b, h);
  Snapshot.addBodies(b, bd);
  Snapshot.addAssets(b, ar);
  Snapshot.addSpawned(b, spawned);
  Snapshot.addDespawned(b, despawned);
  Snapshot.addLocomotions(b, lo);
  Snapshot.addAppearances(b, ap);
  Snapshot.addActions(b, ac);
  Snapshot.addStaminas(b, st);
  Snapshot.addCharacterRefs(b, cr);
  Snapshot.addAnimations(b, an);
  const root = Snapshot.endSnapshot(b);
  Snapshot.finishSnapshotBuffer(b, root);
  return b.asUint8Array();
}

/** Encode a changed-only Delta from collected state. */
export function encodeDelta(s: CollectedState): Uint8Array {
  const b = new flatbuffers.Builder(1024);
  const t = buildTransformBlock(b, s.transforms);
  const v = buildVelocityBlock(b, s.velocities);
  const pi = buildIntentBlock(b, s.intents);
  const ch = buildChunkBlock(b, s.chunks);
  const h = buildHealthBlock(b, s.healths);
  const bd = buildBodyBlock(b, s.bodies);
  const ar = buildAssetRefBlock(b, s.assets);
  const lo = buildLocomotionBlock(b, s.locomotions);
  const ap = buildAppearanceBlock(b, s.appearances);
  const ac = buildActionBlock(b, s.actions);
  const st = buildStaminaBlock(b, s.staminas);
  const cr = buildCharacterRefBlock(b, s.characterRefs);
  const an = buildAnimationBlock(b, s.animations);
  const spawned = Delta.createSpawnedVector(b, s.spawned);
  const despawned = Delta.createDespawnedVector(b, s.despawned);
  Delta.startDelta(b);
  Delta.addTick(b, BigInt(s.tick));
  Delta.addBaseTick(b, BigInt(s.baseTick));
  Delta.addTransforms(b, t);
  Delta.addVelocities(b, v);
  Delta.addIntents(b, pi);
  Delta.addChunks(b, ch);
  Delta.addHealths(b, h);
  Delta.addBodies(b, bd);
  Delta.addAssets(b, ar);
  Delta.addSpawned(b, spawned);
  Delta.addDespawned(b, despawned);
  Delta.addLocomotions(b, lo);
  Delta.addAppearances(b, ap);
  Delta.addActions(b, ac);
  Delta.addStaminas(b, st);
  Delta.addCharacterRefs(b, cr);
  Delta.addAnimations(b, an);
  const root = Delta.endDelta(b);
  b.finish(root);
  return b.asUint8Array();
}

// ------------------------------------------------------- SoA encode
//
// Phase 3 (SAB wire encoding): the same Snapshot/Delta bytes built
// directly from columnar component stores indexed by entity slot,
// with NO intermediate row-object copy (CollectedState) in between.
//
// The row path above (collect -> rows -> FlatBuffers) allocates one JS
// object per entity per block on every tick. The SoA path reads the
// SAB-backed bitECS field arrays in place: the FlatBuffers builder
// loop indexes `store[eids[i]]` exactly where the row path would have
// read `rows[i].field`. Field-add order inside every table, vector
// write order, and value conversions are mirrored one-for-one, so the
// SoA encoders produce byte-identical output to the row encoders for
// the same world state (proven by codec-soa.test.ts / snapshot-soa).
//
// The codec still takes no sim dependency: callers pass the stores as
// `ArrayLike<number>` views (plain arrays, typed arrays, or
// SAB-backed views — all index the same) plus a `wireIdOf` resolver.
// The only non-numeric columns need callbacks: appearance looks are
// strings (`lookOf`) and chunk heights are generated arrays
// (`heightsOf`), both cold paths.

/** Shared SoA block header: entity slots in wire order + wire-id resolver. */
export interface SoAColumns {
  /** Entity slots (bitECS eids) in wire order. */
  eids: ArrayLike<number>;
  /** Wire id for a slot. Called once per row. */
  wireIdOf(eid: number): bigint;
}

/** SoA Transform block: field stores indexed by entity slot. */
export interface TransformSoA extends SoAColumns {
  px: ArrayLike<number>; py: ArrayLike<number>; pz: ArrayLike<number>;
  qx: ArrayLike<number>; qy: ArrayLike<number>; qz: ArrayLike<number>; qw: ArrayLike<number>;
  sx: ArrayLike<number>; sy: ArrayLike<number>; sz: ArrayLike<number>;
}

/** SoA Velocity block: field stores indexed by entity slot. */
export interface VelocitySoA extends SoAColumns {
  lx: ArrayLike<number>; ly: ArrayLike<number>; lz: ArrayLike<number>;
  ax: ArrayLike<number>; ay: ArrayLike<number>; az: ArrayLike<number>;
}

/** SoA PlayerIntent block: field stores indexed by entity slot. */
export interface IntentSoA extends SoAColumns {
  mx: ArrayLike<number>; my: ArrayLike<number>; mz: ArrayLike<number>;
  lookYaw: ArrayLike<number>; lookPitch: ArrayLike<number>;
  jump: ArrayLike<number>; buttons: ArrayLike<number>;
}

/** SoA Chunk block: field stores indexed by entity slot. */
export interface ChunkSoA extends SoAColumns {
  chunkIdHi: ArrayLike<number>; chunkIdLo: ArrayLike<number>;
  seedHi: ArrayLike<number>; seedLo: ArrayLike<number>;
  lod: ArrayLike<number>;
  /**
   * Authoritative heights for a chunk slot, or null when the sender has
   * no chunk source. Called at most once per chunk row, in wire order.
   */
  heightsOf?: (eid: number) => Float32Array | null;
}

/** SoA Health block: field stores indexed by entity slot. */
export interface HealthSoA extends SoAColumns {
  current: ArrayLike<number>; max: ArrayLike<number>;
}

/** SoA Stamina block: field stores indexed by entity slot. */
export interface StaminaSoA extends SoAColumns {
  current: ArrayLike<number>; max: ArrayLike<number>;
}

/** SoA CharacterRef block: field stores indexed by entity slot. */
export interface CharacterRefSoA extends SoAColumns {
  idHi: ArrayLike<number>; idLo: ArrayLike<number>;
}

/** SoA BodyConfig block: field stores indexed by entity slot. */
export interface BodySoA extends SoAColumns {
  shapeKind: ArrayLike<number>;
  halfX: ArrayLike<number>; halfY: ArrayLike<number>; halfZ: ArrayLike<number>;
  radius: ArrayLike<number>;
  mass: ArrayLike<number>;
  motionType: ArrayLike<number>;
  layer: ArrayLike<number>;
  friction: ArrayLike<number>;
  restitution: ArrayLike<number>;
}

/** SoA AssetRef block: field stores indexed by entity slot. */
export interface AssetSoA extends SoAColumns {
  assetHash: ArrayLike<number>; variant: ArrayLike<number>;
}

/** SoA Locomotion block: field stores indexed by entity slot. */
export interface LocomotionSoA extends SoAColumns {
  mode: ArrayLike<number>; abilities: ArrayLike<number>; breath: ArrayLike<number>;
}

/** SoA Appearance block: the look string cannot come from a numeric store. */
export interface AppearanceSoA extends SoAColumns {
  /** Canonical look JSON for a slot. Called once per appearance row. */
  lookOf(eid: number): string;
}

/** SoA Action block: field stores indexed by entity slot. */
export interface ActionSoA extends SoAColumns {
  move: ArrayLike<number>; started: ArrayLike<number>;
  seq: ArrayLike<number>; yaw: ArrayLike<number>;
}

/** SoA Animation block: field stores indexed by entity slot. */
export interface AnimationSoA extends SoAColumns {
  clipId: ArrayLike<number>; startTick: ArrayLike<number>;
  rate: ArrayLike<number>; layerMask: ArrayLike<number>;
}

/** Columnar view of world state for one tick. baseTick is 0 for snapshots. */
export interface CollectedStateSoA {
  tick: number;
  baseTick: number;
  transforms: TransformSoA;
  velocities: VelocitySoA;
  intents: IntentSoA;
  chunks: ChunkSoA;
  healths: HealthSoA;
  staminas: StaminaSoA;
  characterRefs: CharacterRefSoA;
  bodies: BodySoA;
  assets: AssetSoA;
  locomotions: LocomotionSoA;
  appearances: AppearanceSoA;
  actions: ActionSoA;
  animations: AnimationSoA;
  spawned: ArrayLike<bigint>;
  despawned: ArrayLike<bigint>;
}

/**
 * Write a u64 id vector from an ArrayLike without materializing a
 * bigint[] first. `start` is the generated `start*Vector` for the
 * field; elements are written in reverse, mirroring the generated
 * `create*Vector` helpers.
 */
function buildU64Vector(
  b: flatbuffers.Builder,
  ids: ArrayLike<bigint>,
  start: (b: flatbuffers.Builder, n: number) => void,
): number {
  start(b, ids.length);
  for (let i = ids.length - 1; i >= 0; i--) b.addInt64(ids[i]);
  return b.endVector();
}

/**
 * Write the entities vector for one SoA block: wire ids resolved on
 * the fly, in reverse, mirroring the generated `createEntitiesVector`.
 * No intermediate bigint[] gather.
 */
function buildEntitiesVectorSoA(
  b: flatbuffers.Builder,
  src: SoAColumns,
  start: (b: flatbuffers.Builder, n: number) => void,
): number {
  const n = src.eids.length;
  start(b, n);
  for (let i = n - 1; i >= 0; i--) b.addInt64(src.wireIdOf(src.eids[i]));
  return b.endVector();
}

function buildTransformBlockSoA(b: flatbuffers.Builder, src: TransformSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    Transform.startTransform(b);
    Transform.addPosition(b, Vec3.createVec3(b, src.px[e], src.py[e], src.pz[e]));
    Transform.addRotation(b, Quat.createQuat(b, src.qx[e], src.qy[e], src.qz[e], src.qw[e]));
    Transform.addScale(b, Vec3.createVec3(b, src.sx[e], src.sy[e], src.sz[e]));
    items[i] = Transform.endTransform(b);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => TransformBlock.startEntitiesVector(bb, k));
  const vec = TransformBlock.createItemsVector(b, items);
  TransformBlock.startTransformBlock(b);
  TransformBlock.addEntities(b, entities);
  TransformBlock.addItems(b, vec);
  return TransformBlock.endTransformBlock(b);
}

function buildVelocityBlockSoA(b: flatbuffers.Builder, src: VelocitySoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    Velocity.startVelocity(b);
    Velocity.addLinear(b, Vec3.createVec3(b, src.lx[e], src.ly[e], src.lz[e]));
    Velocity.addAngular(b, Vec3.createVec3(b, src.ax[e], src.ay[e], src.az[e]));
    items[i] = Velocity.endVelocity(b);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => VelocityBlock.startEntitiesVector(bb, k));
  const vec = VelocityBlock.createItemsVector(b, items);
  VelocityBlock.startVelocityBlock(b);
  VelocityBlock.addEntities(b, entities);
  VelocityBlock.addItems(b, vec);
  return VelocityBlock.endVelocityBlock(b);
}

function buildIntentBlockSoA(b: flatbuffers.Builder, src: IntentSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    items[i] = PlayerIntent.createPlayerIntent(
      b,
      Vec3.createVec3(b, src.mx[e], src.my[e], src.mz[e]),
      src.lookYaw[e], src.lookPitch[e], src.jump[e] !== 0, src.buttons[e],
    );
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => IntentBlock.startEntitiesVector(bb, k));
  const vec = IntentBlock.createItemsVector(b, items);
  IntentBlock.startIntentBlock(b);
  IntentBlock.addEntities(b, entities);
  IntentBlock.addItems(b, vec);
  return IntentBlock.endIntentBlock(b);
}

function buildChunkBlockSoA(b: flatbuffers.Builder, src: ChunkSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    // The schema carries chunk_id/seed as full uint64 (bigint); the
    // hi/lo split lives only in the bitECS component stores. Join with
    // exact bigint math — mirroring the row path's joinU64 — NOT a
    // double round-trip: hi * 2^32 exceeds 2^53 for large ids and a
    // double would silently round (e.g. 0x123456789abcdef0n).
    const chunkId = (BigInt(src.chunkIdHi[e] >>> 0) << 32n) | BigInt(src.chunkIdLo[e] >>> 0);
    const seed = (BigInt(src.seedHi[e] >>> 0) << 32n) | BigInt(src.seedLo[e] >>> 0);
    const heights = src.heightsOf?.(e) ?? null;
    const heightsOff =
      heights != null ? Chunk.createHeightsVector(b, heights) : 0;
    items[i] = Chunk.createChunk(b, chunkId, seed, src.lod[e], heightsOff);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => ChunkBlock.startEntitiesVector(bb, k));
  const vec = ChunkBlock.createItemsVector(b, items);
  ChunkBlock.startChunkBlock(b);
  ChunkBlock.addEntities(b, entities);
  ChunkBlock.addItems(b, vec);
  return ChunkBlock.endChunkBlock(b);
}

function buildHealthBlockSoA(b: flatbuffers.Builder, src: HealthSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    items[i] = Health.createHealth(b, src.current[e], src.max[e]);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => HealthBlock.startEntitiesVector(bb, k));
  const vec = HealthBlock.createItemsVector(b, items);
  HealthBlock.startHealthBlock(b);
  HealthBlock.addEntities(b, entities);
  HealthBlock.addItems(b, vec);
  return HealthBlock.endHealthBlock(b);
}

function buildStaminaBlockSoA(b: flatbuffers.Builder, src: StaminaSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    items[i] = Stamina.createStamina(b, src.current[e], src.max[e]);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => StaminaBlock.startEntitiesVector(bb, k));
  const vec = StaminaBlock.createItemsVector(b, items);
  StaminaBlock.startStaminaBlock(b);
  StaminaBlock.addEntities(b, entities);
  StaminaBlock.addItems(b, vec);
  return StaminaBlock.endStaminaBlock(b);
}

function buildCharacterRefBlockSoA(b: flatbuffers.Builder, src: CharacterRefSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    // Mirror the row path's double round-trip (see ChunkSoA): the row
    // carries characterId as a JS number, so split the same way.
    const characterId = src.idHi[e] * 4294967296 + src.idLo[e];
    items[i] = CharacterRef.createCharacterRef(b, Math.floor(characterId / 4294967296), characterId % 4294967296);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => CharacterRefBlock.startEntitiesVector(bb, k));
  const vec = CharacterRefBlock.createItemsVector(b, items);
  CharacterRefBlock.startCharacterRefBlock(b);
  CharacterRefBlock.addEntities(b, entities);
  CharacterRefBlock.addItems(b, vec);
  return CharacterRefBlock.endCharacterRefBlock(b);
}

function buildBodyBlockSoA(b: flatbuffers.Builder, src: BodySoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    BodyConfig.startBodyConfig(b);
    BodyConfig.addShapeKind(b, src.shapeKind[e]);
    BodyConfig.addHalfExtents(b, Vec3.createVec3(b, src.halfX[e], src.halfY[e], src.halfZ[e]));
    BodyConfig.addRadius(b, src.radius[e]);
    BodyConfig.addMass(b, src.mass[e]);
    BodyConfig.addMotionType(b, src.motionType[e]);
    BodyConfig.addLayer(b, src.layer[e]);
    BodyConfig.addFriction(b, src.friction[e]);
    BodyConfig.addRestitution(b, src.restitution[e]);
    items[i] = BodyConfig.endBodyConfig(b);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => BodyConfigBlock.startEntitiesVector(bb, k));
  const vec = BodyConfigBlock.createItemsVector(b, items);
  BodyConfigBlock.startBodyConfigBlock(b);
  BodyConfigBlock.addEntities(b, entities);
  BodyConfigBlock.addItems(b, vec);
  return BodyConfigBlock.endBodyConfigBlock(b);
}

function buildAssetRefBlockSoA(b: flatbuffers.Builder, src: AssetSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    items[i] = AssetRef.createAssetRef(b, src.assetHash[e], src.variant[e]);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => AssetRefBlock.startEntitiesVector(bb, k));
  const vec = AssetRefBlock.createItemsVector(b, items);
  AssetRefBlock.startAssetRefBlock(b);
  AssetRefBlock.addEntities(b, entities);
  AssetRefBlock.addItems(b, vec);
  return AssetRefBlock.endAssetRefBlock(b);
}

function buildLocomotionBlockSoA(b: flatbuffers.Builder, src: LocomotionSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    items[i] = Locomotion.createLocomotion(b, src.mode[e], src.abilities[e], src.breath[e]);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => LocomotionBlock.startEntitiesVector(bb, k));
  const vec = LocomotionBlock.createItemsVector(b, items);
  LocomotionBlock.startLocomotionBlock(b);
  LocomotionBlock.addEntities(b, entities);
  LocomotionBlock.addItems(b, vec);
  return LocomotionBlock.endLocomotionBlock(b);
}

function buildAppearanceBlockSoA(b: flatbuffers.Builder, src: AppearanceSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    items[i] = Appearance.createAppearance(b, b.createString(src.lookOf(src.eids[i])));
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => AppearanceBlock.startEntitiesVector(bb, k));
  const vec = AppearanceBlock.createItemsVector(b, items);
  AppearanceBlock.startAppearanceBlock(b);
  AppearanceBlock.addEntities(b, entities);
  AppearanceBlock.addItems(b, vec);
  return AppearanceBlock.endAppearanceBlock(b);
}

function buildActionBlockSoA(b: flatbuffers.Builder, src: ActionSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    items[i] = Action.createAction(b, src.move[e], src.started[e], src.seq[e], src.yaw[e]);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => ActionBlock.startEntitiesVector(bb, k));
  const vec = ActionBlock.createItemsVector(b, items);
  ActionBlock.startActionBlock(b);
  ActionBlock.addEntities(b, entities);
  ActionBlock.addItems(b, vec);
  return ActionBlock.endActionBlock(b);
}

function buildAnimationBlockSoA(b: flatbuffers.Builder, src: AnimationSoA): number {
  const n = src.eids.length;
  const items: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = src.eids[i];
    items[i] = Animation.createAnimation(b, src.clipId[e], src.startTick[e], src.rate[e], src.layerMask[e]);
  }
  const entities = buildEntitiesVectorSoA(b, src, (bb, k) => AnimationBlock.startEntitiesVector(bb, k));
  const vec = AnimationBlock.createItemsVector(b, items);
  AnimationBlock.startAnimationBlock(b);
  AnimationBlock.addEntities(b, entities);
  AnimationBlock.addItems(b, vec);
  return AnimationBlock.endAnimationBlock(b);
}

/**
 * Encode a full Snapshot directly from columnar component stores.
 * Byte-identical to `encodeSnapshot` for the same world state.
 *
 * Same builder-reuse contract as `encodeSnapshot`: pass a reused
 * `flatbuffers.Builder` on hot paths; the returned Uint8Array is a
 * view into that builder's buffer until the next encode.
 */
export function encodeSnapshotSoA(
  s: CollectedStateSoA,
  builder?: flatbuffers.Builder,
): Uint8Array {
  const b = builder ?? new flatbuffers.Builder(4096);
  if (builder) builder.clear();
  const t = buildTransformBlockSoA(b, s.transforms);
  const v = buildVelocityBlockSoA(b, s.velocities);
  const pi = buildIntentBlockSoA(b, s.intents);
  const ch = buildChunkBlockSoA(b, s.chunks);
  const h = buildHealthBlockSoA(b, s.healths);
  const bd = buildBodyBlockSoA(b, s.bodies);
  const ar = buildAssetRefBlockSoA(b, s.assets);
  const lo = buildLocomotionBlockSoA(b, s.locomotions);
  const ap = buildAppearanceBlockSoA(b, s.appearances);
  const ac = buildActionBlockSoA(b, s.actions);
  const st = buildStaminaBlockSoA(b, s.staminas);
  const cr = buildCharacterRefBlockSoA(b, s.characterRefs);
  const an = buildAnimationBlockSoA(b, s.animations);
  const spawned = buildU64Vector(b, s.spawned, (bb, k) => Snapshot.startSpawnedVector(bb, k));
  const despawned = buildU64Vector(b, s.despawned, (bb, k) => Snapshot.startDespawnedVector(bb, k));
  Snapshot.startSnapshot(b);
  Snapshot.addTick(b, BigInt(s.tick));
  Snapshot.addTransforms(b, t);
  Snapshot.addVelocities(b, v);
  Snapshot.addIntents(b, pi);
  Snapshot.addChunks(b, ch);
  Snapshot.addHealths(b, h);
  Snapshot.addBodies(b, bd);
  Snapshot.addAssets(b, ar);
  Snapshot.addSpawned(b, spawned);
  Snapshot.addDespawned(b, despawned);
  Snapshot.addLocomotions(b, lo);
  Snapshot.addAppearances(b, ap);
  Snapshot.addActions(b, ac);
  Snapshot.addStaminas(b, st);
  Snapshot.addCharacterRefs(b, cr);
  Snapshot.addAnimations(b, an);
  const root = Snapshot.endSnapshot(b);
  Snapshot.finishSnapshotBuffer(b, root);
  return b.asUint8Array();
}

/**
 * Encode a changed-only Delta directly from columnar component stores.
 * Byte-identical to `encodeDelta` for the same world state.
 */
export function encodeDeltaSoA(s: CollectedStateSoA, builder?: flatbuffers.Builder): Uint8Array {
  const b = builder ?? new flatbuffers.Builder(1024);
  if (builder) builder.clear();
  const t = buildTransformBlockSoA(b, s.transforms);
  const v = buildVelocityBlockSoA(b, s.velocities);
  const pi = buildIntentBlockSoA(b, s.intents);
  const ch = buildChunkBlockSoA(b, s.chunks);
  const h = buildHealthBlockSoA(b, s.healths);
  const bd = buildBodyBlockSoA(b, s.bodies);
  const ar = buildAssetRefBlockSoA(b, s.assets);
  const lo = buildLocomotionBlockSoA(b, s.locomotions);
  const ap = buildAppearanceBlockSoA(b, s.appearances);
  const ac = buildActionBlockSoA(b, s.actions);
  const st = buildStaminaBlockSoA(b, s.staminas);
  const cr = buildCharacterRefBlockSoA(b, s.characterRefs);
  const an = buildAnimationBlockSoA(b, s.animations);
  const spawned = buildU64Vector(b, s.spawned, (bb, k) => Delta.startSpawnedVector(bb, k));
  const despawned = buildU64Vector(b, s.despawned, (bb, k) => Delta.startDespawnedVector(bb, k));
  Delta.startDelta(b);
  Delta.addTick(b, BigInt(s.tick));
  Delta.addBaseTick(b, BigInt(s.baseTick));
  Delta.addTransforms(b, t);
  Delta.addVelocities(b, v);
  Delta.addIntents(b, pi);
  Delta.addChunks(b, ch);
  Delta.addHealths(b, h);
  Delta.addBodies(b, bd);
  Delta.addAssets(b, ar);
  Delta.addSpawned(b, spawned);
  Delta.addDespawned(b, despawned);
  Delta.addLocomotions(b, lo);
  Delta.addAppearances(b, ap);
  Delta.addActions(b, ac);
  Delta.addStaminas(b, st);
  Delta.addCharacterRefs(b, cr);
  Delta.addAnimations(b, an);
  const root = Delta.endDelta(b);
  b.finish(root);
  // A reused builder's bytes are overwritten by the next encode: copy them out.
  return builder ? b.asUint8Array().slice() : b.asUint8Array();
}
