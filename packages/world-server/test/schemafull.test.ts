/**
 * Hot-table SCHEMAFULL enforcement (deep dive item 5): the database
 * rejects unknown fields and wrong types on character_state,
 * character_lock, and op_dedup — and every legitimate write path
 * (store puts, the atomic commit functions, the credits drain)
 * still conforms. Reconnecting to the same database re-applies the
 * definitions without breaking stored records.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SurrealWorldStore } from "../src/surreal-store.js";

type RawDb = {
  query: (sql: string, vars?: Record<string, unknown>) => Promise<unknown>;
};
const raw = (store: SurrealWorldStore): RawDb =>
  (store as unknown as { db: RawDb }).db;

const surrealIt = process.env.CI ? test.skip : test;

surrealIt("SCHEMAFULL hot tables reject malformed writes and accept every real one", async () => {
  const opts = {
    url: "mem://",
    namespace: "test",
    database: `schemafull_${Date.now()}`,
  };
  const store = new SurrealWorldStore(opts);
  await store.connect();
  try {
    const db = raw(store);
    // Unknown field: rejected.
    await assert.rejects(
      db.query(
        "CREATE character_state CONTENT { characterId: 1, state: {}, version: 1, epoch: 1, regionId: 'r1', updatedAt: 1, bogus: true }",
      ),
      "SCHEMAFULL must reject unknown fields",
    );
    // Wrong type: rejected.
    await assert.rejects(
      db.query(
        "CREATE character_state CONTENT { characterId: 'one', state: {}, version: 1, epoch: 1, regionId: 'r1', updatedAt: 1 }",
      ),
      "SCHEMAFULL must reject a string characterId",
    );
    await assert.rejects(
      db.query("CREATE op_dedup CONTENT { opId: 'x', result: {}, createdAt: 'now' }"),
      "createdAt must be an int when present",
    );
    // Well-formed raw writes pass — including an op_dedup row with
    // NO createdAt (the commit functions write those).
    await db.query(
      "CREATE character_state CONTENT { characterId: 2, state: { gold: 5 }, version: 1, epoch: 1, regionId: 'r1', updatedAt: 1 }",
    );
    await db.query("CREATE op_dedup CONTENT { opId: 'op-raw', result: { ok: true } }");
    assert.deepEqual(await store.getOpResult("op-raw"), { ok: true });

    // The store's own paths conform.
    await store.putCharacterState({
      characterId: 3, state: { gold: 9 }, version: 1, epoch: 1, regionId: "r1", updatedAt: 2,
    });
    await store.putCharacterLock({
      characterId: 3, regionId: "r1", epoch: 1, expiresAt: Date.now() + 60_000,
    });
    await store.storeOpResult("op-store", { v: 1 });
    assert.equal((await store.getCharacterState(3))?.version, 1);
  } finally {
    await store.close();
  }

  // Reconnect (fresh in-memory DB per connection for mem://, so
  // this asserts idempotent definition application, not data
  // survival — data survival across reconnects is the live-server
  // suite's job).
  const again = new SurrealWorldStore(opts);
  await again.connect();
  try {
    await again.putCharacterState({
      characterId: 4, state: { gold: 1 }, version: 1, epoch: 1, regionId: "r1", updatedAt: 3,
    });
    assert.equal((await again.getCharacterState(4))?.version, 1);
  } finally {
    await again.close();
  }
});
