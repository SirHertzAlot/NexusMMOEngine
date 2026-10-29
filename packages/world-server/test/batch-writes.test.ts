/**
 * Batched character-state writes (the save-sweep write path).
 *
 * Contract, run against both WorldStore implementations:
 * - putCharacterStates stores a mixed batch (new + existing records)
 *   verbatim in one call, and a batch larger than the store's internal
 *   chunk size lands completely.
 * - An empty batch is a no-op.
 * - putCharacterState / putCharacterLock keep their create-then-
 *   overwrite behavior on the single-statement upsert forms.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";
import { surrealTestOptions } from "./surreal-test-db.js";
import type { CharacterStateRecord, WorldStore } from "../src/types.js";

function rec(characterId: number, version: number): CharacterStateRecord {
  return {
    characterId,
    state: { gold: characterId * 10 + version, inventory: ["sword"] },
    version,
    epoch: 1,
    regionId: "r1",
    updatedAt: 1_700_000_000_000 + version,
  };
}

async function contract(store: WorldStore): Promise<void> {
  // Single put: create, then overwrite (upsert statement regression cover).
  await store.putCharacterState(rec(1, 1));
  await store.putCharacterState(rec(1, 2));
  assert.equal((await store.getCharacterState(1))?.version, 2);

  // Mixed batch: records 2..41 are new, record 1 already exists.
  const batch = [rec(1, 3), ...Array.from({ length: 40 }, (_, i) => rec(i + 2, 1))];
  await store.putCharacterStates(batch);
  assert.equal((await store.getCharacterState(1))?.version, 3, "batch overwrites the existing record");
  assert.deepEqual((await store.getCharacterState(41))?.state, { gold: 411, inventory: ["sword"] });

  // A batch larger than the Surreal store's 256-statement chunk lands fully.
  const big = Array.from({ length: 600 }, (_, i) => rec(1000 + i, 1));
  await store.putCharacterStates(big);
  assert.equal((await store.getCharacterState(1000))?.version, 1);
  assert.equal((await store.getCharacterState(1599))?.version, 1);
  assert.equal(await store.getCharacterState(1600), null, "no phantom record past the batch");

  // Empty batch: a no-op that resolves.
  await store.putCharacterStates([]);

  // Lock put: create, then overwrite (upsert statement regression cover).
  await store.putCharacterLock({ characterId: 7, regionId: "r1", epoch: 1, expiresAt: 5000 });
  await store.putCharacterLock({ characterId: 7, regionId: "r2", epoch: 2, expiresAt: 9000 });
  const lock = await store.getCharacterLock(7);
  assert.equal(lock?.regionId, "r2");
  assert.equal(lock?.epoch, 2);
  assert.equal(lock?.expiresAt, 9000);
}

async function readContract(store: WorldStore): Promise<void> {
  // Batched reads return exactly the stored records, keyed by id;
  // ids with nothing stored are absent (not null entries).
  await store.putCharacterStates([rec(1, 1), rec(2, 1), rec(3, 1)]);
  await store.putCharacterLock({ characterId: 1, regionId: "r1", epoch: 1, expiresAt: 5000 });
  await store.putCharacterLock({ characterId: 3, regionId: "r1", epoch: 2, expiresAt: 6000 });

  const states = await store.getCharacterStates([1, 2, 3, 404]);
  assert.equal(states.size, 3);
  assert.equal(states.get(2)?.version, 1);
  assert.equal(states.has(404), false);

  const locks = await store.getCharacterLocks([1, 2, 3]);
  assert.equal(locks.size, 2);
  assert.equal(locks.get(3)?.epoch, 2);
  assert.equal(locks.has(2), false);

  assert.equal((await store.getCharacterStates([])).size, 0);
  assert.equal((await store.getCharacterLocks([])).size, 0);

  // Batched op results round-trip; unknown opIds are absent.
  await store.storeOpResults([
    { opId: "op-a", result: { v: 1 } },
    { opId: "op-b", result: { v: 2 } },
  ]);
  const results = await store.getOpResults(["op-a", "op-b", "op-nope"]);
  assert.deepEqual(results.get("op-a"), { v: 1 });
  assert.deepEqual(results.get("op-b"), { v: 2 });
  assert.equal(results.has("op-nope"), false);
  assert.equal((await store.getOpResults([])).size, 0);
  await store.storeOpResults([]);
}

test("batched character-state writes: memory store", async () => {
  await contract(new MemoryWorldStore());
  await readContract(new MemoryWorldStore());
});

test("batched character-state writes: SurrealDB (embedded, or WORLD_TEST_DB_URL)", async () => {
  const store = new SurrealWorldStore(surrealTestOptions("batchwrites_" + Date.now()));
  await store.connect();
  try {
    await contract(store);
    await readContract(store);
  } finally {
    await store.close();
  }
});
