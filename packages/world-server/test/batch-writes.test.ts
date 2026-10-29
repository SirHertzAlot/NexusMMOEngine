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

test("batched character-state writes: memory store", async () => {
  await contract(new MemoryWorldStore());
});

test("batched character-state writes: SurrealDB (embedded, or WORLD_TEST_DB_URL)", async () => {
  const store = new SurrealWorldStore(surrealTestOptions("batchwrites_" + Date.now()));
  await store.connect();
  try {
    await contract(store);
  } finally {
    await store.close();
  }
});
