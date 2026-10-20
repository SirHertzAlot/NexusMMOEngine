/**
 * Fleet auction parity (slice 2): the world-tier `auctionSettle`
 * must price a sale EXACTLY like the standalone AuctionSystem —
 * same buyer debit, same seller credit, same house fee — because a
 * listing must not change value when its sale crosses tiers.
 *
 * Standalone side: the real AuctionSystem over a real WalletSystem
 * with a minimal in-memory AuctionItems fake; its settle takes
 * AUCTION_FEE off the top (fee = floor(price * AUCTION_FEE), a sink).
 * Fleet side: the real WorldCoreImpl + MemoryWorldStore driven
 * through WorldAtomicOps (direct seller path: both characters locked
 * by the initiating region, valid fences). Its fee is read from the
 * world ledger's AUCTION_HOUSE_SINK leg, not recomputed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import {
  AUCTION_HOUSE_CUT_RATE,
  AUCTION_HOUSE_SINK,
  MemoryWorldStore,
  WorldCoreImpl,
  type AtomicOpResult,
  type CharacterSessionLock,
  type CharacterStateRecord,
  type ParticipantFence,
} from "@mmo-engine/world-server";
import {
  WorldAtomicOps,
  type AtomicFenceSource,
  type AtomicWorldClient,
} from "../src/world/atomic-ops.js";
import { AuctionSystem, AUCTION_FEE, type AuctionItems } from "../src/economy/auction.js";
import { WalletSystem } from "../src/economy/wallet.js";

const API_KEY = "parity-test-bootstrap-key";
const RANGE_A = { x0: 0, x1: 100, z0: 0, z1: 100 };
const BUYER = 1;
const SELLER = 2;
const BUYER_START = 2000;
const SELLER_START = 100;

let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

let opCounter = 0;
const nextOpId = (tag: string): string => `${tag}-${++opCounter}`;

// ---------------------------------------------------------------------------
// Standalone settle
// ---------------------------------------------------------------------------

class FakeAuctionItems implements AuctionItems {
  private readonly bags = new Map<number, Set<number>>();
  constructor(
    private readonly defs: Map<number, number>,
    seed: Array<[number, number]>,
  ) {
    for (const [charId, itemId] of seed) {
      const bag = this.bags.get(charId) ?? new Set<number>();
      bag.add(itemId);
      this.bags.set(charId, bag);
    }
  }
  owns(charId: number, itemId: number): boolean {
    return this.bags.get(charId)?.has(itemId) ?? false;
  }
  freeSlots(_charId: number): number {
    return 20;
  }
  defOf(itemId: number): number {
    return this.defs.get(itemId) ?? -1;
  }
  move(itemId: number, from: number, to: number): boolean {
    if (!this.owns(from, itemId)) return false;
    this.bags.get(from)!.delete(itemId);
    const bag = this.bags.get(to) ?? new Set<number>();
    bag.add(itemId);
    this.bags.set(to, bag);
    return true;
  }
  nameOf(def: number): string {
    return `def ${def}`;
  }
}

function standaloneSettle(price: number): { buyerDebit: number; sellerCredit: number; fee: number } {
  const wallet = new WalletSystem();
  wallet.grant(BUYER, BUYER_START, 0);
  wallet.grant(SELLER, SELLER_START, 0);
  const items = new FakeAuctionItems(new Map([[42, 7]]), [[SELLER, 42]]);
  const auction = new AuctionSystem(wallet, items);
  const listingId = auction.list(SELLER, 42, Math.min(price, 100), price, 60_000, 0);
  assert.notEqual(listingId, null, "the listing was created");
  const err = auction.buyout(BUYER, listingId!, 1);
  assert.equal(err, null, `standalone buyout at ${price}`);
  const buyerDebit = BUYER_START - wallet.balanceOf(BUYER);
  const sellerCredit = wallet.balanceOf(SELLER) - SELLER_START;
  return { buyerDebit, sellerCredit, fee: buyerDebit - sellerCredit };
}

// ---------------------------------------------------------------------------
// Fleet settle (WorldCoreImpl + MemoryWorldStore via WorldAtomicOps)
// ---------------------------------------------------------------------------

/** An AtomicWorldClient that calls the real core in-process. */
class DirectWorldClient implements AtomicWorldClient {
  constructor(
    private readonly core: WorldCoreImpl,
    private readonly regionId: string,
  ) {}

  private async call(
    method: "tradeCommit" | "vendorTransact" | "auctionSettle" | "craftExecute" | "lootGrant" | "inventoryMutate",
    input: Record<string, unknown>,
  ): Promise<AtomicOpResult> {
    return this.core[method](this.regionId, {
      regionId: this.regionId,
      opId: nextOpId(method),
      ...input,
    } as never);
  }

  tradeCommit(input: never): Promise<AtomicOpResult> {
    return this.call("tradeCommit", input);
  }
  vendorTransact(input: never): Promise<AtomicOpResult> {
    return this.call("vendorTransact", input);
  }
  auctionSettle(input: never): Promise<AtomicOpResult> {
    return this.call("auctionSettle", input);
  }
  craftExecute(input: never): Promise<AtomicOpResult> {
    return this.call("craftExecute", input);
  }
  lootGrant(input: never): Promise<AtomicOpResult> {
    return this.call("lootGrant", input);
  }
  inventoryMutate(input: never): Promise<AtomicOpResult> {
    return this.call("inventoryMutate", input);
  }
  async getCharacterLock(characterId: number): Promise<CharacterSessionLock | null> {
    return this.core.getCharacterLock(this.regionId, { regionId: this.regionId, characterId });
  }
  async getCharacterState(characterId: number): Promise<CharacterStateRecord | null> {
    return this.core.getCharacterState(this.regionId, { regionId: this.regionId, characterId });
  }
}

async function fleetSettle(price: number): Promise<{ buyerDebit: number; sellerCredit: number; fee: number }> {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 60_000,
    heartbeatIntervalMs: 60_000,
    apiKeyHash: await apiKeyHash(),
  });
  await core.registerRegion({
    regionId: "r1",
    chunkRange: RANGE_A,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: API_KEY,
    opId: nextOpId("register"),
  });
  const fences = new Map<number, ParticipantFence>();
  const fenceSource: AtomicFenceSource = {
    async fence(characterId: number): Promise<ParticipantFence | null> {
      return fences.get(characterId) ?? null;
    },
    applySettled(result: AtomicOpResult): void {
      if (!result.ok) return;
      for (const record of result.characters) {
        const held = fences.get(record.characterId);
        if (held) fences.set(record.characterId, { ...held, expectedVersion: record.version });
      }
    },
  };
  const seed = async (characterId: number, gold: number, withItem: boolean): Promise<void> => {
    const lock = await core.acquireCharacterLock("r1", {
      regionId: "r1",
      characterId,
      ttlMs: 60_000,
      opId: nextOpId("lock"),
    });
    await store.putCharacterState({
      characterId,
      state: {
        gold,
        inventory: withItem
          ? [{ instanceId: "item-42", def: 7, slot: 0, count: 1 }]
          : [],
      },
      version: 1,
      epoch: lock.epoch,
      regionId: "r1",
      updatedAt: Date.now(),
    });
    fences.set(characterId, { characterId, epoch: lock.epoch, expectedVersion: 1 });
  };
  await seed(BUYER, BUYER_START, false);
  await seed(SELLER, SELLER_START, true);

  const ops = new WorldAtomicOps({ client: new DirectWorldClient(core, "r1"), fences: fenceSource });
  const result = await ops.auction({ buyer: BUYER, seller: SELLER, instanceId: "item-42", price });
  assert.equal(result.ok, true, `fleet settle at ${price}: ${JSON.stringify(result)}`);
  const goldOf = async (characterId: number): Promise<number> => {
    const rec = await store.getCharacterState(characterId);
    return (rec?.state as { gold: number }).gold;
  };
  const buyerDebit = BUYER_START - (await goldOf(BUYER));
  const sellerCredit = (await goldOf(SELLER)) - SELLER_START;
  const ledger = await store.getAtomicLedger();
  const fee = ledger
    .filter((e) => e.kind === "gold" && e.to === AUCTION_HOUSE_SINK)
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);
  return { buyerDebit, sellerCredit, fee };
}

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

test("AUCTION_HOUSE_CUT_RATE mirrors AUCTION_FEE", () => {
  assert.equal(AUCTION_HOUSE_CUT_RATE, AUCTION_FEE);
  assert.equal(AUCTION_HOUSE_SINK, "system:auction-house");
});

test("fleet auction settle matches the standalone settle, number for number, across prices", async () => {
  for (const price of [1, 19, 20, 21, 99, 100, 101, 999]) {
    const standalone = standaloneSettle(price);
    const fleet = await fleetSettle(price);
    assert.equal(fleet.buyerDebit, standalone.buyerDebit, `price ${price}: buyer debit`);
    assert.equal(fleet.sellerCredit, standalone.sellerCredit, `price ${price}: seller credit`);
    assert.equal(fleet.fee, standalone.fee, `price ${price}: house fee`);
    assert.equal(standalone.fee, Math.floor(price * AUCTION_FEE), `price ${price}: fee = floor(price * rate)`);
    assert.equal(standalone.buyerDebit, price, `price ${price}: the buyer always pays the full price`);
    assert.equal(standalone.sellerCredit + standalone.fee, price, `price ${price}: debit = proceeds + fee`);
  }
});
