/**
 * Batched character-state writes at the core (WorldCore.putCharacterStates).
 *
 * The bulk op must be the single put, fanned out: identical dedup,
 * fencing codes/messages, credits drain and version assignment per
 * record — with failures reported per record instead of thrown, so
 * one fenced record cannot sink a region's save sweep.
 *
 * Run against both WorldStore implementations (the Surreal run needs
 * a test database; see surreal-test-db.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";
import { surrealTestOptions } from "./surreal-test-db.js";
import {
  rangeKeyFor,
  type CharacterStateRecord,
  type PutCharacterStateItem,
  type RegionLease,
  type WorldStore,
} from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const RANGE_A = { x0: 0, x1: 100, z0: 0, z1: 100 };

let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

let opCounter = 0;
function opId(tag: string): string {
  return `op-${tag}-${++opCounter}`;
}

async function makeCore(store: WorldStore): Promise<WorldCoreImpl> {
  return new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 1000,
    heartbeatIntervalMs: 100,
    apiKeyHash: await apiKeyHash(),
  });
}

async function register(core: WorldCoreImpl, regionId: string): Promise<RegionLease> {
  return core.registerRegion({
    regionId,
    chunkRange: RANGE_A,
    endpoint: "ws://localhost:7777",
    capacity: 1000,
    apiKey: API_KEY,
    opId: opId(`reg-${regionId}`),
  });
}

async function lock(
  core: WorldCoreImpl,
  lease: RegionLease,
  characterId: number,
): Promise<number> {
  const l = await core.acquireCharacterLock("r1", {
    regionId: lease.regionId,
    characterId,
    ttlMs: 60_000,
    opId: opId("lock"),
  });
  return l.epoch;
}

function item(characterId: number, epoch: number, gold: number): PutCharacterStateItem {
  return {
    characterId,
    epoch,
    state: { gold, inventory: [] },
    opId: opId(`put-${characterId}`),
  };
}

async function contract(makeStore: () => Promise<WorldStore>): Promise<void> {
  const store = await makeStore();
  const core = await makeCore(store);
  const lease = await register(core, "r1");
  const e1 = await lock(core, lease, 1);
  const e2 = await lock(core, lease, 2);
  const e3 = await lock(core, lease, 3);

  // A clean batch applies every record; versions start at 1.
  const outcomes = await core.putCharacterStates("r1", "r1", [
    item(1, e1, 10),
    item(2, e2, 20),
    item(3, e3, 30),
  ]);
  assert.deepEqual(
    outcomes.map((o) => [o.characterId, o.ok]),
    [
      [1, true],
      [2, true],
      [3, true],
    ],
  );
  for (const o of outcomes) {
    if (o.ok) assert.equal(o.record.version, 1);
  }
  assert.equal((await store.getCharacterState(2))?.state !== null, true);
  assert.equal(
    ((await store.getCharacterState(2))?.state as { gold: number }).gold,
    20,
  );

  // A second batch bumps versions; a stale-epoch record fails alone
  // (409, the single put's message) and its stored record is untouched.
  const mixed = await core.putCharacterStates("r1", "r1", [
    item(1, e1, 11),
    item(2, e2 + 99, 21),
    item(3, e3, 31),
  ]);
  assert.equal(mixed[0]?.ok, true);
  assert.equal(mixed[2]?.ok, true);
  const fenced = mixed[1];
  assert.equal(fenced?.ok, false);
  if (fenced && !fenced.ok) {
    assert.equal(fenced.code, 409);
    assert.match(fenced.message, /stale lock epoch/);
  }
  assert.equal(
    ((await store.getCharacterState(2))?.state as { gold: number }).gold,
    20,
    "the fenced record's stored state is untouched",
  );
  assert.equal((await store.getCharacterState(1))?.version, 2);

  // An unlocked character fails its own outcome (409 not locked).
  const unlocked = await core.putCharacterStates("r1", "r1", [item(9, 1, 90)]);
  assert.equal(unlocked[0]?.ok, false);
  if (unlocked[0] && !unlocked[0].ok) assert.equal(unlocked[0].code, 409);

  // Dedup: replaying an applied opId returns the original record and
  // does not bump the version.
  const first = item(1, e1, 12);
  const applied = await core.putCharacterStates("r1", "r1", [first]);
  assert.equal(applied[0]?.ok, true);
  const replayed = await core.putCharacterStates("r1", "r1", [first]);
  assert.equal(replayed[0]?.ok, true);
  if (applied[0]?.ok && replayed[0]?.ok) {
    assert.equal(replayed[0].record.version, applied[0].record.version);
  }
  assert.equal((await store.getCharacterState(1))?.version, 3);

  // Same character twice in one batch: sequential semantics — the
  // second put builds on the first's version, final state wins.
  const twice = await core.putCharacterStates("r1", "r1", [
    item(3, e3, 32),
    item(3, e3, 33),
  ]);
  assert.equal(twice[0]?.ok, true);
  assert.equal(twice[1]?.ok, true);
  const finalRec = await store.getCharacterState(3);
  assert.equal(finalRec?.version, 4, "v1 create, v2 second batch, v3+v4 for the two in-batch puts");
  assert.equal((finalRec?.state as { gold: number }).gold, 33);

  // Same opId twice in one batch: the repeat replays, no double-apply.
  const dup = item(2, e2, 22);
  const dups = await core.putCharacterStates("r1", "r1", [dup, dup]);
  assert.equal(dups[0]?.ok, true);
  assert.equal(dups[1]?.ok, true);
  if (dups[0]?.ok && dups[1]?.ok) {
    assert.equal(dups[1].record.version, dups[0].record.version);
  }
  assert.equal((await store.getCharacterState(2))?.version, 2);
}

test("putCharacterStates: single-put ceremony, fanned out (memory store)", async () => {
  await contract(async () => new MemoryWorldStore());
});

test("putCharacterStates: single-put ceremony, fanned out (surreal store)", async () => {
  const store = new SurrealWorldStore(surrealTestOptions("batchcore_" + Date.now()));
  await store.connect();
  try {
    await contract(async () => store);
  } finally {
    await store.close();
  }
});

/**
 * The credits drain is the one store call the batch keeps per-record.
 * Simulate its write path (it folds credits into the stored record,
 * bumping its version, and returns the post-drain record) and assert
 * the batch builds on the drained version and adds the drained total
 * to the payload gold — exactly the single put's arithmetic.
 */
test("putCharacterStates: builds on the credits drain like the single put", async () => {
  class DrainingStore extends MemoryWorldStore {
    override async getPendingCreditTotals(
      characterIds: number[],
    ): Promise<Map<number, number>> {
      return new Map(characterIds.map((id) => [id, 50] as const));
    }

    override async applyPendingCredits(
      characterId: number,
    ): Promise<{ total: number; record: CharacterStateRecord | null }> {
      const current = await this.getCharacterState(characterId);
      if (current === null) return { total: 0, record: null };
      const updated: CharacterStateRecord = {
        ...current,
        state: {
          ...(current.state as Record<string, unknown>),
          gold: ((current.state as { gold: number }).gold ?? 0) + 50,
        },
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      await this.putCharacterState(updated);
      return { total: 50, record: updated };
    }
  }
  const store = new DrainingStore();
  const core = await makeCore(store);
  const lease = await register(core, "r1");
  const e1 = await lock(core, lease, 1);
  // Seed a stored record at version 5 with gold 100.
  await store.putCharacterState({
    characterId: 1,
    state: { gold: 100, inventory: [] },
    version: 5,
    epoch: e1,
    regionId: "r1",
    updatedAt: Date.now(),
  });
  const outcomes = await core.putCharacterStates("r1", "r1", [item(1, e1, 100)]);
  assert.equal(outcomes[0]?.ok, true);
  if (outcomes[0]?.ok) {
    // Drain bumped the record to v6; the put builds on it -> v7.
    assert.equal(outcomes[0].record.version, 7);
    // Payload gold (100) + drained total (50).
    assert.equal((outcomes[0].record.state as { gold: number }).gold, 150);
  }
});

test("putCharacterStates: the drain runs only for characters holding credits", async () => {
  class CountingStore extends MemoryWorldStore {
    drainCalls = 0;
    override async applyPendingCredits(
      characterId: number,
    ): Promise<{ total: number; record: CharacterStateRecord | null }> {
      this.drainCalls += 1;
      return super.applyPendingCredits(characterId);
    }
  }
  const store = new CountingStore();
  const core = await makeCore(store);
  const lease = await register(core, "r1");
  const e1 = await lock(core, lease, 1);
  const e2 = await lock(core, lease, 2);
  const e3 = await lock(core, lease, 3);
  store.drainCalls = 0; // lock acquisition drains too; count only the batch
  const outcomes = await core.putCharacterStates("r1", "r1", [
    item(1, e1, 10),
    item(2, e2, 20),
    item(3, e3, 30),
  ]);
  assert.ok(outcomes.every((o) => o.ok));
  assert.equal(store.drainCalls, 0, "no credits anywhere: the per-record drain never runs");
});
