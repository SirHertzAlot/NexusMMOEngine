import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  Chunk,
  Health,
  PlayerIntent,
  SimWorld,
  Transform,
  Velocity,
  collectDeltaState,
  collectFullState,
  compareStates,
  decodeDelta,
  decodeSnapshot,
  DeltaTracker,
  encodeDelta,
  encodeSnapshot,
  joinU64,
  splitU64,
  stateFromCollected,
} from "../src/index.js";

/** World with one of each: full entity, transform-only, transform+health. */
function makeWorld(): { sim: SimWorld; full: number; bare: number; hurt: number } {
  const sim = new SimWorld();
  const full = sim.spawn();
  for (const c of [Transform, Velocity, PlayerIntent, Health, Chunk]) {
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
  Health.current[full] = 83.5; Health.max[full] = 100;
  const cid = splitU64(0x123456789abcdef0n);
  const seed = splitU64(0xfedcba9876543210n);
  Chunk.chunkIdHi[full] = cid.hi; Chunk.chunkIdLo[full] = cid.lo;
  Chunk.seedHi[full] = seed.hi; Chunk.seedLo[full] = seed.lo;
  Chunk.lod[full] = 3;

  const bare = sim.spawn();
  addComponent(sim.ecs, Transform, bare);
  Transform.px[bare] = 42;

  const hurt = sim.spawn();
  addComponent(sim.ecs, Transform, hurt);
  addComponent(sim.ecs, Health, hurt);
  Health.current[hurt] = 10; Health.max[hurt] = 50;
  return { sim, full, bare, hurt };
}

test("snapshot encodes and decodes to identical state", () => {
  const { sim, full, bare, hurt } = makeWorld();
  const bytes = encodeSnapshot(collectFullState(sim, 9));
  const decoded = decodeSnapshot(bytes);
  assert.equal(decoded.tick, 9);
  const cmp = compareStates(
    stateFromCollected(collectFullState(sim, 9)),
    stateFromCollected(decoded),
  );
  assert.ok(cmp.equal, cmp.diffs.join("\n"));
  // spawned list survives the round trip
  assert.deepEqual(decoded.spawned, [
    sim.wireId(full), sim.wireId(bare), sim.wireId(hurt),
  ]);
});

test("u64 chunk ids survive the wire bit-identically", () => {
  const { sim, full } = makeWorld();
  const decoded = decodeSnapshot(encodeSnapshot(collectFullState(sim, 0)));
  const row = decoded.chunks.find((c) => c.wireId === sim.wireId(full));
  assert.ok(row);
  assert.equal(row.chunkId, 0x123456789abcdef0n);
  assert.equal(row.seed, 0xfedcba9876543210n);
  assert.equal(joinU64(Chunk.chunkIdHi[full], Chunk.chunkIdLo[full]), row.chunkId);
});

test("delta carries only changed entities", () => {
  const { sim, full, bare } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim); // baseline after the initial snapshot
  sim.endTick();

  Transform.px[full] += 1; // exactly one field changes
  const delta = decodeDelta(encodeDelta(collectDeltaState(sim, 1, 0, tracker)));
  assert.equal(delta.tick, 1);
  assert.equal(delta.baseTick, 0);
  assert.deepEqual(delta.transforms.map((r) => r.wireId), [sim.wireId(full)]);
  assert.deepEqual(delta.velocities, []);
  assert.deepEqual(delta.intents, []);
  assert.deepEqual(delta.chunks, []);
  assert.deepEqual(delta.healths, []);
  assert.deepEqual(delta.spawned, []);
  assert.deepEqual(delta.despawned, []);
  assert.ok(!delta.transforms.some((r) => r.wireId === sim.wireId(bare)));
});

test("an untouched world produces an empty delta", () => {
  const { sim } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();
  const delta = decodeDelta(encodeDelta(collectDeltaState(sim, 1, 0, tracker)));
  assert.deepEqual(delta.transforms, []);
  assert.deepEqual(delta.spawned, []);
  assert.deepEqual(delta.despawned, []);
});

test("entities spawned after the baseline are fully included in the delta", () => {
  const { sim } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();

  const late = sim.spawn();
  addComponent(sim.ecs, Transform, late);
  addComponent(sim.ecs, Health, late);
  Transform.px[late] = 7;
  Health.current[late] = 33; Health.max[late] = 33;

  const delta = decodeDelta(encodeDelta(collectDeltaState(sim, 2, 1, tracker)));
  assert.deepEqual(delta.spawned, [sim.wireId(late)]);
  assert.deepEqual(delta.transforms.map((r) => r.wireId), [sim.wireId(late)]);
  assert.deepEqual(delta.healths.map((r) => r.wireId), [sim.wireId(late)]);
});

test("despawned entities land in the delta despawn list", () => {
  const { sim, bare } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();

  const wid = sim.wireId(bare);
  sim.despawn(bare);
  const delta = decodeDelta(encodeDelta(collectDeltaState(sim, 3, 2, tracker)));
  assert.deepEqual(delta.despawned, [wid]);
  // ...and its rows are gone from the component blocks
  assert.ok(!delta.transforms.some((r) => r.wireId === wid));
});

test("slot reuse across the baseline keeps wire ids unambiguous", () => {
  const { sim, bare } = makeWorld();
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  sim.endTick();

  const oldWid = sim.wireId(bare);
  sim.despawn(bare);
  const next = sim.spawn(); // recycles the slot, bumps generation
  addComponent(sim.ecs, Transform, next);
  const newWid = sim.wireId(next);
  assert.notEqual(oldWid, newWid);

  const delta = decodeDelta(encodeDelta(collectDeltaState(sim, 4, 3, tracker)));
  assert.deepEqual(delta.despawned, [oldWid]);
  assert.deepEqual(delta.spawned, [newWid]);
  assert.deepEqual(delta.transforms.map((r) => r.wireId), [newWid]);
});

test("empty component blocks round-trip", () => {
  const sim = new SimWorld(); // no entities at all
  const decoded = decodeSnapshot(encodeSnapshot(collectFullState(sim, 0)));
  assert.deepEqual(decoded.transforms, []);
  assert.deepEqual(decoded.chunks, []);
  const emptyDelta = decodeDelta(encodeDelta(collectDeltaState(sim, 1, 0, new DeltaTracker())));
  assert.deepEqual(emptyDelta.transforms, []);
});
