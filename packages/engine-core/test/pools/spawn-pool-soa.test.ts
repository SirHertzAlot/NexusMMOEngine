import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_L2_CACHE_BYTES,
  DEFAULT_POOL_CAPACITY,
  INVALID_POOL_HANDLE,
  PoolSlotFlags,
  RespawnKind,
  SlotState,
  SPAWN_POOL_HEADER_BYTES,
  SPAWN_POOL_MAGIC,
  SPAWN_POOL_VERSION,
  SpawnPoolSoA,
  exportNativePoolSoA,
  fnv1a32,
  packPoolHandle,
  scanReadySlotsSoA,
  unpackPoolHandle,
} from "../../src/pools/index.js";

describe("SpawnPoolSoA & Native Pool Bridge (Track P1)", () => {
  it("allocates default 16,384-slot L2-resident SAB with 8-byte aligned columns", () => {
    const pool = new SpawnPoolSoA();
    assert.equal(pool.capacity, DEFAULT_POOL_CAPACITY);
    assert.ok(pool.sab instanceof SharedArrayBuffer);
    assert.ok(
      pool.byteLength <= DEFAULT_L2_CACHE_BYTES,
      `default pool (${pool.byteLength} bytes) must fit inside L2 budget (${DEFAULT_L2_CACHE_BYTES} bytes)`,
    );

    // Every Float64 / Float32 / Int32 / Uint16 / Uint8 column must be 8-byte aligned
    const columns = [
      pool.kind,
      pool.state,
      pool.flags,
      pool.generation,
      pool.keyStrLen,
      pool.anchorIndex,
      pool.keyHash,
      pool.modelHash,
      pool.archetypeHash,
      pool.keyStrOffset,
      pool.liveEid,
      pool.stock,
      pool.maxStock,
      pool.homeX,
      pool.homeY,
      pool.homeZ,
      pool.footprintRadiusM,
      pool.respawnDelayMs,
      pool.respawnAtMs,
    ];
    for (const col of columns) {
      assert.equal(col.buffer, pool.sab);
      assert.equal(col.byteOffset % 8, 0, `column offset ${col.byteOffset} must be 8-byte aligned`);
    }

    const stats = pool.utilizationStats();
    assert.equal(stats.capacity, DEFAULT_POOL_CAPACITY);
    assert.equal(stats.activeCount, 0);
    assert.equal(stats.byteLength, pool.byteLength);
    assert.equal(stats.maxBudgetBytes, DEFAULT_L2_CACHE_BYTES);
    assert.ok(stats.utilizationPct > 0 && stats.utilizationPct <= 100);
  });

  it("enforces L2 cache budget guard on oversized capacity or tight budget", () => {
    assert.throws(
      () => new SpawnPoolSoA({ capacity: 32_768 }),
      /L2 budget|exceeding/i,
    );
    assert.throws(
      () => new SpawnPoolSoA({ capacity: 64, maxBudgetBytes: 512 }),
      /L2 budget|exceeding/i,
    );
    // Explicitly overriding maxBudgetBytes permits larger capacities up to 65,536
    const large = new SpawnPoolSoA({
      capacity: 32_768,
      maxBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal(large.capacity, 32_768);
    assert.ok(large.byteLength > DEFAULT_L2_CACHE_BYTES);
  });

  it("enforces ABA generation check and 65535 -> 1 wrap across full cycle", () => {
    const pool = new SpawnPoolSoA({ capacity: 4, keyBufferBytes: 1024 });
    // Keep one live slot in slot 0 so compaction is also exercised mid-cycle.
    const anchor = pool.allocateSlot({
      key: "anchor-keep-alive",
      kind: RespawnKind.CivicVein,
      homeX: 1,
      homeZ: 2,
    });
    assert.notEqual(anchor, INVALID_POOL_HANDLE);

    let lastHandle = INVALID_POOL_HANDLE;
    let saw65535 = false;
    for (let cycle = 1; cycle <= 65_536; cycle++) {
      const h = pool.allocateSlot({
        key: `aba_${cycle}`,
        kind: RespawnKind.Creature,
        homeX: 10,
        homeZ: 20,
      });
      assert.notEqual(h, INVALID_POOL_HANDLE);
      const { index, generation } = unpackPoolHandle(h);
      assert.equal(index, 1);
      if (cycle <= 65_535) {
        assert.equal(generation, cycle);
        if (generation === 65_535) saw65535 = true;
      } else {
        // Wrapped cleanly 65535 -> 1 (never 0)
        assert.equal(generation, 1);
      }
      if (lastHandle !== INVALID_POOL_HANDLE) {
        assert.equal(pool.isValidHandle(lastHandle), false);
        assert.equal(pool.freeSlot(lastHandle), false);
        assert.equal(pool.scheduleRespawn(lastHandle, 1000), false);
        assert.equal(pool.markActive(lastHandle, 99), false);
        assert.equal(pool.decrementStock(lastHandle, 1, 1000), -1);
      }
      assert.equal(pool.freeSlot(h), true);
      lastHandle = h;
    }

    assert.equal(saw65535, true);
    assert.equal(pool.generation[1], 2);
    assert.equal(pool.isValidHandle(lastHandle), false);
    assert.equal(pool.isValidHandle(anchor), true);
    assert.equal(pool.getKey(anchor), "anchor-keep-alive");
    assert.equal(pool.activeCount, 1);
  });

  it("enforces full-capacity and duplicate live key guards cleanly", () => {
    const pool = new SpawnPoolSoA({ capacity: 3, keyBufferBytes: 512 });

    const h0 = pool.allocateSlot({ key: "node-a", kind: RespawnKind.ResourceNode, stock: 3 });
    const h1 = pool.allocateSlot({ key: "node-b", kind: RespawnKind.Chest });
    const h2 = pool.allocateSlot({ key: "node-c", kind: RespawnKind.BreakableProp });
    assert.notEqual(h0, INVALID_POOL_HANDLE);
    assert.notEqual(h1, INVALID_POOL_HANDLE);
    assert.notEqual(h2, INVALID_POOL_HANDLE);
    assert.equal(pool.isFull, true);

    // Full capacity returns INVALID_POOL_HANDLE (0) without throwing or corrupting
    const overflow = pool.allocateSlot({ key: "node-d", kind: RespawnKind.Creature });
    assert.equal(overflow, INVALID_POOL_HANDLE);
    assert.equal(pool.activeCount, 3);

    // Duplicate live key throws
    assert.throws(
      () => pool.allocateSlot({ key: "node-b", kind: RespawnKind.Chest }),
      /duplicate live key/i,
    );

    // Invalid inputs rejected fail-closed
    assert.throws(() => pool.allocateSlot({ key: "", kind: RespawnKind.Creature }));
    assert.throws(() => pool.allocateSlot({ key: "bad-x", kind: RespawnKind.Creature, homeX: Number.NaN }));
    assert.throws(() => pool.allocateSlot({ key: "bad-r", kind: RespawnKind.Creature, footprintRadiusM: -1 }));
    assert.throws(() => pool.allocateSlot({ key: "bad-d", kind: RespawnKind.Creature, respawnDelayMs: -5 }));

    // Freeing allows reallocation of the same key or a new key with bumped generation
    assert.equal(pool.freeSlot(h1), true);
    assert.equal(pool.findByKey("node-b"), INVALID_POOL_HANDLE);
    assert.equal(pool.isFull, false);

    const h1Reborn = pool.allocateSlot({ key: "node-b", kind: RespawnKind.Chest });
    assert.notEqual(h1Reborn, INVALID_POOL_HANDLE);
    assert.notEqual(h1Reborn, h1);
    assert.equal(unpackPoolHandle(h1Reborn).index, unpackPoolHandle(h1).index);
    assert.equal(unpackPoolHandle(h1Reborn).generation, unpackPoolHandle(h1).generation + 1);
    assert.equal(pool.findSlotByKey("node-b"), h1Reborn);
    assert.equal(pool.findByKeyHash(fnv1a32("node-b")), h1Reborn);
  });

  it("rolls back slot allocation cleanly if key intern buffer overflows", () => {
    const pool = new SpawnPoolSoA({ capacity: 4, keyBufferBytes: 16 });
    const h0 = pool.allocateSlot({ key: "1234567890", kind: RespawnKind.Creature }); // 10 bytes
    assert.notEqual(h0, INVALID_POOL_HANDLE);
    assert.throws(
      () => pool.allocateSlot({ key: "too-long-for-16", kind: RespawnKind.Creature }),
      /key intern buffer exhausted/i,
    );
    assert.equal(pool.activeCount, 1);
    assert.equal(pool.highWater, 1);
    assert.equal(pool.freeCount, 0);

    // A short key still fits in remaining 6 bytes
    const h1 = pool.allocateSlot({ key: "ok_key", kind: RespawnKind.Creature });
    assert.notEqual(h1, INVALID_POOL_HANDLE);
    assert.equal(pool.activeCount, 2);
  });

  it("handles scheduleRespawn, pollReady clock determinism, kindFilter, claim, and markActive", () => {
    const pool = new SpawnPoolSoA({ capacity: 16 });
    const hMob = pool.allocateSlot({
      key: "mob:wolf:1",
      kind: RespawnKind.Creature,
      liveEid: 101,
      respawnDelayMs: 5000,
    });
    const hNode = pool.allocateSlot({
      key: "tree:oak:1",
      kind: RespawnKind.ResourceNode,
      liveEid: 102,
      respawnDelayMs: 10000,
    });
    const hChest = pool.allocateSlot({
      key: "chest:keep:1",
      kind: RespawnKind.Chest,
      liveEid: 103,
      respawnDelayMs: 3000,
    });

    assert.equal(pool.scheduleRespawn(hMob, 1000), true); // ready at 6000
    assert.equal(pool.scheduleRespawn(hNode, 1000, 2000), true); // override ready at 3000
    assert.equal(pool.scheduleRespawn(hChest, 1000), true); // ready at 4000

    const mobIdx = pool.slotIndexOf(hMob);
    const nodeIdx = pool.slotIndexOf(hNode);
    const chestIdx = pool.slotIndexOf(hChest);

    assert.equal(pool.state[mobIdx], SlotState.CooldownRespawn);
    assert.equal(pool.liveEid[mobIdx], -1);
    assert.equal(pool.respawnAtMs[mobIdx], 6000);

    const out = new Int32Array(8);
    assert.equal(pool.pollReady(2999, out), 0);
    assert.equal(pool.pollReady(Number.NaN, out), 0);

    // At 3000ms: only ResourceNode ready
    assert.equal(pool.pollReady(3000, out), 1);
    assert.equal(out[0], nodeIdx);
    assert.equal(pool.pollReady(3000, out, RespawnKind.Creature), 0);
    assert.equal(pool.pollReady(3000, out, RespawnKind.ResourceNode), 1);

    // At 6000ms: all 3 ready; test kindFilter
    assert.equal(pool.pollReady(6000, out, RespawnKind.Chest), 1);
    assert.equal(out[0], chestIdx);
    assert.equal(pool.pollReady(6000, out, 0), 3);
    assert.deepEqual([...out.subarray(0, 3)], [mobIdx, nodeIdx, chestIdx]);

    // Test bounded output buffer + atomic claim mode
    const smallOut = new Int32Array(2);
    assert.equal(pool.pollReady(6000, smallOut, 0, true), 2);
    assert.deepEqual([...smallOut], [mobIdx, nodeIdx]);
    assert.equal(pool.state[mobIdx], SlotState.Locked);
    assert.ok(Number.isNaN(pool.respawnAtMs[mobIdx]!));
    assert.equal(pool.pollReady(6000, smallOut, 0, true), 1);
    assert.equal(smallOut[0], chestIdx);
    assert.equal(pool.pollReady(6000, smallOut, 0, true), 0);

    // markActive brings slot back to Active and clears respawnAtMs
    assert.equal(pool.markActive(hMob, 555, 1), true);
    assert.equal(pool.state[mobIdx], SlotState.Active);
    assert.equal(pool.liveEid[mobIdx], 555);
    assert.equal(pool.stock[mobIdx], 1);
    assert.ok(Number.isNaN(pool.respawnAtMs[mobIdx]!));
  });

  it("transitions decrementStock to CooldownRespawn vs Exhausted cleanly", () => {
    const pool = new SpawnPoolSoA({ capacity: 8 });
    const hRegrow = pool.allocateSlot({
      key: "vein:regrow",
      kind: RespawnKind.CivicVein,
      stock: 3,
      maxStock: 3,
      respawnDelayMs: 4000,
    });
    const hFinite = pool.allocateSlot({
      key: "vein:finite",
      kind: RespawnKind.CivicVein,
      stock: 2,
      maxStock: 2,
      respawnDelayMs: 0,
    });

    assert.equal(pool.decrementStock(hRegrow, 1, 10_000), 2);
    assert.equal(pool.state[pool.slotIndexOf(hRegrow)], SlotState.Active);
    // Clamps >= 0 even if delta > stock
    assert.equal(pool.decrementStock(hRegrow, 10, 10_500), 0);
    assert.equal(pool.stock[pool.slotIndexOf(hRegrow)], 0);
    assert.equal(pool.state[pool.slotIndexOf(hRegrow)], SlotState.CooldownRespawn);
    assert.equal(pool.respawnAtMs[pool.slotIndexOf(hRegrow)], 14_500);

    // Finite slot (respawnDelayMs === 0) goes to Exhausted
    assert.equal(pool.decrementStock(hFinite, 2, 10_500), 0);
    assert.equal(pool.state[pool.slotIndexOf(hFinite)], SlotState.Exhausted);
    assert.ok(Number.isNaN(pool.respawnAtMs[pool.slotIndexOf(hFinite)]!));
  });

  it("round-trips binary MMOS v1 with key lookup restoration, UTF-8 keys, and holes", () => {
    const pool = new SpawnPoolSoA({ capacity: 32, keyBufferBytes: 4096 });
    const h1 = pool.allocateSlot({
      key: "creature:boar:α",
      kind: RespawnKind.Creature,
      flags: PoolSlotFlags.Baseline | PoolSlotFlags.Persistent,
      modelId: "animals/SM_Boar_01",
      archetypeId: "boar",
      liveEid: 11,
      stock: 1,
      maxStock: 1,
      anchorIndex: 2,
      homeX: 12.5,
      homeY: 3.25,
      homeZ: -48.75,
      footprintRadiusM: 1.4,
      respawnDelayMs: 15_000,
    });
    const hHole = pool.allocateSlot({
      key: "temp-hole",
      kind: RespawnKind.BreakableProp,
    });
    const h2 = pool.allocateSlot({
      key: "vein:east-gorge:0",
      kind: RespawnKind.CivicVein,
      flags: PoolSlotFlags.Aquatic,
      modelHash: fnv1a32("rocks/SM_OreVein_02"),
      archetypeHash: fnv1a32("east-gorge-vein"),
      stock: 4,
      maxStock: 8,
      anchorIndex: 7,
      homeX: -120.25,
      homeY: 0.5,
      homeZ: 230.125,
      footprintRadiusM: 2.75,
      respawnDelayMs: 60_000,
    });
    pool.scheduleRespawn(h2, 100_000);
    // Free middle slot to create a free hole + bumped generation
    assert.equal(pool.freeSlot(hHole), true);

    const bytes = pool.encodeBinary();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, SPAWN_POOL_HEADER_BYTES);
    assert.equal(dv.getUint32(0, true), SPAWN_POOL_MAGIC);
    assert.equal(dv.getUint32(4, true), SPAWN_POOL_VERSION);

    // Decode from a deliberately misaligned Uint8Array slice (byteOffset % 8 !== 0)
    const padded = new Uint8Array(bytes.byteLength + 3);
    padded.set(bytes, 3);
    const misalignedView = padded.subarray(3, 3 + bytes.byteLength);

    const restored = SpawnPoolSoA.decodeBinary(misalignedView);
    assert.equal(restored.capacity, 32);
    assert.equal(restored.activeCount, 2);
    assert.equal(restored.highWater, 3);
    assert.equal(restored.freeCount, 1);

    const r1 = restored.findByKey("creature:boar:α");
    const r2 = restored.findByKey("vein:east-gorge:0");
    assert.equal(r1, h1);
    assert.equal(r2, h2);
    assert.equal(restored.findByKey("temp-hole"), INVALID_POOL_HANDLE);
    assert.equal(restored.findByKeyHash(fnv1a32("creature:boar:α")), r1);

    const i1 = restored.slotIndexOf(r1);
    assert.equal(restored.kind[i1], RespawnKind.Creature);
    assert.equal(restored.state[i1], SlotState.Active);
    assert.equal(restored.flags[i1], PoolSlotFlags.Baseline | PoolSlotFlags.Persistent);
    assert.equal(restored.modelHash[i1], fnv1a32("animals/SM_Boar_01"));
    assert.equal(restored.archetypeHash[i1], fnv1a32("boar"));
    assert.equal(restored.liveEid[i1], 11);
    assert.equal(restored.anchorIndex[i1], 2);
    assert.equal(restored.homeX[i1], 12.5);
    assert.equal(restored.homeY[i1], 3.25);
    assert.equal(restored.homeZ[i1], -48.75);
    assert.equal(restored.footprintRadiusM[i1], Math.fround(1.4));
    assert.equal(restored.respawnDelayMs[i1], 15_000);
    assert.ok(Number.isNaN(restored.respawnAtMs[i1]!));

    const i2 = restored.slotIndexOf(r2);
    assert.equal(restored.state[i2], SlotState.CooldownRespawn);
    assert.equal(restored.flags[i2], PoolSlotFlags.Aquatic | PoolSlotFlags.Dirty);
    assert.equal(restored.respawnAtMs[i2], 160_000);
    assert.equal(restored.stock[i2], 4);
    assert.equal(restored.maxStock[i2], 8);

    // Free slot hole must be reused on next allocation with generation 2
    const holeIdx = unpackPoolHandle(hHole).index;
    const hReused = restored.allocateSlot({ key: "reused-hole", kind: RespawnKind.Resident });
    assert.equal(unpackPoolHandle(hReused).index, holeIdx);
    assert.equal(unpackPoolHandle(hReused).generation, 2);

    // Empty 0-count binary roundtrip
    const empty = new SpawnPoolSoA({ capacity: 16 });
    const emptyBytes = empty.encodeBinary();
    assert.equal(emptyBytes.byteLength, SPAWN_POOL_HEADER_BYTES);
    const emptyRestored = SpawnPoolSoA.decodeBinary(emptyBytes);
    assert.equal(emptyRestored.activeCount, 0);
    assert.equal(emptyRestored.capacity, 16);

    // Resize capacity during decodeBinary (shrink to highWater and expand above)
    const shrunk = SpawnPoolSoA.decodeBinary(bytes, { capacity: 4 });
    assert.equal(shrunk.capacity, 4);
    assert.equal(shrunk.findByKey("vein:east-gorge:0"), r2);
    assert.throws(() => SpawnPoolSoA.decodeBinary(bytes, { capacity: 2 }), /invalid for highWater/i);
    assert.throws(() => SpawnPoolSoA.decodeBinary(bytes, { maxBudgetBytes: 256 }), /L2 budget|exceeding/i);
  });

  it("rejects corrupt magic, version, truncated, trailing, and single-bit-flipped binaries fail-closed", () => {
    const pool = new SpawnPoolSoA({ capacity: 8, keyBufferBytes: 1024 });
    pool.allocateSlot({ key: "chest:1", kind: RespawnKind.Chest, homeX: 5, homeZ: 9 });
    const valid = pool.encodeBinary();

    // Truncated header & body
    assert.throws(() => SpawnPoolSoA.decodeBinary(valid.subarray(0, 12)), /truncated/i);
    assert.throws(() => SpawnPoolSoA.decodeBinary(valid.subarray(0, valid.byteLength - 1)), /length mismatch/i);

    // Trailing byte
    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(valid, 0);
    assert.throws(() => SpawnPoolSoA.decodeBinary(trailing), /length mismatch/i);

    // Bad magic
    const badMagic = valid.slice();
    badMagic[0] ^= 0xff;
    assert.throws(() => SpawnPoolSoA.decodeBinary(badMagic), /magic/i);

    // Bad version
    const badVer = valid.slice();
    new DataView(badVer.buffer).setUint32(4, 99, true);
    assert.throws(() => SpawnPoolSoA.decodeBinary(badVer), /version/i);

    // Single bit flip in header field (e.g. capacity), bodyBytes, SoA column, and key bytes
    for (const bytePos of [8, 44, SPAWN_POOL_HEADER_BYTES, valid.byteLength - 2]) {
      const corrupted = valid.slice();
      corrupted[bytePos] ^= 0x01;
      assert.throws(
        () => SpawnPoolSoA.decodeBinary(corrupted),
        /checksum|length mismatch/i,
        `expected failure when flipping bit at offset ${bytePos}`,
      );
    }
  });

  it("attaches via fromSharedBuffer and matches native-pool-bridge bundle + scanReadySlotsSoA", () => {
    const pool = new SpawnPoolSoA({ capacity: 16, keyBufferBytes: 2048 });
    const bundle = exportNativePoolSoA(pool);

    assert.equal(bundle.capacity, 16);
    assert.equal(bundle.sab, pool.sab);
    assert.equal(bundle.kind, pool.kind);
    assert.equal(bundle.state, pool.state);
    assert.equal(bundle.flags, pool.flags);
    assert.equal(bundle.liveEid, pool.liveEid);
    assert.equal(bundle.stock, pool.stock);
    assert.equal(bundle.homeX, pool.homeX);
    assert.equal(bundle.homeY, pool.homeY);
    assert.equal(bundle.homeZ, pool.homeZ);
    assert.equal(bundle.footprintRadiusM, pool.footprintRadiusM);
    assert.equal(bundle.respawnAtMs, pool.respawnAtMs);

    // Mutate pool AFTER exporting bundle (verifies live highWater coherence!)
    const hA = pool.allocateSlot({
      key: "c:1",
      kind: RespawnKind.Creature,
      respawnDelayMs: 1000,
    });
    const hB = pool.allocateSlot({
      key: "r:1",
      kind: RespawnKind.ResourceNode,
      respawnDelayMs: 2000,
    });
    pool.scheduleRespawn(hA, 5000); // ready at 6000
    pool.scheduleRespawn(hB, 5000); // ready at 7000

    const outPool = new Int32Array(16);
    const outBridge = new Int32Array(16);
    assert.equal(pool.pollReady(6500, outPool, 0), 1);
    assert.equal(scanReadySlotsSoA(bundle, 6500, outBridge, 0), 1);
    assert.equal(outBridge[0], outPool[0]);

    assert.equal(pool.pollReady(7000, outPool, RespawnKind.ResourceNode), 1);
    assert.equal(scanReadySlotsSoA(bundle, 7000, outBridge, RespawnKind.ResourceNode), 1);
    assert.equal(outBridge[0], outPool[0]);

    // Worker-side attachment via fromSharedBuffer
    const attached = SpawnPoolSoA.fromSharedBuffer(pool.sab);
    assert.equal(attached.findByKey("c:1"), hA);
    assert.equal(attached.findByKey("r:1"), hB);

    // External keyBytes copy also works via fromSharedBuffer
    const keyCopy = pool.keyBytes.slice(0, pool.keyBytesUsed);
    const attachedExt = SpawnPoolSoA.fromSharedBuffer(pool.sab, keyCopy);
    assert.equal(attachedExt.findByKey("c:1"), hA);
    assert.equal(packPoolHandle(attached.slotIndexOf(hA), attached.generation[attached.slotIndexOf(hA)]!), hA);
  });

  it("benchmarks 100,000 pollReady & scanReadySlotsSoA calls with zero steady-state allocations", () => {
    const pool = new SpawnPoolSoA({ capacity: 1024 });
    const bundle = exportNativePoolSoA(pool);
    for (let i = 0; i < 500; i++) {
      const h = pool.allocateSlot({
        key: `bench:${i}`,
        kind: ((i % 6) + 1) as RespawnKind,
        respawnDelayMs: 1000 + (i % 50) * 100,
      });
      if (i % 3 === 0) {
        pool.scheduleRespawn(h, 10_000);
      }
    }

    const out = new Int32Array(256);
    // Warm up V8 TurboFan JIT & memoryUsage IC on both branches (kindFilter === 0 and !== 0)
    let warmupHits = 0;
    for (let i = 0; i < 10_000; i++) {
      warmupHits += pool.pollReady(12_000, out, 0);
      warmupHits += scanReadySlotsSoA(bundle, 12_000, out, 0);
      warmupHits += pool.pollReady(12_000, out, RespawnKind.Creature);
      warmupHits += scanReadySlotsSoA(bundle, 12_000, out, RespawnKind.Creature);
    }
    assert.ok(warmupHits > 0);

    const gc = (globalThis as { gc?: () => void }).gc;
    void process.memoryUsage().heapUsed;
    gc?.();
    const heapBefore = process.memoryUsage().heapUsed;

    let totalHits = 0;
    for (let i = 0; i < 100_000; i++) {
      totalHits += pool.pollReady(12_000, out, 0);
    }

    const heapMid = process.memoryUsage().heapUsed;

    let bridgeHits = 0;
    for (let i = 0; i < 100_000; i++) {
      bridgeHits += scanReadySlotsSoA(bundle, 12_000, out, 0);
    }

    const heapAfter = process.memoryUsage().heapUsed;

    assert.ok(totalHits > 0);
    assert.equal(bridgeHits, totalHits);
    // 100k calls with even 1 tiny 16-byte object per call would allocate >= 1.6 MB.
    // Steady-state zero-alloc loop should have <= 16 KB V8 runtime/memoryUsage variance.
    assert.ok(
      heapMid - heapBefore <= 16_384,
      `pollReady steady-state heap delta too large: ${heapMid - heapBefore} bytes`,
    );
    assert.ok(
      heapAfter - heapMid <= 16_384,
      `scanReadySlotsSoA steady-state heap delta too large: ${heapAfter - heapMid} bytes`,
    );
  });
});
