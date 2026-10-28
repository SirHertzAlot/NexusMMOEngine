/**
 * TDD Test Suite for the Zero-Copy Hybrid Engine Data Plane
 * (ENGINE_IMPLEMENTATION_SPEC.md §§1-7 + DoD Architectural Extensions).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  BYTES_PER_FLOAT,
  CACHE_LINE_BYTES,
  DATA_PLANE_ENTITY_CAPACITY,
  INTENT_FLAGS,
  OFFSETS,
  SOA_LAYOUT,
  TELEMETRY_SLOTS,
  attachSharedMemoryPlane,
  createSharedMemoryPlane,
  syncMatrixToPlanar,
  syncPlanarToMatrix,
} from "../src/sab-store.js";
import {
  AtomicSPSCQueue,
  AtomicSPSCTransactionQueue,
  PERSIST_TX_KIND,
  SPSC_CACHE_LINE_BYTES,
  SPSC_HEADER_BYTES,
  packCommandToken,
  unpackCommandToken,
} from "../src/lockless-ring.js";
import {
  DT,
  SimWorkerRuntime,
  loadNativeKernel,
} from "../src/sim-worker.js";
import { PersistenceWorkerRuntime } from "../src/persist-worker.js";
import {
  HybridDataPlaneServer,
  WS_SIM_ROUTE,
  encodeBinaryCommandBatch,
  encodeBinaryCommandFrame,
} from "../src/data-plane-server.js";

describe("Zero-Copy Hybrid Engine Data Plane (ENGINE_IMPLEMENTATION_SPEC.md)", () => {
  describe("§2 Memory Arena Layout (sab-store.ts)", () => {
    it("allocates Master SharedArrayBuffer with exact spec OFFSETS and 32-byte entity stride", () => {
      assert.equal(SOA_LAYOUT.STRIDE, 8);
      assert.equal(SOA_LAYOUT.STRIDE * BYTES_PER_FLOAT, 32);
      assert.equal(OFFSETS.MATRIX, 0);
      assert.equal(OFFSETS.RINGS, 10_000 * 8 * 4);
      assert.equal(OFFSETS.BAKE, OFFSETS.RINGS + 65_536);

      const sab = createSharedMemoryPlane();
      assert.ok(sab instanceof SharedArrayBuffer);
      assert.equal(sab.byteLength, OFFSETS.BAKE + 32 * 1024 * 1024);

      const views = attachSharedMemoryPlane(sab);
      assert.equal(views.floatMatrixView.byteOffset, 0);
      assert.equal(views.floatMatrixView.length, DATA_PLANE_ENTITY_CAPACITY * SOA_LAYOUT.STRIDE);
      assert.equal(views.intMatrixView.byteOffset, 0);
      assert.equal(views.planar.px.byteOffset % CACHE_LINE_BYTES, 0);
      assert.equal(views.planar.py.byteOffset % CACHE_LINE_BYTES, 0);
      assert.equal(views.planar.pz.byteOffset % CACHE_LINE_BYTES, 0);
    });

    it("synchronizes strided Matrix <-> Planar SoA columns and alive bitset accurately", () => {
      const sab = createSharedMemoryPlane(128, 1);
      const views = attachSharedMemoryPlane(sab, 128);

      // Populate entity 3 (alive) and entity 7 (dead)
      const b3 = 3 * SOA_LAYOUT.STRIDE;
      views.floatMatrixView[b3 + SOA_LAYOUT.POSITION_X] = 10.5;
      views.floatMatrixView[b3 + SOA_LAYOUT.POSITION_Y] = -4.25;
      views.floatMatrixView[b3 + SOA_LAYOUT.POSITION_Z] = 99.0;
      views.floatMatrixView[b3 + SOA_LAYOUT.VELOCITY_X] = 1.5;
      views.intMatrixView[b3 + SOA_LAYOUT.HEALTH] = 100;
      views.intMatrixView[b3 + SOA_LAYOUT.INTENT_BIT] = INTENT_FLAGS.FORWARD;

      const b7 = 7 * SOA_LAYOUT.STRIDE;
      views.floatMatrixView[b7 + SOA_LAYOUT.POSITION_X] = 50.0;
      views.intMatrixView[b7 + SOA_LAYOUT.HEALTH] = 0;

      syncMatrixToPlanar(views, 16);
      assert.equal(views.planar.px[3], 10.5);
      assert.equal(views.planar.py[3], -4.25);
      assert.equal(views.planar.pz[3], 99.0);
      assert.equal(views.planar.vx[3], 1.5);
      assert.equal(views.planar.hp[3], 100);
      assert.equal(views.planar.intent[3], INTENT_FLAGS.FORWARD);
      assert.notEqual(views.planar.aliveBitset[0] & (1 << 3), 0);
      assert.equal(views.planar.aliveBitset[0] & (1 << 7), 0);

      // Mutate planar and sync back
      views.planar.px[3] = 42.0;
      views.planar.hp[3] = 85;
      syncPlanarToMatrix(views, 16);
      assert.equal(views.floatMatrixView[b3 + SOA_LAYOUT.POSITION_X], 42.0);
      assert.equal(views.intMatrixView[b3 + SOA_LAYOUT.HEALTH], 85);
    });
  });

  describe("§3 Lockless Atomic Synchronization Layer (lockless-ring.ts)", () => {
    it("enforces 64-byte cache-line padding and FIFO ring wrap-around without data loss", () => {
      assert.equal(SPSC_CACHE_LINE_BYTES, 64);
      assert.equal(SPSC_HEADER_BYTES, 128);

      const sab = new SharedArrayBuffer(4096);
      const q = new AtomicSPSCQueue(sab, 0, 8); // Usable capacity = 7

      // Saturate queue (7 items)
      for (let i = 1; i <= 7; i++) {
        assert.equal(q.enqueue(i * 10), true);
      }
      assert.equal(q.size(), 7);
      // 8th enqueue must return false (ring full sentinel)
      assert.equal(q.enqueue(999), false);

      // Dequeue 5 items
      for (let i = 1; i <= 5; i++) {
        assert.equal(q.dequeue(), i * 10);
      }
      assert.equal(q.size(), 2);

      // Enqueue 5 more items to exercise wrap-around across ring boundary
      for (let i = 8; i <= 12; i++) {
        assert.equal(q.enqueue(i * 10), true);
      }
      assert.equal(q.size(), 7);

      // Drain remaining 7 items in exact FIFO order
      for (let i = 6; i <= 12; i++) {
        assert.equal(q.dequeue(), i * 10);
      }
      assert.equal(q.dequeue(), null);
      assert.equal(q.size(), 0);
    });

    it("supports single-fence DoD batch enqueueBatch() and drainTo() with zero allocations", () => {
      const sab = new SharedArrayBuffer(8192);
      const q = new AtomicSPSCQueue(sab, 64, 64);

      const batchIn = new Int32Array(32);
      for (let i = 0; i < 32; i++) {
        batchIn[i] = packCommandToken(i + 1, INTENT_FLAGS.FORWARD | INTENT_FLAGS.SPRINT);
      }

      const written = q.enqueueBatch(batchIn);
      assert.equal(written, 32);
      assert.equal(q.size(), 32);

      const batchOut = new Int32Array(64);
      const drained = q.drainTo(batchOut);
      assert.equal(drained, 32);
      assert.equal(q.size(), 0);

      for (let i = 0; i < 32; i++) {
        const decoded = unpackCommandToken(batchOut[i]);
        assert.equal(decoded.entityIndex, i + 1);
        assert.equal(decoded.actionCode, INTENT_FLAGS.FORWARD | INTENT_FLAGS.SPRINT);
      }
    });
  });

  describe("§4 & §5 Native C++ Simulation Core & SimWorkerRuntime (sim-worker.ts)", () => {
    it("loads native C++ kernel, drains SPSC input ring, updates INTENT_BIT, and steps alive entities", () => {
      const kernel = loadNativeKernel();
      assert.equal(kernel.isNative, true, "Expected compiled C++ native engine_kernel.node");

      const sab = createSharedMemoryPlane(256, 1);
      const sim = new SimWorkerRuntime({
        sharedMemory: sab,
        entityCapacity: 256,
        decodeMovementIntents: true,
      });

      const { floatMatrixView, intMatrixView } = sim.views;
      // Entity 10: alive (HP = 100), initial position (1, 2, 3), velocity (3, 0, -6)
      const b10 = 10 * SOA_LAYOUT.STRIDE;
      floatMatrixView[b10 + SOA_LAYOUT.POSITION_X] = 1.0;
      floatMatrixView[b10 + SOA_LAYOUT.POSITION_Y] = 2.0;
      floatMatrixView[b10 + SOA_LAYOUT.POSITION_Z] = 3.0;
      floatMatrixView[b10 + SOA_LAYOUT.VELOCITY_X] = 3.0;
      floatMatrixView[b10 + SOA_LAYOUT.VELOCITY_Y] = 0.0;
      floatMatrixView[b10 + SOA_LAYOUT.VELOCITY_Z] = -6.0;
      intMatrixView[b10 + SOA_LAYOUT.HEALTH] = 100;

      // Entity 11: dead (HP = 0), initial position (50, 50, 50), velocity (100, 100, 100)
      const b11 = 11 * SOA_LAYOUT.STRIDE;
      floatMatrixView[b11 + SOA_LAYOUT.POSITION_X] = 50.0;
      floatMatrixView[b11 + SOA_LAYOUT.POSITION_Y] = 50.0;
      floatMatrixView[b11 + SOA_LAYOUT.POSITION_Z] = 50.0;
      floatMatrixView[b11 + SOA_LAYOUT.VELOCITY_X] = 100.0;
      floatMatrixView[b11 + SOA_LAYOUT.VELOCITY_Y] = 100.0;
      floatMatrixView[b11 + SOA_LAYOUT.VELOCITY_Z] = 100.0;
      intMatrixView[b11 + SOA_LAYOUT.HEALTH] = 0;

      // Enqueue command token for Entity 20 with PERSIST_CHECKPOINT + FORWARD
      const b20 = 20 * SOA_LAYOUT.STRIDE;
      intMatrixView[b20 + SOA_LAYOUT.HEALTH] = 250;
      sim.inputQueue.enqueue(
        packCommandToken(20, INTENT_FLAGS.FORWARD | INTENT_FLAGS.PERSIST_CHECKPOINT),
      );

      const metrics = sim.tick(DT);
      assert.equal(metrics.tick, 1);
      assert.equal(metrics.commandsProcessed, 1);
      assert.equal(metrics.persistEnqueued, 1);
      assert.equal(metrics.budgetOverrun, false);

      // Entity 10 advanced by velocity * DT
      assert.ok(Math.abs(floatMatrixView[b10 + SOA_LAYOUT.POSITION_X] - (1.0 + 3.0 * DT)) < 1e-5);
      assert.ok(Math.abs(floatMatrixView[b10 + SOA_LAYOUT.POSITION_Z] - (3.0 - 6.0 * DT)) < 1e-5);

      // Dead entity 11 did not move
      assert.equal(floatMatrixView[b11 + SOA_LAYOUT.POSITION_X], 50.0);
      assert.equal(floatMatrixView[b11 + SOA_LAYOUT.POSITION_Y], 50.0);
      assert.equal(floatMatrixView[b11 + SOA_LAYOUT.POSITION_Z], 50.0);

      // Entity 20 received INTENT_BIT, decoded FORWARD velocity (+5 Z), and integrated 1 step
      assert.equal(
        intMatrixView[b20 + SOA_LAYOUT.INTENT_BIT],
        INTENT_FLAGS.FORWARD | INTENT_FLAGS.PERSIST_CHECKPOINT,
      );
      assert.ok(Math.abs(floatMatrixView[b20 + SOA_LAYOUT.POSITION_Z] - 5.0 * DT) < 1e-5);

      // Secondary persistence ring received the checkpoint transaction
      const tx = sim.persistQueue.dequeue();
      assert.deepEqual(tx, {
        kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT,
        sabIndex: 20,
        paramA: 250,
        paramB: INTENT_FLAGS.FORWARD | INTENT_FLAGS.PERSIST_CHECKPOINT,
      });
    });
  });

  describe("§7 Persistent Data Plane & Embedded SurrealDB Ledger (persist-worker.ts)", () => {
    it("enforces schema.surrealql constraints, checkpoints entities, and executes ACID inventory transfers", async () => {
      const sab = createSharedMemoryPlane(128, 1);
      const persist = new PersistenceWorkerRuntime({
        sharedMemory: sab,
        entityCapacity: 128,
        dbUrl: "mem://",
      });
      await persist.init();

      try {
        // Enqueue checkpoint + inventory init + item additions + cross-entity transfer
        const q = new AtomicSPSCTransactionQueue(sab, persist.views.offsets.PERSIST_RING, 512);
        q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_INIT, sabIndex: 1, paramA: 10, paramB: 0 });
        q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_INIT, sabIndex: 2, paramA: 10, paramB: 0 });
        q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 1, paramA: 777, paramB: 0 });
        q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 1, paramA: 888, paramB: 0 });
        q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_TRANSFER, sabIndex: 1, paramA: 2, paramB: 777 });

        const committed = await persist.drainPendingTransactions();
        assert.equal(committed, 5);
        assert.equal(
          Atomics.load(persist.views.telemetryView, TELEMETRY_SLOTS.PERSIST_COMMITTED),
          5,
        );

        const entity1 = await persist.getEntityBySabIndex(1);
        const entity2 = await persist.getEntityBySabIndex(2);
        assert.ok(entity1);
        assert.ok(entity2);
        assert.equal(entity1.sab_index, 1);
        assert.equal(entity2.sab_index, 2);

        const inv1 = await persist.getOwnedInventory(1);
        const inv2 = await persist.getOwnedInventory(2);
        assert.equal(inv1.length, 1);
        assert.equal(inv2.length, 1);
        assert.deepEqual(inv1[0].items, ["item_888"]);
        assert.deepEqual(inv2[0].items, ["item_777"]);

        // Schema constraint check: negative sab_index must be rejected by ASSERT $value >= 0
        await assert.rejects(async () => {
          await persist.db.query(`CREATE entity CONTENT { sab_index: -5 };`);
        });

        // Schema constraint check: duplicate sab_index must be rejected by UNIQUE sab_index_idx
        await assert.rejects(async () => {
          await persist.db.query(`CREATE entity CONTENT { sab_index: 1 };`);
        });
      } finally {
        await persist.stop();
      }
    });
  });

  describe("§1 & §6 End-to-End 3-Thread Topology (/ws/sim -> Master -> SimWorker -> PersistWorker)", () => {
    it("ingests 4-byte binary WebSocket frames and propagates state across all 3 threads without locks", async () => {
      const server = new HybridDataPlaneServer({
        port: 0,
        entityCapacity: 512,
        heapMegabytes: 2,
        simAutoStart: false, // Drive deterministic ticks via stepSimWorker()
        simMode: "fused-intents",
        dbUrl: "mem://",
      });

      const port = await server.listen(0);
      assert.ok(port > 0);

      try {
        // Initialize Entity 42 as alive (HP = 500) in SharedArrayBuffer
        const b42 = 42 * SOA_LAYOUT.STRIDE;
        server.views.intMatrixView[b42 + SOA_LAYOUT.HEALTH] = 500;

        // Connect binary WebSocket client to /ws/sim
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_SIM_ROUTE}`);
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });

        // Send 4-byte binary packet: [Uint16 entityIndex = 42, Uint16 actionCode = FORWARD | SPRINT | PERSIST_CHECKPOINT]
        const actionMask =
          INTENT_FLAGS.FORWARD | INTENT_FLAGS.SPRINT | INTENT_FLAGS.PERSIST_CHECKPOINT;
        const packet = encodeBinaryCommandFrame(42, actionMask);
        assert.equal(packet.byteLength, 4);
        ws.send(packet);

        // Also send a batch of 2 commands (8 bytes) for entities 10 and 11
        server.views.intMatrixView[10 * SOA_LAYOUT.STRIDE + SOA_LAYOUT.HEALTH] = 100;
        server.views.intMatrixView[11 * SOA_LAYOUT.STRIDE + SOA_LAYOUT.HEALTH] = 100;
        ws.send(
          encodeBinaryCommandBatch([
            { entityIndex: 10, actionCode: INTENT_FLAGS.RIGHT },
            { entityIndex: 11, actionCode: INTENT_FLAGS.LEFT },
          ]),
        );

        // Wait until Master Thread enqueues the 3 commands into the lockless ring
        const deadline = Date.now() + 2000;
        while (server.stats.ingestedFrames < 3 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5));
        }
        assert.equal(server.stats.ingestedFrames, 3);

        // Step the background Simulation Worker Thread (executes C++ applyIntentsAndStep)
        await server.stepSimWorker(DT);

        // Verify Entity 42 moved forward at sprint speed (baseSpeed 5 * 2 = 10, dz = 10 * DT)
        const pz42 = server.views.floatMatrixView[b42 + SOA_LAYOUT.POSITION_Z];
        assert.ok(Math.abs(pz42 - 10.0 * DT) < 1e-4, `Expected pz42 ~ ${10.0 * DT}, got ${pz42}`);
        assert.equal(server.views.intMatrixView[b42 + SOA_LAYOUT.INTENT_BIT], actionMask);

        // Flush the background Persistence Worker Thread and verify SurrealDB committed the checkpoint
        await server.flushPersistWorker();
        const stats = server.stats;
        assert.equal(stats.tickCount, 1);
        assert.equal(stats.commandsProcessed, 3);
        assert.equal(stats.persistEnqueued, 1);
        assert.ok(stats.persistCommitted >= 1);

        ws.close();
      } finally {
        await server.close();
      }
    });
  });
});
