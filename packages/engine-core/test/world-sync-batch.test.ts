/**
 * Save-sweep coalescing in WorldCharacterSync: prepared saves collect
 * over a short window and flush as ONE batched world call; a record
 * the world fences fails its own save only; logout's final commit
 * skips the window; a client without the bulk method falls back to
 * per-record puts on the same schedule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  CharacterSessionLock,
  CharacterStateRecord,
  PutCharacterStateOutcome,
} from "@mmo-engine/world-server";
import { MemoryCharacterStore, type CharacterState } from "../src/characters/store.js";
import {
  WorldCharacterSync,
  type CharacterWorldClient,
} from "../src/world/character-sync.js";
import { WorldTransportError } from "../src/world/client.js";

const STATE: CharacterState = { x: 1, y: 2, z: 3, health: 50, stamina: 60 };

class FakeWorld implements CharacterWorldClient {
  bulkCalls: Array<Array<{ characterId: number; epoch: number }>> = [];
  singleCalls: number[] = [];
  released: number[] = [];
  /** Characters the bulk op should fence (409), when set. */
  fenceBulk = new Set<number>();
  private versions = new Map<number, number>();

  async getCharacterState(): Promise<CharacterStateRecord | null> {
    return null;
  }

  async acquireCharacterLock(characterId: number): Promise<CharacterSessionLock> {
    return {
      characterId,
      regionId: "r1",
      epoch: 1,
      expiresAt: Date.now() + 60_000,
    };
  }

  async releaseCharacterLock(characterId: number): Promise<void> {
    this.released.push(characterId);
  }

  async putCharacterState(
    characterId: number,
    epoch: number,
  ): Promise<CharacterStateRecord> {
    this.singleCalls.push(characterId);
    return this.record(characterId, epoch);
  }

  async putCharacterStates(
    items: ReadonlyArray<{ characterId: number; epoch: number; state: unknown }>,
  ): Promise<PutCharacterStateOutcome[]> {
    this.bulkCalls.push(items.map((i) => ({ characterId: i.characterId, epoch: i.epoch })));
    return items.map((i) =>
      this.fenceBulk.has(i.characterId)
        ? {
            characterId: i.characterId,
            ok: false as const,
            code: 409,
            message: `stale lock epoch ${i.epoch} for character ${i.characterId} (current 2)`,
          }
        : { characterId: i.characterId, ok: true as const, record: this.record(i.characterId, i.epoch) },
    );
  }

  private record(characterId: number, epoch: number): CharacterStateRecord {
    const version = (this.versions.get(characterId) ?? 0) + 1;
    this.versions.set(characterId, version);
    return {
      characterId,
      state: { ...STATE },
      version,
      epoch,
      regionId: "r1",
      updatedAt: Date.now(),
    };
  }
}

async function rig(client: CharacterWorldClient, ids: number[]) {
  const store = new MemoryCharacterStore();
  const logs: string[] = [];
  const sync = new WorldCharacterSync({ client, store, log: (l) => logs.push(l) });
  for (const id of ids) {
    store.saveState(id, STATE);
    assert.deepEqual(await sync.login(id), { ok: true, seeded: false });
  }
  return { sync, store, logs };
}

test("a burst of saves coalesces into one batched world call", async () => {
  const world = new FakeWorld();
  const { sync } = await rig(world, [1, 2, 3]);
  const results = await Promise.all([sync.save(1), sync.save(2), sync.save(3)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(world.bulkCalls.length, 1, "one bulk call for the whole burst");
  assert.deepEqual(
    world.bulkCalls[0]?.map((c) => c.characterId).sort(),
    [1, 2, 3],
  );
  assert.equal(world.singleCalls.length, 0, "no per-record puts on the bulk path");
});

test("one fenced record fails its own save only", async () => {
  const world = new FakeWorld();
  world.fenceBulk.add(2);
  const { sync } = await rig(world, [1, 2, 3]);
  const results = await Promise.all([sync.save(1), sync.save(2), sync.save(3)]);
  assert.deepEqual(results, [true, false, true]);
  // Character 2 is fenced now: a later save short-circuits with no
  // further world call, while character 1 keeps saving.
  const callsBefore = world.bulkCalls.length;
  assert.equal(await sync.save(2), false);
  assert.equal(await sync.save(1), true);
  assert.equal(world.bulkCalls.length, callsBefore + 1, "only character 1's save went uphill");
});

test("logout's final commit flushes immediately and releases the lock", async () => {
  const world = new FakeWorld();
  const { sync } = await rig(world, [1]);
  assert.equal(await sync.logout(1), true);
  assert.equal(world.bulkCalls.length, 1);
  assert.deepEqual(world.released, [1]);
});

test("a client without the bulk method falls back to per-record puts", async () => {
  const world = new FakeWorld();
  const noBulk: CharacterWorldClient = {
    getCharacterState: world.getCharacterState.bind(world),
    acquireCharacterLock: world.acquireCharacterLock.bind(world),
    releaseCharacterLock: world.releaseCharacterLock.bind(world),
    putCharacterState: world.putCharacterState.bind(world),
  };
  const { sync } = await rig(noBulk, [1, 2]);
  const results = await Promise.all([sync.save(1), sync.save(2)]);
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(world.singleCalls.sort(), [1, 2]);
});

test("a world without the bulk op (501) falls back to per-record puts, stickily", async () => {
  const world = new FakeWorld();
  let bulkAttempts = 0;
  world.putCharacterStates = async () => {
    bulkAttempts += 1;
    throw new WorldTransportError(501, "PutCharacterStates not implemented by fake transport");
  };
  const { sync, logs } = await rig(world, [1, 2]);
  const results = await Promise.all([sync.save(1), sync.save(2)]);
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(world.singleCalls.sort(), [1, 2], "the batch landed per-record");
  // Sticky: the next save doesn't pay another doomed bulk call.
  assert.equal(await sync.save(1), true);
  assert.equal(bulkAttempts, 1);
  assert.ok(logs.some((l) => l.includes("PutCharacterStates")), "the fallback is logged once");
});

test("a bulk-call transport failure fails the saves without fencing anyone", async () => {
  const world = new FakeWorld();
  world.putCharacterStates = async () => {
    throw new WorldTransportError(503, "world unreachable");
  };
  const { sync } = await rig(world, [1, 2]);
  const results = await Promise.all([sync.save(1), sync.save(2)]);
  assert.deepEqual(results, [false, false]);
  // Not fenced: the next cycle retries uphill.
  world.putCharacterStates = FakeWorld.prototype.putCharacterStates;
  assert.equal(await sync.save(1), true);
});
