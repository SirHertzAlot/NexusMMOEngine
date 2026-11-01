import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PersistenceWorkerRuntime } from "../src/persist-worker.js";
import { createSharedMemoryPlane } from "../src/sab-store.js";
import { AtomicSPSCTransactionQueue, PERSIST_TX_KIND } from "../src/lockless-ring.js";

describe("inventory add", () => {
  it("creates the slot on first add, appends until capacity, and drops adds past it", async () => {
    const sab = createSharedMemoryPlane(16, 1);
    const p = new PersistenceWorkerRuntime({ sharedMemory: sab, entityCapacity: 16, dbUrl: "mem://" });
    await p.init();
    try {
      const q = new AtomicSPSCTransactionQueue(sab, p.views.offsets.PERSIST_RING, 64);
      q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_INIT, sabIndex: 4, paramA: 2, paramB: 0 });
      q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 4, paramA: 1, paramB: 0 });
      q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 4, paramA: 2, paramB: 0 });
      q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 4, paramA: 3, paramB: 0 });
      await p.drainPendingTransactions();
      const inv = await p.getOwnedInventory(4);
      assert.deepEqual(inv[0].items, ["item_1", "item_2"]);
      // An add to a slot that was never initialised creates it with the default capacity.
      q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 9, paramA: 7, paramB: 0 });
      await p.drainPendingTransactions();
      const fresh = await p.getOwnedInventory(9);
      assert.deepEqual(fresh[0].items, ["item_7"]);
    } finally {
      await p.stop();
    }
  });
});
