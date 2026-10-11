/**
 * Dungeon result flush (roadmap D4, slice 4): the region sends its
 * `instances.db` unreported batch to the world and marks only what the
 * world confirmed ingested. A failed report throws and marks nothing,
 * so the batch retries on the next flush.
 *
 * Seam: InstanceResultStore boundary with the world call injected as
 * `report` (the WorldClient method in production, a stub here).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryInstanceResultStore, flushInstanceResults } from "../../src/dungeons/results.js";
import type { InstanceResult } from "../../src/dungeons/instance.js";

function run(instance: string): InstanceResult {
  return {
    instance,
    dungeon: "grim-1",
    entrance: "barrow-gate",
    outcome: "cleared",
    startedAt: 1000,
    endedAt: 2000,
    members: [7],
    kills: [{ characterId: 7, kind: "goblin", count: 2 }],
    deaths: [],
    loot: [{ characterId: 7, def: 11 }],
  };
}

test("flush reports the unreported batch and marks what the world ingested", async () => {
  const store = new MemoryInstanceResultStore();
  store.record(run("run-a"), 1, 0);
  store.record(run("run-b"), 0, 1);
  const sent: InstanceResult[][] = [];
  const out = await flushInstanceResults(store, async (results) => {
    sent.push(results);
    return results.map((r) => r.instance);
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((r) => r.instance), ["run-a", "run-b"]);
  assert.deepEqual(out, { reported: 2 });
  assert.deepEqual(store.unreported(), []);
  // Nothing left: the world is not called again.
  const again = await flushInstanceResults(store, async () => {
    throw new Error("must not be called");
  });
  assert.deepEqual(again, { reported: 0 });
});

test("a failed report throws and leaves every row unreported", async () => {
  const store = new MemoryInstanceResultStore();
  store.record(run("run-a"), 1, 0);
  await assert.rejects(
    flushInstanceResults(store, async () => {
      throw new Error("world down");
    }),
    /world down/,
  );
  assert.equal(store.unreported().length, 1);
});
