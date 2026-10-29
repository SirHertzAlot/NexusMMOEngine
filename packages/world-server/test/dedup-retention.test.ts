/**
 * op_dedup retention: createdAt stamping + the prune sweep,
 * including the legacy-row backfill (rows written before stamping
 * existed must survive their first sweep with a restarted window).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";

test("memory store: prune removes only rows older than the cutoff", async () => {
  const store = new MemoryWorldStore();
  await store.storeOpResult("op-a", { v: 1 });
  await store.storeOpResults([
    { opId: "op-b", result: { v: 2 } },
    { opId: "op-c", result: { v: 3 } },
  ]);
  assert.equal(await store.pruneOpResults(0), 0, "cutoff at epoch: nothing is older");
  assert.deepEqual(await store.getOpResult("op-a"), { v: 1 });
  const pruned = await store.pruneOpResults(Date.now() + 60_000);
  assert.equal(pruned, 3);
  assert.equal(await store.getOpResult("op-a"), null);
  assert.equal(await store.getOpResult("op-b"), null);
});

const surrealIt = process.env.CI ? test.skip : test;

surrealIt("surreal store: legacy rows are backfilled, not wiped, on the first sweep", async () => {
  const store = new SurrealWorldStore({
    url: "mem://",
    namespace: "test",
    database: `dedup_retention_${Date.now()}`,
  });
  await store.connect();
  try {
    const db = (
      store as unknown as {
        db: { query: (sql: string, vars?: Record<string, unknown>) => Promise<unknown> };
      }
    ).db;
    // A pre-stamping row (no createdAt) and an ancient stamped row.
    await db.query("CREATE op_dedup CONTENT { opId: 'op-legacy', result: { v: 1 } }");
    await db.query(
      "CREATE op_dedup CONTENT { opId: 'op-ancient', result: { v: 2 }, createdAt: 1000 }",
    );
    await store.storeOpResult("op-fresh", { v: 3 });

    const cutoff = Date.parse("2001-01-01T00:00:00Z");
    const pruned = await store.pruneOpResults(cutoff);
    assert.equal(pruned, 1, "only the ancient row is older than the cutoff");
    assert.equal(await store.getOpResult("op-ancient"), null);
    assert.deepEqual(
      await store.getOpResult("op-legacy"),
      { v: 1 },
      "the legacy row survived: backfilled, window restarted",
    );
    assert.deepEqual(await store.getOpResult("op-fresh"), { v: 3 });

    // The backfill really stamped it: a cutoff beyond now prunes it.
    const pruned2 = await store.pruneOpResults(Date.now() + 3600_000);
    assert.equal(pruned2, 2, "legacy (backfilled) + fresh rows now age out");
  } finally {
    await store.close();
  }
});
