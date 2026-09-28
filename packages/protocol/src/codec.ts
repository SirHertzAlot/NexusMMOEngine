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
  AssetRef,
  AssetRefBlock,
  BodyConfig,
  BodyConfigBlock,
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

/** Plain-data view of world state for one tick. baseTick is 0 for snapshots. */
export interface CollectedState {
  tick: number;
  baseTick: number;
  transforms: TransformRow[];
  velocities: VelocityRow[];
  intents: IntentRow[];
  chunks: ChunkRow[];
  healths: HealthRow[];
  bodies: BodyConfigRow[];
  assets: AssetRefRow[];
  locomotions: LocomotionRow[];
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
  const root = Delta.endDelta(b);
  b.finish(root);
  return b.asUint8Array();
}
