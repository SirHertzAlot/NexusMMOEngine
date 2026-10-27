/**
 * Atomic operations (slice A1): the six value-moving exchanges as
 * world-tier DB functions.
 *
 * Per operation: happy path; each applicable typed rejection
 * (INSUFFICIENT_FUNDS, ITEM_NOT_PRESENT, VERSION_CONFLICT,
 * LOCK_CONFLICT, EPOCH_STALE); opId replay returning the stored
 * outcome without re-applying; and an EXPLICIT atomicity test — a
 * mid-operation failure (the second participant / second leg fails
 * validation after the first leg validated) leaves every
 * participating record and the item ledger byte-identical to before.
 * Value conservation is asserted where it fits: gold and items are
 * neither created nor destroyed except by the declared rules
 * (vendor/craft sinks and sources, loot creation).
 *
 * Seam: WorldCore over MemoryWorldStore, plus the store contract run
 * against both stores (Surreal embedded in memory, or WORLD_TEST_DB_URL;
 * the P1 pattern).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { SurrealWorldStore } from "../src/surreal-store.js";
import { surrealTestOptions } from "./surreal-test-db.js";
import {
  WorldError,
  type AtomicOpResult,
  type CharacterStateRecord,
  type InventoryItem,
  type ParticipantFence,
  type RegionLease,
  type WorldStore,
} from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const RANGE_A = { x0: 0, x1: 100, z0: 0, z1: 100 };
const RANGE_B = { x0: 100, x1: 200, z0: 0, z1: 100 };

let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

async function makeCore() {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 1000,
    heartbeatIntervalMs: 100,
    apiKeyHash: await apiKeyHash(),
  });
  return { core, store };
}

let opCounter = 0;
function opId(tag: string): string {
  return `op-${tag}-${++opCounter}`;
}

async function register(
  core: WorldCoreImpl,
  regionId: string,
  range = RANGE_A,
): Promise<RegionLease> {
  return core.registerRegion({
    regionId,
    chunkRange: range,
    endpoint: "ws://localhost:7777",
    capacity: 1000,
    apiKey: API_KEY,
    opId: opId(`reg-${regionId}`),
  });
}

function isWorldError(code: number) {
  return (e: unknown) => {
    assert.ok(e instanceof WorldError && e.code === code, `expected WorldError ${code}, got ${String(e)}`);
    return true;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const item = (instanceId: string, def: number, slot: number, count = 1): InventoryItem => ({
  instanceId,
  def,
  slot,
  count,
});

interface Seeded {
  fence: ParticipantFence;
  epoch: number;
}

/**
 * Lock a character (via the core, from `regionId`) and seed its
 * world record at version 1 with the given gold + inventory.
 */
async function seedCharacter(
  core: WorldCoreImpl,
  store: WorldStore,
  regionId: string,
  characterId: number,
  gold: number,
  inventory: InventoryItem[],
  extra: Record<string, unknown> = {},
): Promise<Seeded> {
  const lock = await core.acquireCharacterLock(regionId, {
    regionId,
    characterId,
    ttlMs: 60_000,
    opId: opId("lock"),
  });
  await store.putCharacterState({
    characterId,
    state: { ...extra, gold, inventory },
    version: 1,
    epoch: lock.epoch,
    regionId,
    updatedAt: Date.now(),
  });
  return { fence: { characterId, epoch: lock.epoch, expectedVersion: 1 }, epoch: lock.epoch };
}

/** Lock a character with NO world record yet (expectedVersion 0). */
async function lockOnly(
  core: WorldCoreImpl,
  regionId: string,
  characterId: number,
): Promise<Seeded> {
  const lock = await core.acquireCharacterLock(regionId, {
    regionId,
    characterId,
    ttlMs: 60_000,
    opId: opId("lock"),
  });
  return { fence: { characterId, epoch: lock.epoch, expectedVersion: 0 }, epoch: lock.epoch };
}

/** Byte-level snapshot of the participating records + the item ledger. */
async function snapshot(store: WorldStore, ids: number[]): Promise<string> {
  const records: (CharacterStateRecord | null)[] = [];
  for (const id of ids) records.push(await store.getCharacterState(id));
  return JSON.stringify({ records, ledger: await store.getAtomicLedger() });
}

async function goldOf(store: WorldStore, characterId: number): Promise<number> {
  const rec = await store.getCharacterState(characterId);
  return (rec?.state as { gold: number }).gold;
}

async function inventoryOf(store: WorldStore, characterId: number): Promise<InventoryItem[]> {
  const rec = await store.getCharacterState(characterId);
  return (rec?.state as { inventory: InventoryItem[] }).inventory;
}

function expectRejection(res: AtomicOpResult, code: string): void {
  assert.equal(res.ok, false, `expected rejection ${code}, got ${JSON.stringify(res)}`);
  if (!res.ok) assert.equal(res.rejection, code);
}

/** A rejected op must leave records + ledger byte-identical. */
async function expectUnchanged(
  store: WorldStore,
  ids: number[],
  before: string,
): Promise<void> {
  assert.equal(await snapshot(store, ids), before, "rejected op changed state or ledger");
}

// ------------------------------------------------------------ tradeCommit

async function tradeSetup() {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const a = await seedCharacter(core, store, "r1", 1, 100, [item("sword-1", 10, 0)]);
  const b = await seedCharacter(core, store, "r1", 2, 50, [item("shield-1", 20, 0)]);
  return { core, store, a, b };
}

test("tradeCommit: both directions settle atomically; gold and items conserved", async () => {
  const { core, store, a, b } = await tradeSetup();
  const res = await core.tradeCommit("r1", {
    regionId: "r1",
    opId: opId("trade"),
    a: a.fence,
    b: b.fence,
    aGivesGold: 30,
    bGivesGold: 10,
    aGivesItems: ["sword-1"],
    bGivesItems: ["shield-1"],
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.characters.map((c) => c.version), [2, 2]);
    assert.equal(res.ledger.length, 4); // 2 gold legs + 2 item moves
    assert.deepEqual(res.ledger.map((e) => e.seq), [1, 2, 3, 4]);
  }
  assert.equal(await goldOf(store, 1), 80);
  assert.equal(await goldOf(store, 2), 70);
  assert.equal((await goldOf(store, 1)) + (await goldOf(store, 2)), 150, "gold conserved");
  assert.deepEqual(await inventoryOf(store, 1), [item("shield-1", 20, 0)]);
  assert.deepEqual(await inventoryOf(store, 2), [item("sword-1", 10, 0)]);
});

test("tradeCommit atomicity: second participant's missing item leaves everything byte-identical", async () => {
  const { core, store, a, b } = await tradeSetup();
  const before = await snapshot(store, [1, 2]);
  // A's leg validates (gold + sword present); B's item does not exist.
  const res = await core.tradeCommit("r1", {
    regionId: "r1",
    opId: opId("trade"),
    a: a.fence,
    b: b.fence,
    aGivesGold: 30,
    bGivesGold: 10,
    aGivesItems: ["sword-1"],
    bGivesItems: ["shield-404"],
  });
  expectRejection(res, "ITEM_NOT_PRESENT");
  await expectUnchanged(store, [1, 2], before);
});

test("tradeCommit atomicity: insufficient funds on the second leg leaves everything byte-identical", async () => {
  const { core, store, a, b } = await tradeSetup();
  const before = await snapshot(store, [1, 2]);
  const res = await core.tradeCommit("r1", {
    regionId: "r1",
    opId: opId("trade"),
    a: a.fence,
    b: b.fence,
    aGivesGold: 10, // A can pay
    bGivesGold: 9999, // B cannot
    aGivesItems: [],
    bGivesItems: [],
  });
  expectRejection(res, "INSUFFICIENT_FUNDS");
  await expectUnchanged(store, [1, 2], before);
});

test("tradeCommit fencing: VERSION_CONFLICT, EPOCH_STALE and LOCK_CONFLICT reject and change nothing", async () => {
  const { core, store, a, b } = await tradeSetup();
  const base = {
    regionId: "r1",
    aGivesGold: 0,
    bGivesGold: 0,
    aGivesItems: [] as string[],
    bGivesItems: [] as string[],
  };
  let before = await snapshot(store, [1, 2]);
  expectRejection(
    await core.tradeCommit("r1", { ...base, opId: opId("trade"), a: a.fence, b: { ...b.fence, expectedVersion: 99 } }),
    "VERSION_CONFLICT",
  );
  await expectUnchanged(store, [1, 2], before);
  expectRejection(
    await core.tradeCommit("r1", { ...base, opId: opId("trade"), a: { ...a.fence, epoch: 99 }, b: b.fence }),
    "EPOCH_STALE",
  );
  await expectUnchanged(store, [1, 2], before);
  // Character 3 has a record but no session lock at all.
  await store.putCharacterState({
    characterId: 3,
    state: { gold: 5, inventory: [] },
    version: 1,
    epoch: 1,
    regionId: "r1",
    updatedAt: Date.now(),
  });
  before = await snapshot(store, [1, 3]);
  expectRejection(
    await core.tradeCommit("r1", {
      ...base,
      opId: opId("trade"),
      a: a.fence,
      b: { characterId: 3, epoch: 1, expectedVersion: 1 },
    }),
    "LOCK_CONFLICT",
  );
  await expectUnchanged(store, [1, 3], before);
});

test("tradeCommit: opId replay returns the stored outcome and never re-applies", async () => {
  const { core, store, a, b } = await tradeSetup();
  const input = {
    regionId: "r1",
    opId: opId("trade"),
    a: a.fence,
    b: b.fence,
    aGivesGold: 30,
    bGivesGold: 0,
    aGivesItems: ["sword-1"],
    bGivesItems: [] as string[],
  };
  const first = await core.tradeCommit("r1", input);
  assert.equal(first.ok, true);
  const afterFirst = await snapshot(store, [1, 2]);
  const replay = await core.tradeCommit("r1", input);
  assert.deepEqual(replay, first);
  assert.equal(await snapshot(store, [1, 2]), afterFirst, "replay re-applied the trade");
  // A rejected outcome is stored too: its replay is the same rejection.
  const bad = {
    ...input,
    opId: opId("trade"),
    a: { ...a.fence, expectedVersion: 2 },
    b: { ...b.fence, expectedVersion: 2 },
    aGivesGold: 99999,
    aGivesItems: [] as string[],
  };
  const rejected = await core.tradeCommit("r1", bad);
  expectRejection(rejected, "INSUFFICIENT_FUNDS");
  assert.deepEqual(await core.tradeCommit("r1", bad), rejected);
});

test("tradeCommit: the core checks the caller before touching the store", async () => {
  const { core, a, b } = await tradeSetup();
  const input = {
    regionId: "r1",
    opId: opId("trade"),
    a: a.fence,
    b: b.fence,
    aGivesGold: 0,
    bGivesGold: 0,
    aGivesItems: [] as string[],
    bGivesItems: [] as string[],
  };
  await assert.rejects(core.tradeCommit("r2", input), isWorldError(403));
  await assert.rejects(core.tradeCommit("ghost", { ...input, regionId: "ghost" }), isWorldError(404));
});

// ------------------------------------------------------------ vendorTransact

test("vendorTransact buy: gold -> item in one step, ledger shows both legs", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 100, []);
  const res = await core.vendorTransact("r1", {
    regionId: "r1",
    opId: opId("vendor"),
    participant: c.fence,
    vendorId: "shop-1",
    direction: "buy",
    def: 10,
    price: 40,
    instanceId: "potion-1",
  });
  assert.equal(res.ok, true);
  assert.equal(await goldOf(store, 1), 60);
  assert.deepEqual(await inventoryOf(store, 1), [item("potion-1", 10, 0)]);
  const ledger = await store.getAtomicLedger();
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].kind, "item");
  assert.equal(ledger[0].from, "vendor:shop-1");
  assert.equal(ledger[1].kind, "gold");
  assert.equal(ledger[1].amount, 40);
});

test("vendorTransact sell: item -> gold in one step", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 5, [item("gem-1", 30, 0)]);
  const res = await core.vendorTransact("r1", {
    regionId: "r1",
    opId: opId("vendor"),
    participant: c.fence,
    vendorId: "shop-1",
    direction: "sell",
    def: 30,
    price: 25,
    instanceId: "gem-1",
  });
  assert.equal(res.ok, true);
  assert.equal(await goldOf(store, 1), 30);
  assert.deepEqual(await inventoryOf(store, 1), []);
});

test("vendorTransact atomicity: a buy the character cannot afford changes nothing; a missing sell item neither", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 10, [item("gem-1", 30, 0)]);
  const before = await snapshot(store, [1]);
  expectRejection(
    await core.vendorTransact("r1", {
      regionId: "r1", opId: opId("vendor"), participant: c.fence, vendorId: "shop-1",
      direction: "buy", def: 10, price: 40, instanceId: "potion-1",
    }),
    "INSUFFICIENT_FUNDS",
  );
  await expectUnchanged(store, [1], before);
  expectRejection(
    await core.vendorTransact("r1", {
      regionId: "r1", opId: opId("vendor"), participant: c.fence, vendorId: "shop-1",
      direction: "sell", def: 30, price: 25, instanceId: "gem-404",
    }),
    "ITEM_NOT_PRESENT",
  );
  await expectUnchanged(store, [1], before);
  expectRejection(
    await core.vendorTransact("r1", {
      regionId: "r1", opId: opId("vendor"),
      participant: { ...c.fence, expectedVersion: 7 }, vendorId: "shop-1",
      direction: "buy", def: 10, price: 1, instanceId: "potion-1",
    }),
    "VERSION_CONFLICT",
  );
  await expectUnchanged(store, [1], before);
});

// ------------------------------------------------------------ auctionSettle

test("auctionSettle: buyer pays the full price, seller receives it net of the house cut, item moves", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const buyer = await seedCharacter(core, store, "r1", 1, 200, []);
  const seller = await seedCharacter(core, store, "r1", 2, 10, [item("bow-1", 40, 0)]);
  const res = await core.auctionSettle("r1", {
    regionId: "r1",
    opId: opId("auction"),
    buyer: buyer.fence,
    seller: seller.fence,
    instanceId: "bow-1",
    price: 120,
  });
  assert.equal(res.ok, true);
  // Price 120: fee = floor(120 * 0.05) = 6 (a pure sink), proceeds 114.
  assert.equal(await goldOf(store, 1), 80, "the buyer is debited the full price");
  assert.equal(await goldOf(store, 2), 124, "the seller receives price - fee");
  assert.equal(
    (await goldOf(store, 1)) + (await goldOf(store, 2)),
    204,
    "buyer debit = proceeds + fee; the fee left circulation",
  );
  assert.deepEqual(await inventoryOf(store, 1), [item("bow-1", 40, 0)]);
  assert.deepEqual(await inventoryOf(store, 2), []);
  // Local-seller direct path: proceeds landed immediately, no credit.
  assert.deepEqual(await store.listPendingCredits(2), []);
  const goldLegs = (await store.getAtomicLedger()).filter((e) => e.kind === "gold");
  assert.deepEqual(
    goldLegs.map((e) => [e.from, e.to, e.amount]),
    [
      ["char:1", "char:2", 114],
      ["char:1", "system:auction-house", 6],
    ],
    "ledger shows the proceeds leg and the house-cut leg",
  );
});

test("auctionSettle atomicity: missing item or short buyer leaves all three facts unmoved", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const buyer = await seedCharacter(core, store, "r1", 1, 50, []);
  const seller = await seedCharacter(core, store, "r1", 2, 10, [item("bow-1", 40, 0)]);
  const before = await snapshot(store, [1, 2]);
  // The item exists but the buyer cannot pay: the item must not move.
  expectRejection(
    await core.auctionSettle("r1", {
      regionId: "r1", opId: opId("auction"), buyer: buyer.fence, seller: seller.fence,
      instanceId: "bow-1", price: 120,
    }),
    "INSUFFICIENT_FUNDS",
  );
  await expectUnchanged(store, [1, 2], before);
  // The buyer could pay a smaller price, but the item is gone.
  expectRejection(
    await core.auctionSettle("r1", {
      regionId: "r1", opId: opId("auction"), buyer: buyer.fence, seller: seller.fence,
      instanceId: "bow-404", price: 10,
    }),
    "ITEM_NOT_PRESENT",
  );
  await expectUnchanged(store, [1, 2], before);
  // Replay of a settled auction does not settle twice.
  const settled = await core.auctionSettle("r1", {
    regionId: "r1", opId: "op-auction-fixed", buyer: buyer.fence, seller: seller.fence,
    instanceId: "bow-1", price: 50,
  });
  assert.equal(settled.ok, true);
  const afterSettle = await snapshot(store, [1, 2]);
  assert.deepEqual(
    await core.auctionSettle("r1", {
      regionId: "r1", opId: "op-auction-fixed", buyer: buyer.fence, seller: seller.fence,
      instanceId: "bow-1", price: 50,
    }),
    settled,
  );
  assert.equal(await snapshot(store, [1, 2]), afterSettle);
});

test("auctionSettle: an offline seller settles end-to-end (direct path, net of cut)", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const buyer = await seedCharacter(core, store, "r1", 1, 200, []);
  // The seller has a world record (with the item) but NO session lock.
  await store.putCharacterState({
    characterId: 2,
    state: { gold: 10, inventory: [item("bow-1", 40, 0)] },
    version: 1,
    epoch: 3,
    regionId: "r1",
    updatedAt: Date.now(),
  });
  const res = await core.auctionSettle("r1", {
    regionId: "r1",
    opId: opId("auction"),
    buyer: buyer.fence,
    seller: { characterId: 2, epoch: 0, expectedVersion: 1 },
    instanceId: "bow-1",
    price: 120,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await goldOf(store, 1), 80);
  assert.equal(await goldOf(store, 2), 124, "offline seller credited proceeds directly (120 - 6 fee)");
  assert.deepEqual(await inventoryOf(store, 1), [item("bow-1", 40, 0)]);
  assert.deepEqual(await inventoryOf(store, 2), []);
  assert.deepEqual(await store.listPendingCredits(2), [], "the direct path leaves no pending credit");
  const sellerRec = await store.getCharacterState(2);
  assert.equal(sellerRec?.epoch, 3, "the offline write keeps the seller record's existing epoch");
});

test("auctionSettle: an expired-lock seller settles end-to-end (direct path)", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const buyer = await seedCharacter(core, store, "r1", 1, 200, []);
  const seller = await seedCharacter(core, store, "r1", 2, 10, [item("bow-1", 40, 0)]);
  // The seller's lock has expired (never stolen): no longer live.
  await store.putCharacterLock({
    characterId: 2,
    regionId: "r1",
    epoch: seller.epoch,
    expiresAt: Date.now() - 1,
  });
  const res = await core.auctionSettle("r1", {
    regionId: "r1",
    opId: opId("auction"),
    buyer: buyer.fence,
    seller: { characterId: 2, epoch: 0, expectedVersion: 1 },
    instanceId: "bow-1",
    price: 100,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await goldOf(store, 1), 100);
  assert.equal(await goldOf(store, 2), 105, "proceeds 95 (100 - 5 fee) landed directly");
  assert.deepEqual(await inventoryOf(store, 2), []);
  assert.deepEqual(await store.listPendingCredits(2), []);
});

test("auctionSettle: a seller online on another region settles NOW — item out, gold untouched, one pending credit", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  await register(core, "r2", RANGE_B);
  const buyer = await seedCharacter(core, store, "r1", 1, 200, []);
  const seller = await seedCharacter(core, store, "r2", 2, 10, [item("bow-1", 40, 0)]);
  const settleOp = opId("auction");
  const input = {
    regionId: "r1",
    opId: settleOp,
    buyer: buyer.fence,
    seller: seller.fence,
    instanceId: "bow-1",
    price: 120,
  };
  const res = await core.auctionSettle("r1", input);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await goldOf(store, 1), 80, "the buyer is debited the full price now");
  assert.deepEqual(await inventoryOf(store, 1), [item("bow-1", 40, 0)], "the buyer holds the item now");
  assert.equal(await goldOf(store, 2), 10, "the seller's gold is untouched — its region owns that balance");
  assert.deepEqual(await inventoryOf(store, 2), [], "the item is out of the seller's record");
  const sellerRec = await store.getCharacterState(2);
  assert.equal(sellerRec?.epoch, seller.epoch, "the pending write carries the live lock's epoch");
  const credits = await store.listPendingCredits(2);
  assert.equal(credits.length, 1, "exactly one pending credit");
  assert.equal(credits[0].opId, settleOp);
  assert.equal(credits[0].characterId, 2);
  assert.equal(credits[0].amount, 114, "the credit is the post-cut proceeds (120 - 6)");
  // Replaying the same opId returns the stored result, no second credit.
  const replay = await core.auctionSettle("r1", input);
  assert.deepEqual(replay, res);
  assert.equal((await store.listPendingCredits(2)).length, 1, "a replay creates no second credit");
  assert.equal(await goldOf(store, 1), 80, "a replay does not debit twice");
});

test("pending credits drain on the seller's next putCharacterState, exactly once", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  await register(core, "r2", RANGE_B);
  const buyer = await seedCharacter(core, store, "r1", 1, 200, []);
  const seller = await seedCharacter(core, store, "r2", 2, 10, [item("bow-1", 40, 0)]);
  const res = await core.auctionSettle("r1", {
    regionId: "r1",
    opId: opId("auction"),
    buyer: buyer.fence,
    seller: seller.fence,
    instanceId: "bow-1",
    price: 120,
  });
  assert.equal(res.ok, true);
  assert.equal((await store.listPendingCredits(2)).length, 1);
  // The seller's region saves with its pre-credit balance (10) as the
  // payload gold: the stored record must carry payload + proceeds.
  const put = await core.putCharacterState("r2", {
    regionId: "r2",
    characterId: 2,
    epoch: seller.epoch,
    state: { gold: 10, inventory: [] },
    opId: opId("put"),
  });
  assert.equal((put.state as { gold: number }).gold, 124, "stored gold = payload gold + drained proceeds");
  assert.equal(await goldOf(store, 2), 124);
  assert.deepEqual(await store.listPendingCredits(2), [], "the drain consumed the credit");
  // A second put adds nothing.
  const put2 = await core.putCharacterState("r2", {
    regionId: "r2",
    characterId: 2,
    epoch: seller.epoch,
    state: { gold: 124, inventory: [] },
    opId: opId("put"),
  });
  assert.equal((put2.state as { gold: number }).gold, 124);
  assert.equal(await goldOf(store, 2), 124);
});

test("pending credits drain on acquireCharacterLock, before any put", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  await register(core, "r2", RANGE_B);
  const buyer = await seedCharacter(core, store, "r1", 1, 200, []);
  const seller = await seedCharacter(core, store, "r2", 2, 10, [item("bow-1", 40, 0)]);
  const res = await core.auctionSettle("r1", {
    regionId: "r1",
    opId: opId("auction"),
    buyer: buyer.fence,
    seller: seller.fence,
    instanceId: "bow-1",
    price: 120,
  });
  assert.equal(res.ok, true);
  assert.equal((await store.listPendingCredits(2)).length, 1);
  // The seller logs out (lock released), then logs back in anywhere:
  // the acquire itself drains the credit into the record.
  await core.releaseCharacterLock("r2", {
    regionId: "r2",
    characterId: 2,
    epoch: seller.epoch,
    opId: opId("release"),
  });
  await core.acquireCharacterLock("r1", {
    regionId: "r1",
    characterId: 2,
    ttlMs: 60_000,
    opId: opId("lock"),
  });
  assert.equal(await goldOf(store, 2), 124, "the record already includes the proceeds before any put");
  assert.deepEqual(await store.listPendingCredits(2), []);
});

test("applyPendingCredits: no record and no credits both fold nothing and consume nothing", async () => {
  const store = new MemoryWorldStore();
  assert.deepEqual(await store.applyPendingCredits(999), { total: 0, record: null });
  assert.deepEqual(await store.listPendingCredits(999), []);
  await store.putCharacterState({
    characterId: 5,
    state: { gold: 42, inventory: [] },
    version: 1,
    epoch: 1,
    regionId: "r1",
    updatedAt: Date.now(),
  });
  const none = await store.applyPendingCredits(5);
  assert.equal(none.total, 0);
  assert.equal(none.record?.version, 1, "no credits: the record is untouched");
  assert.equal(await goldOf(store, 5), 42);
});

test("auctionSettle atomicity (offline seller): a short buyer leaves seller, buyer, ledger and credits untouched", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const buyer = await seedCharacter(core, store, "r1", 1, 50, []);
  await store.putCharacterState({
    characterId: 2,
    state: { gold: 10, inventory: [item("bow-1", 40, 0)] },
    version: 1,
    epoch: 3,
    regionId: "r1",
    updatedAt: Date.now(),
  });
  const before = await snapshot(store, [1, 2]);
  expectRejection(
    await core.auctionSettle("r1", {
      regionId: "r1",
      opId: opId("auction"),
      buyer: buyer.fence,
      seller: { characterId: 2, epoch: 0, expectedVersion: 1 },
      instanceId: "bow-1",
      price: 120,
    }),
    "INSUFFICIENT_FUNDS",
  );
  await expectUnchanged(store, [1, 2], before);
  assert.deepEqual(await store.listPendingCredits(2), [], "no credit was created by the rejected settle");
});

test("auctionSettle cut parity: fee = floor(price * 0.05) and debit = proceeds + fee in the direct, offline and pending paths", async () => {
  // Store-level (no core): fast, and the same cases run against the
  // live store through the store contract below where parameterized.
  const prices = [1, 19, 20, 21, 99, 100, 101, 999];
  for (const path of ["direct", "offline", "pending"] as const) {
    for (const price of prices) {
      const store = new MemoryWorldStore();
      const now = Date.now();
      const seedRec = async (characterId: number, gold: number, inventory: InventoryItem[]) => {
        await store.putCharacterState({
          characterId, state: { gold, inventory }, version: 1, epoch: 1,
          regionId: "r1", updatedAt: now,
        });
      };
      await seedRec(1, 2000, []);
      await seedRec(2, 10, [item("bow-1", 40, 0)]);
      await store.putCharacterLock({ characterId: 1, regionId: "r1", epoch: 1, expiresAt: now + 60_000 });
      if (path === "direct") {
        await store.putCharacterLock({ characterId: 2, regionId: "r1", epoch: 1, expiresAt: now + 60_000 });
      } else if (path === "pending") {
        await store.putCharacterLock({ characterId: 2, regionId: "r2", epoch: 1, expiresAt: now + 60_000 });
      }
      const fee = Math.floor(price * 0.05);
      const proceeds = price - fee;
      const res = await store.auctionSettle({
        regionId: "r1",
        opId: `cut-${path}-${price}`,
        buyer: { characterId: 1, epoch: 1, expectedVersion: 1 },
        seller: { characterId: 2, epoch: path === "offline" ? 0 : 1, expectedVersion: 1 },
        instanceId: "bow-1",
        price,
      });
      assert.equal(res.ok, true, `${path} @ ${price}: ${JSON.stringify(res)}`);
      assert.equal(await goldOf(store, 1), 2000 - price, `${path} @ ${price}: buyer debit = price`);
      const credits = await store.listPendingCredits(2);
      if (path === "pending") {
        assert.equal(await goldOf(store, 2), 10, `${path} @ ${price}: seller gold untouched`);
        assert.deepEqual(credits.map((c) => c.amount), proceeds > 0 ? [proceeds] : [], `${path} @ ${price}: credit = proceeds`);
      } else {
        assert.equal(await goldOf(store, 2), 10 + proceeds, `${path} @ ${price}: seller credited proceeds`);
        assert.deepEqual(credits, [], `${path} @ ${price}: no credit on the direct/offline path`);
      }
      const ledger = await store.getAtomicLedger();
      const feeLeg = ledger.find((e) => e.kind === "gold" && e.to === "system:auction-house");
      assert.equal(feeLeg?.amount ?? 0, fee, `${path} @ ${price}: fee leg = floor(price * 0.05)`);
      const proceedsLeg = ledger.find((e) => e.kind === "gold" && e.to === "char:2");
      assert.equal(proceedsLeg?.amount ?? 0, proceeds, `${path} @ ${price}: proceeds leg`);
      assert.equal(proceeds + fee, price, `${path} @ ${price}: debit = proceeds + fee`);
    }
  }
});

// ------------------------------------------------------------ craftExecute

test("craftExecute: inputs and fee consumed, output produced, in one step", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 50, [
    item("wood-1", 1, 0, 3),
    item("iron-1", 2, 1, 1),
  ]);
  const res = await core.craftExecute("r1", {
    regionId: "r1",
    opId: opId("craft"),
    participant: c.fence,
    consumes: [{ instanceId: "wood-1", count: 2 }],
    goldFee: 5,
    outputs: [{ instanceId: "plank-1", def: 3 }],
  });
  assert.equal(res.ok, true);
  assert.equal(await goldOf(store, 1), 45);
  assert.deepEqual(await inventoryOf(store, 1), [
    item("wood-1", 1, 0, 1),
    item("iron-1", 2, 1, 1),
    item("plank-1", 3, 2, 1),
  ]);
  assert.equal((await store.getAtomicLedger()).length, 3); // consume + produce + fee
});

test("craftExecute atomicity: the second input missing leaves the first unconsumed and the fee uncharged", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 50, [item("wood-1", 1, 0, 3)]);
  const before = await snapshot(store, [1]);
  expectRejection(
    await core.craftExecute("r1", {
      regionId: "r1", opId: opId("craft"), participant: c.fence,
      consumes: [
        { instanceId: "wood-1", count: 2 }, // validates
        { instanceId: "iron-404", count: 1 }, // fails mid-operation
      ],
      goldFee: 5,
      outputs: [{ instanceId: "plank-1", def: 3 }],
    }),
    "ITEM_NOT_PRESENT",
  );
  await expectUnchanged(store, [1], before);
  // A short stack is the same typed rejection, also atomic.
  expectRejection(
    await core.craftExecute("r1", {
      regionId: "r1", opId: opId("craft"), participant: c.fence,
      consumes: [{ instanceId: "wood-1", count: 99 }],
      goldFee: 0,
      outputs: [],
    }),
    "ITEM_NOT_PRESENT",
  );
  await expectUnchanged(store, [1], before);
  // And the fee leg: inputs present, gold short.
  expectRejection(
    await core.craftExecute("r1", {
      regionId: "r1", opId: opId("craft"), participant: c.fence,
      consumes: [{ instanceId: "wood-1", count: 1 }],
      goldFee: 9999,
      outputs: [],
    }),
    "INSUFFICIENT_FUNDS",
  );
  await expectUnchanged(store, [1], before);
});

// ------------------------------------------------------------ lootGrant

test("lootGrant: creates the instance and assigns ownership atomically; also creates a first record", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await lockOnly(core, "r1", 1); // no record yet: expectedVersion 0
  const res = await core.lootGrant("r1", {
    regionId: "r1",
    opId: opId("loot"),
    participant: c.fence,
    sourceId: "loot:dragon-1",
    instanceId: "boss-drop-1",
    def: 99,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.characters[0].version, 1);
  assert.deepEqual(await inventoryOf(store, 1), [item("boss-drop-1", 99, 0)]);
  const ledger = await store.getAtomicLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].from, "loot:dragon-1");
  assert.equal(ledger[0].to, "char:1");
});

test("lootGrant atomicity: a duplicate instance id and a stale epoch both change nothing; replay does not duplicate", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 0, [item("boss-drop-1", 99, 0)]);
  const before = await snapshot(store, [1]);
  expectRejection(
    await core.lootGrant("r1", {
      regionId: "r1", opId: opId("loot"), participant: c.fence,
      sourceId: "loot:dragon-1", instanceId: "boss-drop-1", def: 99,
    }),
    "VERSION_CONFLICT",
  );
  await expectUnchanged(store, [1], before);
  expectRejection(
    await core.lootGrant("r1", {
      regionId: "r1", opId: opId("loot"),
      participant: { ...c.fence, epoch: 42 },
      sourceId: "loot:dragon-1", instanceId: "boss-drop-2", def: 99,
    }),
    "EPOCH_STALE",
  );
  await expectUnchanged(store, [1], before);
  const grant = {
    regionId: "r1", opId: opId("loot"), participant: c.fence,
    sourceId: "loot:dragon-1", instanceId: "boss-drop-2", def: 99,
  };
  const first = await core.lootGrant("r1", grant);
  assert.equal(first.ok, true);
  const afterFirst = await snapshot(store, [1]);
  assert.deepEqual(await core.lootGrant("r1", grant), first);
  assert.equal(await snapshot(store, [1]), afterFirst, "replay granted the item twice");
});

test("lootGrant fencing: an expired lock is a LOCK_CONFLICT and grants nothing", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const lock = await core.acquireCharacterLock("r1", {
    regionId: "r1", characterId: 1, ttlMs: 5, opId: opId("lock"),
  });
  await sleep(25);
  const before = await snapshot(store, [1]);
  expectRejection(
    await core.lootGrant("r1", {
      regionId: "r1", opId: opId("loot"),
      participant: { characterId: 1, epoch: lock.epoch, expectedVersion: 0 },
      sourceId: "loot:dragon-1", instanceId: "boss-drop-1", def: 99,
    }),
    "LOCK_CONFLICT",
  );
  await expectUnchanged(store, [1], before);
});

// ------------------------------------------------------------ inventoryMutate

test("inventoryMutate: move, swap and merge apply as one version-checked mutation", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 0, [
    item("a-1", 1, 0, 2),
    item("b-1", 1, 1, 3),
    item("c-1", 2, 2, 1),
  ]);
  const moved = await core.inventoryMutate("r1", {
    regionId: "r1", opId: opId("inv"), participant: c.fence,
    mutations: [{ kind: "move", instanceId: "c-1", toSlot: 5 }],
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(await inventoryOf(store, 1), [
    item("a-1", 1, 0, 2),
    item("b-1", 1, 1, 3),
    item("c-1", 2, 5, 1),
  ]);
  const swapped = await core.inventoryMutate("r1", {
    regionId: "r1", opId: opId("inv"),
    participant: { ...c.fence, expectedVersion: 2 },
    mutations: [{ kind: "swap", aInstanceId: "a-1", bInstanceId: "c-1" }],
  });
  assert.equal(swapped.ok, true);
  assert.deepEqual(await inventoryOf(store, 1), [
    item("a-1", 1, 5, 2),
    item("b-1", 1, 1, 3),
    item("c-1", 2, 0, 1),
  ]);
  const merged = await core.inventoryMutate("r1", {
    regionId: "r1", opId: opId("inv"),
    participant: { ...c.fence, expectedVersion: 3 },
    mutations: [{ kind: "merge", fromInstanceId: "b-1", intoInstanceId: "a-1" }],
  });
  assert.equal(merged.ok, true);
  const inv = await inventoryOf(store, 1);
  assert.deepEqual(inv, [item("a-1", 1, 5, 5), item("c-1", 2, 0, 1)]);
  assert.equal(inv.reduce((n, i) => n + i.count, 0), 6, "stack counts conserved by merge");
});

test("inventoryMutate atomicity: a failing second mutation rolls back the first; occupied slot and missing item reject", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 0, [
    item("a-1", 1, 0, 2),
    item("b-1", 2, 1, 1),
  ]);
  const before = await snapshot(store, [1]);
  // First mutation validates (move to a free slot); the second targets
  // a missing item — the whole mutation set must not apply.
  expectRejection(
    await core.inventoryMutate("r1", {
      regionId: "r1", opId: opId("inv"), participant: c.fence,
      mutations: [
        { kind: "move", instanceId: "a-1", toSlot: 7 },
        { kind: "move", instanceId: "ghost-1", toSlot: 8 },
      ],
    }),
    "ITEM_NOT_PRESENT",
  );
  await expectUnchanged(store, [1], before);
  // Moving onto an occupied slot is a conflict, also atomic.
  expectRejection(
    await core.inventoryMutate("r1", {
      regionId: "r1", opId: opId("inv"), participant: c.fence,
      mutations: [{ kind: "move", instanceId: "a-1", toSlot: 1 }],
    }),
    "VERSION_CONFLICT",
  );
  await expectUnchanged(store, [1], before);
  // Merging different defs is refused.
  expectRejection(
    await core.inventoryMutate("r1", {
      regionId: "r1", opId: opId("inv"), participant: c.fence,
      mutations: [{ kind: "merge", fromInstanceId: "b-1", intoInstanceId: "a-1" }],
    }),
    "ITEM_NOT_PRESENT",
  );
  await expectUnchanged(store, [1], before);
  // A stale writer (old expectedVersion after a successful mutation).
  const ok = await core.inventoryMutate("r1", {
    regionId: "r1", opId: opId("inv"), participant: c.fence,
    mutations: [{ kind: "move", instanceId: "a-1", toSlot: 3 }],
  });
  assert.equal(ok.ok, true);
  const afterOk = await snapshot(store, [1]);
  expectRejection(
    await core.inventoryMutate("r1", {
      regionId: "r1", opId: opId("inv"), participant: c.fence, // still version 1
      mutations: [{ kind: "move", instanceId: "a-1", toSlot: 4 }],
    }),
    "VERSION_CONFLICT",
  );
  assert.equal(await snapshot(store, [1]), afterOk);
});

// ------------------------------------------------------------ cross-cutting

test("atomic ops preserve the record's other state keys verbatim", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1", RANGE_A);
  const c = await seedCharacter(core, store, "r1", 1, 10, [], { hp: 7, zone: "tavern" });
  const res = await core.lootGrant("r1", {
    regionId: "r1", opId: opId("loot"), participant: c.fence,
    sourceId: "loot:chest-1", instanceId: "key-1", def: 5,
  });
  assert.equal(res.ok, true);
  const rec = await store.getCharacterState(1);
  const state = rec?.state as Record<string, unknown>;
  assert.equal(state.hp, 7);
  assert.equal(state.zone, "tavern");
  assert.equal(state.gold, 10);
});

// ------------------------------------------------------------ store contract

/** The A1 store contract the core relies on, for every store. */
async function atomicStoreContract(store: WorldStore): Promise<void> {
  const now = Date.now();
  const seed = async (characterId: number, gold: number, inventory: InventoryItem[]) => {
    await store.putCharacterState({
      characterId, state: { gold, inventory }, version: 1, epoch: 1,
      regionId: "r1", updatedAt: now,
    });
    await store.putCharacterLock({
      characterId, regionId: "r1", epoch: 1, expiresAt: now + 60_000,
    });
  };
  await seed(1, 100, [item("x-1", 10, 0)]);
  await seed(2, 0, []);
  const fence = (characterId: number): ParticipantFence => ({
    characterId, epoch: 1, expectedVersion: 1,
  });
  const res = await store.tradeCommit({
    regionId: "r1", opId: "contract-trade-1",
    a: fence(1), b: fence(2),
    aGivesGold: 25, bGivesGold: 0, aGivesItems: ["x-1"], bGivesItems: [],
  });
  assert.equal(res.ok, true);
  assert.equal(((await store.getCharacterState(1))?.state as { gold: number }).gold, 75);
  assert.equal(((await store.getCharacterState(2))?.state as { gold: number }).gold, 25);
  assert.deepEqual(
    ((await store.getCharacterState(2))?.state as { inventory: InventoryItem[] }).inventory,
    [item("x-1", 10, 0)],
  );
  const ledger = await store.getAtomicLedger();
  assert.deepEqual(ledger.map((e) => e.seq), [1, 2]);
  // A rejected store-level op appends nothing and changes nothing.
  const before = JSON.stringify({
    records: [await store.getCharacterState(1), await store.getCharacterState(2)],
    ledger: await store.getAtomicLedger(),
  });
  const bad = await store.tradeCommit({
    regionId: "r1", opId: "contract-trade-2",
    a: { ...fence(1), expectedVersion: 2 }, b: { ...fence(2), expectedVersion: 2 },
    aGivesGold: 10000, bGivesGold: 0, aGivesItems: [], bGivesItems: [],
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.rejection, "INSUFFICIENT_FUNDS");
  assert.equal(
    JSON.stringify({
      records: [await store.getCharacterState(1), await store.getCharacterState(2)],
      ledger: await store.getAtomicLedger(),
    }),
    before,
  );

  // Auction pending path + credit drain (fleet auction parity):
  // after the trade above char 1 holds 75 gold / no items at v2 and
  // char 2 holds 25 gold / x-1 at v2. Char 2's lock moves to another
  // region, so a settle by r1 pays char 2 by pending credit only.
  await store.putCharacterLock({
    characterId: 2, regionId: "r2", epoch: 1, expiresAt: now + 60_000,
  });
  const settled = await store.auctionSettle({
    regionId: "r1", opId: "contract-auction-1",
    buyer: { characterId: 1, epoch: 1, expectedVersion: 2 },
    seller: { characterId: 2, epoch: 1, expectedVersion: 2 },
    instanceId: "x-1", price: 20,
  });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.equal(((await store.getCharacterState(1))?.state as { gold: number }).gold, 55, "buyer debited the full price");
  assert.equal(((await store.getCharacterState(2))?.state as { gold: number }).gold, 25, "pending seller's gold untouched");
  assert.deepEqual(
    ((await store.getCharacterState(2))?.state as { inventory: InventoryItem[] }).inventory,
    [],
    "the item left the seller's record",
  );
  const credits = await store.listPendingCredits(2);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].opId, "contract-auction-1");
  assert.equal(credits[0].amount, 19, "credit = proceeds (20 - floor(20 * 0.05) fee)");
  const drained = await store.applyPendingCredits(2);
  assert.equal(drained.total, 19);
  assert.equal(((await store.getCharacterState(2))?.state as { gold: number }).gold, 44, "the drain folded the credit into the record");
  assert.deepEqual(await store.listPendingCredits(2), [], "the drain consumed the credit");
  const again = await store.applyPendingCredits(2);
  assert.equal(again.total, 0, "a second drain folds nothing");

  // Store-level opId replay (the dedup contract): an atomic store
  // method is idempotent by opId on its own, with no core bracket —
  // replaying a committed op returns the stored outcome and applies
  // nothing twice (even with now-stale fences), and a rejected op
  // replays its stored rejection.
  const ledgerBeforeReplay = await store.getAtomicLedger();
  const goldBeforeReplay = ((await store.getCharacterState(1))?.state as { gold: number }).gold;
  const replay = await store.tradeCommit({
    regionId: "r1", opId: "contract-trade-1",
    a: fence(1), b: fence(2),
    aGivesGold: 25, bGivesGold: 0, aGivesItems: ["x-1"], bGivesItems: [],
  });
  assert.deepEqual(replay, res, "store-level replay must return the stored outcome");
  assert.equal(
    ((await store.getCharacterState(1))?.state as { gold: number }).gold,
    goldBeforeReplay,
    "replay re-applied the trade",
  );
  assert.equal(
    (await store.getAtomicLedger()).length,
    ledgerBeforeReplay.length,
    "replay appended ledger entries",
  );
  const badReplay = await store.tradeCommit({
    regionId: "r1", opId: "contract-trade-2",
    a: { ...fence(1), expectedVersion: 2 }, b: { ...fence(2), expectedVersion: 2 },
    aGivesGold: 10000, bGivesGold: 0, aGivesItems: [], bGivesItems: [],
  });
  assert.deepEqual(badReplay, bad, "a rejected op must replay its stored rejection");
}

test("atomic store contract: memory", async () => {
  await atomicStoreContract(new MemoryWorldStore());
});

test("atomic store contract: SurrealDB (embedded, or WORLD_TEST_DB_URL)", async () => {
  const store = new SurrealWorldStore(surrealTestOptions("atomic_" + Date.now()));
  try {
    await store.connect();
    await atomicStoreContract(store);
  } finally {
    await store.close();
  }
});
