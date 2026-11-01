/**
 * The persistence worker's ledger must survive a restart when it runs on a durable
 * engine. `mem://` (the default) is volatile, so this exercises `rocksdb:` in a temp dir.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistenceWorkerRuntime } from "../src/persist-worker.js";
import { createSharedMemoryPlane } from "../src/sab-store.js";
import { AtomicSPSCTransactionQueue, PERSIST_TX_KIND } from "../src/lockless-ring.js";
import { rocksdbUrl } from "../src/persist/world-catalog.js";

describe("persistence worker durability", () => {
  it("keeps checkpoints and inventory across a restart on a rocksdb engine", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-durable-"));
    const dbUrl = rocksdbUrl(path.join(dir, "db"));
    try {
      const sab = createSharedMemoryPlane(128, 1);
      const first = new PersistenceWorkerRuntime({ sharedMemory: sab, entityCapacity: 128, dbUrl });
      await first.init();
      const q = new AtomicSPSCTransactionQueue(sab, first.views.offsets.PERSIST_RING, 512);
      q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_INIT, sabIndex: 3, paramA: 10, paramB: 0 });
      q.enqueue({ kind: PERSIST_TX_KIND.INVENTORY_ADD_ITEM, sabIndex: 3, paramA: 4242, paramB: 0 });
      q.enqueue({ kind: PERSIST_TX_KIND.ENTITY_CHECKPOINT, sabIndex: 3, paramA: 0, paramB: 0 });
      assert.equal(await first.drainPendingTransactions(), 3);
      await first.stop();

      const second = new PersistenceWorkerRuntime({ sharedMemory: sab, entityCapacity: 128, dbUrl });
      await second.init();
      try {
        const entity = await second.getEntityBySabIndex(3);
        assert.ok(entity, "entity checkpoint survives restart");
        const inv = await second.getOwnedInventory(3);
        assert.equal(inv.length, 1);
        assert.deepEqual(inv[0].items, ["item_4242"]);
      } finally {
        await second.stop();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
