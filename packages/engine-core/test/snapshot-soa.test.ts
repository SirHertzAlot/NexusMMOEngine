import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import * as flatbuffers from "flatbuffers";
import {
  Action,
  Appearance,
  AssetRef,
  BodyConfig,
  Chunk,
  Health,
  Locomotion,
  PlayerIntent,
  SimWorld,
  Transform,
  Velocity,
  attachChunkHeights,
  collectDeltaState,
  collectFullState,
  decodeDelta,
  decodeSnapshot,
  DeltaTracker,
  encodeDelta,
  encodeDeltaFromSim,
  encodeSnapshot,
  encodeSnapshotFromSim,
  splitU64,
} from "../src/index.js";
import { Animation, CharacterRef, Stamina } from "../src/components.js";
import type { ChunkDataSource } from "../src/procgen/chunk-source.js";

/**
 * Phase 3: wire encoding directly from the SAB-backed stores must emit
 * byte-identical output to the collect + row-encode path for the same
 * world state — snapshots, deltas, chunk heights, and builder reuse.
 */

/** World with one entity carrying every wire component. */
function makeWorld(): { sim: SimWorld; full: number; bare: number } {
  const sim = new SimWorld();
  const full = sim.spawn();
  for (const c of [
    Transform, Velocity, PlayerIntent, Chunk, Health, Stamina,
    BodyConfig, AssetRef, Locomotion, Appearance, Action,
    CharacterRef, Animation,
  ]) {
    addComponent(sim.ecs, c, full);
  }
  Transform.px[full] = 1.5; Transform.py[full] = -2.25; Transform.pz[full] = 0;
  Transform.qx[full] = 0; Transform.qy[full] = 0; Transform.qz[full] = 0; Transform.qw[full] = 1;
  Transform.sx[full] = 1; Transform.sy[full] = 2; Transform.sz[full] = 3;
  Velocity.lx[full] = 4; Velocity.ly[full] = 5; Velocity.lz[full] = 6;
  Velocity.ax[full] = 0.1; Velocity.ay[full] = 0.2; Velocity.az[full] = 0.3;
  PlayerIntent.mx[full] = 1; PlayerIntent.my[full] = 0; PlayerIntent.mz[full] = -1;
  PlayerIntent.lookYaw[full] = 1.2; PlayerIntent.lookPitch[full] = -0.4;
  PlayerIntent.jump[full] = 1; PlayerIntent.buttons[full] = 7;
  // Large u64 ids: the SoA chunk join must be exact bigint math, not a
  // double round-trip (0x123456789abcdef0n exceeds 2^53).
  const cid = splitU64(0x123456789abcdef0n);
  const seed = splitU64(0xfedcba9876543210n);
  Chunk.chunkIdHi[full] = cid.hi; Chunk.chunkIdLo[full] = cid.lo;
  Chunk.seedHi[full] = seed.hi; Chunk.seedLo[full] = seed.lo;
  Chunk.lod[full] = 3;
  Health.current[full] = 83.5; Health.max[full] = 100;
  Stamina.current[full] = 42; Stamina.max[full] = 60;
  BodyConfig.shapeKind[full] = 1;
  BodyConfig.halfX[full] = 0.5; BodyConfig.halfY[full] = 1; BodyConfig.halfZ[full] = 0.5;
  BodyConfig.radius[full] = 0.25; BodyConfig.mass[full] = 80;
  BodyConfig.motionType[full] = 2; BodyConfig.layer[full] = 3;
  BodyConfig.friction[full] = 0.8; BodyConfig.restitution[full] = 0.1;
  AssetRef.assetHash[full] = 0xdeadbeef; AssetRef.variant[full] = 3;
  Locomotion.mode[full] = 1; Locomotion.abilities[full] = 3; Locomotion.breath[full] = 0.75;
  Appearance.look[full] = sim.lookId('{"hair":"red"}');
  Action.move[full] = 4; Action.started[full] = 99; Action.seq[full] = 2; Action.yaw[full] = 1.57;
  const charId = splitU64(12345n);
  CharacterRef.idHi[full] = charId.hi; CharacterRef.idLo[full] = charId.lo;
  Animation.clipId[full] = 7; Animation.startTick[full] = 5;
  Animation.rate[full] = 1.25; Animation.layerMask[full] = 3;

  const bare = sim.spawn();
  addComponent(sim.ecs, Transform, bare);
  Transform.px[bare] = 42;

  return { sim, full, bare };
}

function assertBytesEqual(a: Uint8Array, b: Uint8Array): void {
  assert.equal(a.length, b.length, `byte length differs: ${a.length} vs ${b.length}`);
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), "wire bytes differ");
}

test("SoA snapshot from the sim is byte-identical to collect + row encode", () => {
  const { sim } = makeWorld();
  assertBytesEqual(
    encodeSnapshotFromSim(sim, 9),
    encodeSnapshot(collectFullState(sim, 9)),
  );
  // Decoded SoA bytes carry the same state, incl. the large u64 chunk ids.
  const decoded = decodeSnapshot(encodeSnapshotFromSim(sim, 9));
  assert.equal(decoded.chunks[0]?.chunkId, 0x123456789abcdef0n);
  assert.equal(decoded.chunks[0]?.seed, 0xfedcba9876543210n);
  assert.equal(decoded.appearances[0]?.look, '{"hair":"red"}');
  assert.equal(decoded.animations[0]?.clipId, 7);
});

test("SoA delta from the sim is byte-identical to collect + row encode", () => {
  const { sim, full, bare } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();

  // Mutate one field in several blocks, spawn a fully-componented
  // entity, and despawn the bare one.
  Transform.px[full] += 1;
  Health.current[full] -= 5;
  Action.seq[full] += 1;
  Locomotion.breath[full] = 0.5;
  const late = sim.spawn();
  addComponent(sim.ecs, Transform, late);
  addComponent(sim.ecs, Health, late);
  Transform.px[late] = -3;
  Health.current[late] = 7; Health.max[late] = 9;
  sim.despawn(bare);

  assertBytesEqual(
    encodeDeltaFromSim(sim, 1, 0, tracker),
    encodeDelta(collectDeltaState(sim, 1, 0, tracker)),
  );
  const decoded = decodeDelta(encodeDeltaFromSim(sim, 1, 0, tracker));
  assert.deepEqual(decoded.spawned, [sim.wireId(late)]);
  assert.deepEqual(decoded.despawned, [sim.wireId(bare)]);
  assert.deepEqual(decoded.transforms.map((r) => r.wireId), [sim.wireId(full), sim.wireId(late)]);
});

test("SoA delta of an untouched world is an empty delta, byte-identical", () => {
  const { sim } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  assertBytesEqual(
    encodeDeltaFromSim(sim, 1, 0, tracker),
    encodeDelta(collectDeltaState(sim, 1, 0, tracker)),
  );
});

test("SoA snapshot of an empty world is byte-identical", () => {
  const sim = new SimWorld();
  assertBytesEqual(
    encodeSnapshotFromSim(sim, 0),
    encodeSnapshot(collectFullState(sim, 0)),
  );
});

/** Deterministic stub chunk source: heights are a pure function of the inputs. */
const stubSource: ChunkDataSource = {
  chunkSamples: 256,
  generateChunk(seed, cx, cz, lod, out) {
    const base = Number(seed & 0xffffn) + cx * 7 + cz * 13 + lod;
    for (let i = 0; i < out.length; i++) out[i] = (base + i) % 100;
  },
};

test("SoA chunk heights match the attachChunkHeights row path byte-for-byte", () => {
  const { sim } = makeWorld();
  const rows = collectFullState(sim, 0);
  attachChunkHeights(rows, stubSource);
  assertBytesEqual(
    encodeSnapshotFromSim(sim, 0, { chunkSource: stubSource }),
    encodeSnapshot(rows),
  );
  // Heights actually rode the wire on the SoA path.
  const decoded = decodeSnapshot(
    encodeSnapshotFromSim(sim, 0, { chunkSource: stubSource }),
  );
  assert.equal(decoded.chunks[0]?.heights?.length, 256);
});

test("SoA snapshot with a reused builder matches the fresh-builder bytes", () => {
  const { sim } = makeWorld();
  const builder = new flatbuffers.Builder(4096);
  const reused = encodeSnapshotFromSim(sim, 9, { builder });
  const fresh = encodeSnapshotFromSim(sim, 9);
  assertBytesEqual(reused, fresh);
  // A second encode through the same builder overwrites cleanly.
  const reused2 = encodeSnapshotFromSim(sim, 10, { builder });
  assertBytesEqual(reused2, encodeSnapshotFromSim(sim, 10));
});
