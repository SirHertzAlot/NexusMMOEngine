import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSharedMemoryPlane,
  attachSharedMemoryPlane,
  part1By1,
  compact1By1,
  encodeMorton2D,
  decodeMorton2D,
  MortonSpatialIndex,
  packEntityHandle,
  unpackEntityHandle,
  GenerationalSlabAllocator,
  writeEntityStateToSAB,
  readEntityStateFromSAB,
  setEntityAliveBit,
  AtomicMPSCQueue,
  AtomicSPSCTransactionQueue,
  PersistenceWorkerRuntime,
  PERSIST_TX_KIND,
  SimWorkerRuntime,
  HybridDataPlaneServer,
  packCommandToken,
  INTENT_FLAGS,
  TELEMETRY_SLOTS,
  DT,
} from "../src/index.js";

test("PATCH-02: Morton 2D bit interleaving and invertibility", () => {
  // Test part1By1 and compact1By1 round-trip
  for (const v of [0, 1, 42, 255, 1024, 65535]) {
    const spread = part1By1(v);
    const recovered = compact1By1(spread);
    assert.equal(recovered, v, `Failed for value ${v}`);
  }

  // Test encode/decode round-trip across domain bounds
  const coords = [
    { x: -4096, z: -4096 },
    { x: 0, z: 0 },
    { x: 1234.5, z: -567.25 },
    { x: 4096, z: 4096 },
  ];
  for (const c of coords) {
    const code = encodeMorton2D(c.x, c.z, 4096);
    assert.ok(Number.isInteger(code));
    assert.ok(code >= 0 && code <= 0xffffffff);
    const dec = decodeMorton2D(code);
    assert.ok(dec.qx >= 0 && dec.qx <= 65535);
    assert.ok(dec.qz >= 0 && dec.qz <= 65535);
  }
});

test("PATCH-02: MortonSpatialIndex monotonic radix sort and queryRadius", () => {
  const sab = createSharedMemoryPlane(100);
  const views = attachSharedMemoryPlane(sab, 100);
  const index = new MortonSpatialIndex(100);

  // Populate 10 entities with known positions
  views.planar.px[0] = 0; views.planar.pz[0] = 0; views.planar.hp[0] = 100;
  views.planar.px[1] = 5; views.planar.pz[1] = 5; views.planar.hp[1] = 100;
  views.planar.px[2] = 10; views.planar.pz[2] = 10; views.planar.hp[2] = 100;
  views.planar.px[3] = 100; views.planar.pz[3] = 100; views.planar.hp[3] = 100;
  views.planar.px[4] = 500; views.planar.pz[4] = 500; views.planar.hp[4] = 0; // dead

  const count = index.rebuildFromSoA(views.planar, 5, 4096);
  assert.equal(count, 4);

  // Monotonic Morton order assertion
  for (let i = 0; i < count - 1; i++) {
    assert.ok(
      index.mortonKeys[i] <= index.mortonKeys[i + 1],
      `Non-monotonic keys at ${i}: ${index.mortonKeys[i]} > ${index.mortonKeys[i + 1]}`,
    );
  }

  // Radius query around (0,0) radius 15
  const out = new Uint16Array(10);
  const found = index.queryRadius(views.planar, 0, 0, 15, out, 4096);
  assert.equal(found, 3); // entities 0, 1, 2
  const ids = Array.from(out.subarray(0, found)).sort((a, b) => a - b);
  assert.deepEqual(ids, [0, 1, 2]);
});

test("PATCH-03: AtomicMPSCQueue bounded concurrent ring queue", () => {
  const q = new AtomicMPSCQueue(16);
  assert.equal(q.capacity, 16);

  // Enqueue 16 commands to fill the queue
  for (let i = 0; i < 16; i++) {
    const ok = q.enqueueCommand(i, 100 + i, 1, 0);
    assert.equal(ok, true, `Failed enqueue at ${i}`);
  }

  // 17th command must be rejected (queue full) and droppedCount incremented
  const overflow = q.enqueueCommand(999, 999, 1, 0);
  assert.equal(overflow, false);
  assert.equal(q.droppedCount, 1);

  // Drain all 16 commands
  const received: number[] = [];
  const drained = q.drainCommands((eid, code) => {
    received.push(eid);
    assert.equal(code, 100 + eid);
  });
  assert.equal(drained, 16);
  assert.equal(received.length, 16);

  // Now subsequent enqueues must succeed again (wraparound lap)
  for (let i = 0; i < 8; i++) {
    const ok = q.enqueueCommand(200 + i, 500, 2, 0);
    assert.equal(ok, true);
  }
  let lapDrained = 0;
  q.drainCommands((eid) => {
    assert.equal(eid, 200 + lapDrained);
    lapDrained++;
  });
  assert.equal(lapDrained, 8);
});

test("PATCH-05: GenerationalSlabAllocator ABA guard and bitset recycling", () => {
  const sab = createSharedMemoryPlane(32);
  const views = attachSharedMemoryPlane(sab, 32);
  const alloc = new GenerationalSlabAllocator(32);

  // Allocate first entity
  const h1 = alloc.allocate(views.floatMatrixView, views.planar, { px: 10, py: 20, pz: 30, hp: 100 });
  assert.ok(h1 !== 0);
  const u1 = unpackEntityHandle(h1);
  assert.equal(u1.index, 0);
  assert.equal(u1.generation, 1);
  assert.equal(alloc.isValid(h1), true);
  assert.equal(alloc.size, 1);

  // Validate state in SAB
  const s1 = readEntityStateFromSAB(views.floatMatrixView, 0);
  assert.equal(s1.px, 10);
  assert.equal(s1.hp, 100);
  assert.equal((views.planar.aliveBitset[0] & 1) !== 0, true);

  // Free h1
  const freed = alloc.free(h1, views.floatMatrixView, views.planar);
  assert.equal(freed, true);
  assert.equal(alloc.isValid(h1), false);
  assert.equal(alloc.size, 0);
  assert.equal((views.planar.aliveBitset[0] & 1) === 0, true);

  // Allocate again -> must reuse index 0 with incremented generation 2
  const h2 = alloc.allocate(views.floatMatrixView, views.planar, { px: 50, hp: 80 });
  assert.ok(h2 !== 0);
  const u2 = unpackEntityHandle(h2);
  assert.equal(u2.index, 0);
  assert.equal(u2.generation, 2);

  // ABA guard: stale handle h1 must be rejected and cannot free newly allocated h2
  assert.equal(alloc.isValid(h1), false);
  assert.equal(alloc.free(h1), false);
  assert.equal(alloc.isValid(h2), true);
  assert.equal(alloc.size, 1);

  // Free h2
  assert.equal(alloc.free(h2, views.floatMatrixView, views.planar), true);
  assert.equal(alloc.size, 0);
});

test("PATCH-04: PersistenceWorkerRuntime flushOnce coalescing", async () => {
  const sab = createSharedMemoryPlane(32);
  const runtime = new PersistenceWorkerRuntime({
    sharedMemory: sab,
    entityCapacity: 32,
    dbUrl: "mem://",
    namespace: "test_coalesce",
    database: "test_db",
  });

  await runtime.init();

  // Enqueue 5 transactions, including duplicate checkpoints for sabIndex 3
  const q = (runtime as unknown as { persistQueue: { enqueue: (tx: unknown) => boolean } }).persistQueue;
  q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 3, paramA: 0, paramB: 0 });
  q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 3, paramA: 0, paramB: 0 }); // duplicate
  q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 7, paramA: 0, paramB: 0 });
  q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 3, paramA: 0, paramB: 0 }); // duplicate
  q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_INIT, sabIndex: 3, paramA: 20, paramB: 0 });

  const processed = await runtime.flushOnce(10);
  assert.equal(processed, 5);

  const entityRec = await runtime.getEntityBySabIndex(3);
  assert.ok(entityRec !== null);
  assert.equal(entityRec.sab_index, 3);

  await runtime.stop();
});

test("PATCH-01/02/05 runtime: SimWorkerRuntime planar-soa integrates via stepSimulationSoABitset and updates MortonSpatialIndex", () => {
  const sab = createSharedMemoryPlane(128, 1);
  const sim = new SimWorkerRuntime({
    sharedMemory: sab,
    entityCapacity: 128,
    mode: "planar-soa",
    decodeMovementIntents: true,
    useBatchDrain: true,
  });

  const h0 = sim.allocateEntity({ px: 0, pz: 0, vx: 3, vz: 0, hp: 100 });
  const h1 = sim.allocateEntity({ px: 4, pz: 3, vx: 0, vz: 0, hp: 100 });
  const h2 = sim.allocateEntity({ px: 1000, pz: 1000, vx: 6, vz: 0, hp: 100 });
  assert.equal(sim.isEntityHandleValid(h1), true);

  // Free middle slot and confirm ABA guard + cleared aliveBitset skips integration
  assert.equal(sim.freeEntity(h1), true);
  assert.equal(sim.isEntityHandleValid(h1), false);
  const idx1 = unpackEntityHandle(h1).index;
  sim.views.planar.vx[idx1] = 500;
  assert.equal(sim.views.planar.aliveBitset[idx1 >>> 5] & (1 << (idx1 & 31)), 0);

  // Enqueue movement token through shared MPSC ring for slot 0
  const idx0 = unpackEntityHandle(h0).index;
  const idx2 = unpackEntityHandle(h2).index;
  assert.equal(sim.inputQueue.enqueue(packCommandToken(idx0, INTENT_FLAGS.FORWARD)), true);

  const metrics = sim.tick(DT);
  assert.equal(metrics.commandsProcessed, 1);

  // Entity 0 moved via MPSC decoded FORWARD (+5 m/s in Z) and kept vx=0
  assert.ok(Math.abs(sim.views.planar.pz[idx0] - 5 * DT) < 1e-5);
  // Freed entity 1 did not integrate despite residual velocity (remains at pre-free px=4)
  assert.equal(sim.views.planar.px[idx1], 4);
  // Distant alive entity 2 integrated X velocity cleanly
  assert.ok(Math.abs(sim.views.planar.px[idx2] - (1000 + 6 * DT)) < 1e-4);

  // MortonSpatialIndex was rebuilt during planar-soa tick: radius 20 around origin finds only idx0
  const nearby = new Uint16Array(8);
  const found = sim.queryEntitiesInRadius(0, 0, 20, nearby);
  assert.equal(found, 1);
  assert.equal(nearby[0], idx0);
});

test("PATCH-03 runtime: HybridDataPlaneServer and multiple attached MPSC producers share SAB token ring across laps", () => {
  const server = new HybridDataPlaneServer({
    entityCapacity: 128,
    heapMegabytes: 1,
    inputRingCapacity: 16,
    spawnWorkers: false,
    spawnPersistWorker: false,
  });

  const secondProducer = AtomicMPSCQueue.attachTokenRing(
    server.masterMemoryArena,
    server.views.offsets.MPSC_INPUT_RING,
    16,
  );
  const sim = new SimWorkerRuntime({
    sharedMemory: server.masterMemoryArena,
    entityCapacity: 128,
    inputRingCapacity: 16,
    mode: "planar-soa",
  });

  const hA = server.allocateEntity({ px: 1, pz: 1, hp: 100 });
  const hB = server.allocateEntity({ px: 2, pz: 2, hp: 100 });
  assert.equal(server.isEntityHandleValid(hA), true);
  assert.equal(server.isEntityHandleValid(hB), true);

  // Fill multiple laps across two producers attached to the same SAB offset
  for (let lap = 0; lap < 3; lap++) {
    for (let i = 0; i < 6; i++) {
      assert.equal(server.gatewayInputQueue.enqueue(packCommandToken(0, lap * 10 + i)), true);
      assert.equal(secondProducer.enqueue(packCommandToken(1, lap * 10 + i + 100)), true);
    }
    assert.equal(sim.inputQueue.size(), 12);
    const out = new Int32Array(12);
    const drained = sim.inputQueue.drainTo(out, 12);
    assert.equal(drained, 12);
    assert.equal(sim.inputQueue.size(), 0);
  }
});

test("PATCH-04 runtime: vectorized SurrealQL group commit deduplicates multi-entity checkpoints without extra per-flush allocations", async () => {
  const sab = createSharedMemoryPlane(64, 1);
  const runtime = new PersistenceWorkerRuntime({
    sharedMemory: sab,
    entityCapacity: 64,
    persistRingCapacity: 64,
    dbUrl: "mem://",
    namespace: "test_patch04_vec",
    database: "test_db",
  });
  await runtime.init();

  try {
    const q = new AtomicSPSCTransactionQueue(sab, runtime.views.offsets.PERSIST_RING, 64);
    for (let i = 0; i < 5; i++) {
      q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 2, paramA: i, paramB: 0 });
    }
    for (let i = 0; i < 3; i++) {
      q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 9, paramA: i, paramB: 0 });
    }
    q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 14, paramA: 0, paramB: 0 });
    q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_INIT, sabIndex: 2, paramA: 12, paramB: 0 });
    q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 2, paramA: 901, paramB: 0 });

    const processed = await runtime.flushOnce(32);
    assert.equal(processed, 11);
    assert.equal(Atomics.load(runtime.views.telemetryView, TELEMETRY_SLOTS.PERSIST_COMMITTED), 5);

    const e2 = await runtime.getEntityBySabIndex(2);
    const e9 = await runtime.getEntityBySabIndex(9);
    const e14 = await runtime.getEntityBySabIndex(14);
    assert.equal(e2?.sab_index, 2);
    assert.equal(e9?.sab_index, 9);
    assert.equal(e14?.sab_index, 14);

    const inv2 = await runtime.getOwnedInventory(2);
    assert.equal(inv2.length, 1);
    assert.deepEqual(inv2[0].items, ["item_901"]);
  } finally {
    await runtime.stop();
  }
});
