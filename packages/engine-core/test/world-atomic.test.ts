/**
 * Atomic operations A2: region integration.
 *
 * - WorldClient: the six operations ride one transport call each,
 *   regionId + opId are injected, a settled outcome (success OR a
 *   typed rejection) returns as a value, and a transport failure
 *   throws — an outage is distinguishable from a rejection.
 * - Service level (fake transport over the REAL world core): vendor,
 *   auction (cross-shard seller), craft and grant happy paths commit
 *   at the world tier and reconcile the local caches; a typed
 *   rejection and an outage fail closed with nothing moved; a stolen
 *   lock fences the stale holder; two racing logins admit exactly
 *   one owner.
 * - Gateway level over a REAL HTTP world server: a two-gateway trade
 *   commits via tradeCommit and the settled outcome seeds the second
 *   gateway at login; vendor and auction happy paths run over the
 *   wire in fleet mode; an outage at the completing accept refuses
 *   the trade and moves nothing.
 * - Standalone: a gateway with no world wiring settles locally and
 *   a counting world client is never touched.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import * as argon2 from "argon2";
import express from "express";
import { addComponent } from "bitecs";
import {
  decodeControl,
  encodeControl,
  MessageType,
  PROTOCOL_VERSION,
  type AccountMessage,
  type AuctionMessage,
  type ErrorMessage,
  type TradeMessage,
  type VendorMessage,
  type WalletMessage,
} from "@mmo-engine/protocol";
import { engineDefaults, type LootRules } from "@mmo-engine/rules";
import {
  MemoryWorldStore,
  WorldCoreImpl,
  WorldError,
  createWebrpcRouter,
  type AtomicOpResult,
  type CharacterStateRecord,
  type CharacterSessionLock,
} from "@mmo-engine/world-server";
import { Gateway } from "../src/net/gateway.js";
import * as C from "../src/components.js";
import { MemoryCharacterStore } from "../src/index.js";
import type { CharacterState } from "../src/characters/store.js";
import {
  WorldClient,
  WorldTransportError,
  type WorldTransport,
} from "../src/world/client.js";
import { WebrpcWorldTransport } from "../src/world/webrpc-transport.js";
import {
  WorldCharacterSync,
  economyOfState,
  type CharacterWorldClient,
} from "../src/world/character-sync.js";
import {
  LocalEconomyView,
  WorldAtomicOps,
  itemInstanceId,
} from "../src/world/atomic-ops.js";
import { WalletSystem } from "../src/economy/wallet.js";
import { TradeSystem } from "../src/economy/trade.js";
import { VendorSystem } from "../src/economy/vendor.js";
import { AuctionSystem } from "../src/economy/auction.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../src/items/index.js";
import { CraftingService } from "../src/crafting/crafting-service.js";
import { HeadlessClient, type HelloAuth } from "./net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./net/auth-harness.js";

const RANGE_A = { x0: 0, z0: 0, x1: 100, z1: 100 };
const RANGE_B = { x0: 100, z0: 0, x1: 200, z1: 100 };
const API_KEY = "a2-test-bootstrap-key";
const STATE_A: CharacterState = { x: 1, y: 2, z: 3, health: 50, stamina: 60 };

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Cleanups run newest first, so regions deregister before the world closes. */
function cleanups(t: TestContext): (fn: () => Promise<unknown> | unknown) => void {
  const fns: Array<() => Promise<unknown> | unknown> = [];
  t.after(async () => {
    for (const fn of fns.reverse()) await fn();
  });
  return (fn) => fns.push(fn);
}

async function until(fn: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Item defs (mirrors test/items/items.test.ts): def 0 sword/common,
// def 1 sword/rare, def 2 ring/common.
// ---------------------------------------------------------------------------

const RULES = (() => {
  const r = engineDefaults();
  r.items.bases.sword = {
    ...r.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01", "pack/SM_Wep_Sword_02"],
  };
  return r;
})();

function poolItem(id: string, base: string, rank: string, source: string, seed: number): PoolItemLike {
  return {
    id, rank, source, item: base, seed,
    bundle: { Identity: { id, name: `${rank} ${base} ${id}`, base }, Rank: { id: rank, color: "#ffffff" }, Stats: {} },
  };
}

const POOL: PoolItemLike[] = [
  poolItem("a", "sword", "common", "mob", 0),
  poolItem("b", "sword", "rare", "boss", 1),
  poolItem("c", "ring", "common", "mob", 2),
];

const LOOT: LootRules = {
  ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 20, maxGroundItems: 100,
};

// ---------------------------------------------------------------------------
// Fake transport backed by the real world core + in-memory store
// (P4's CoreTransport, extended with the A1 atomic ops and lock reads)
// ---------------------------------------------------------------------------

class CoreTransport implements WorldTransport {
  /** Test switch: atomic calls fail as a world outage would. */
  failAtomic = false;

  constructor(private readonly core: WorldCoreImpl) {}

  private input(args: Record<string, unknown>): Record<string, any> {
    return (args["input"] ?? args) as Record<string, any>;
  }

  private async caller(token: string | undefined): Promise<string> {
    const regionId = token ? await this.core.authenticate(token) : null;
    if (!regionId) throw new WorldTransportError(401, "unauthorized");
    return regionId;
  }

  async call(
    method: string,
    args: Record<string, unknown>,
    token?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const input = this.input(args);
      switch (method) {
        case "RegisterRegion":
          return { lease: await this.core.registerRegion(input as never) };
        case "DeregisterRegion": {
          const caller = await this.caller(token);
          await this.core.deregisterRegion(caller, String(args["opId"] ?? input["opId"]));
          return {};
        }
        case "Heartbeat": {
          const caller = await this.caller(token);
          if (caller !== input["regionId"]) {
            throw new WorldTransportError(403, "regionId does not match token");
          }
          return { ack: await this.core.heartbeat(input as never) };
        }
        case "AcquireCharacterLock":
          return { lock: await this.core.acquireCharacterLock(await this.caller(token), input as never) };
        case "ReleaseCharacterLock":
          await this.core.releaseCharacterLock(await this.caller(token), input as never);
          return {};
        case "GetCharacterState":
          return { character: await this.core.getCharacterState(await this.caller(token), input as never) };
        case "GetCharacterLock":
          return { lock: await this.core.getCharacterLock(await this.caller(token), input as never) };
        case "PutCharacterState":
          return { character: await this.core.putCharacterState(await this.caller(token), input as never) };
        case "TradeCommit":
        case "VendorTransact":
        case "AuctionSettle":
        case "CraftExecute":
        case "LootGrant":
        case "InventoryMutate": {
          if (this.failAtomic) throw new WorldTransportError(503, "world unavailable (test outage)");
          const caller = await this.caller(token);
          const op = {
            TradeCommit: "tradeCommit",
            VendorTransact: "vendorTransact",
            AuctionSettle: "auctionSettle",
            CraftExecute: "craftExecute",
            LootGrant: "lootGrant",
            InventoryMutate: "inventoryMutate",
          }[method] as "tradeCommit";
          return { result: await this.core[op](caller, input as never) };
        }
        default:
          throw new WorldTransportError(501, `${method} not implemented by fake transport`);
      }
    } catch (err) {
      if (err instanceof WorldError) {
        throw new WorldTransportError(err.code, err.message);
      }
      throw err;
    }
  }
}

let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

interface WorldRig {
  store: MemoryWorldStore;
  transport: CoreTransport;
}

async function makeWorld(): Promise<WorldRig> {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 60_000,
    heartbeatIntervalMs: 60_000,
    apiKeyHash: await apiKeyHash(),
  });
  return { store, transport: new CoreTransport(core) };
}

function makeClient(
  transport: WorldTransport,
  regionId: string,
  range: typeof RANGE_A,
): WorldClient {
  return new WorldClient({
    transport,
    regionId,
    chunkRange: range,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: API_KEY,
    heartbeatIntervalMs: 60_000,
    onError: () => {},
  });
}

// ---------------------------------------------------------------------------
// A region rig: character store + wallet + items + sync (with the
// economy view) + atomic-ops coordinator + the three economy systems,
// wired exactly as server.ts wires them in fleet mode.
// ---------------------------------------------------------------------------

interface Rig {
  client: WorldClient;
  store: MemoryCharacterStore;
  wallet: WalletSystem;
  defs: ItemDefs;
  items: ItemService;
  sync: WorldCharacterSync;
  ops: WorldAtomicOps;
  trade: TradeSystem;
  vendor: VendorSystem;
  auction: AuctionSystem;
}

function makeRig(client: WorldClient, opts?: { lockTtlMs?: number }): Rig {
  const store = new MemoryCharacterStore();
  const wallet = new WalletSystem();
  const defs = new ItemDefs(POOL, RULES);
  let opsRef: WorldAtomicOps | null = null;
  const items = new ItemService({
    defs,
    loot: LOOT,
    tickHz: 30,
    // The grant executor, as server.ts wires it: delegate to the
    // coordinator, mapping a settled rejection to the result shape.
    atomicGrant: {
      loot: async (character, sourceId, instanceId, def) => {
        if (!opsRef) throw new Error("atomic ops not wired");
        const r = await opsRef.loot({ character, sourceId, instanceId, def });
        return r.ok
          ? { ok: true as const }
          : { ok: false as const, message: `grant refused by the world (${r.rejection}: ${r.message})` };
      },
    },
  });
  const view = new LocalEconomyView({
    wallet,
    store: items.store,
    durabilityOf: (def) => defs.durability[def] ?? 100,
  });
  const sync = new WorldCharacterSync({
    client,
    store,
    economy: view,
    lockTtlMs: opts?.lockTtlMs,
    log: () => {},
  });
  const ops = new WorldAtomicOps({ client, fences: sync });
  opsRef = ops;
  const trade = new TradeSystem(wallet, {
    owns: (c, item) => items.store.inBagOf(c, item),
    freeSlots: (c) => items.store.emptySlots(c),
    move: (item, from, to) => {
      if (!items.store.inBagOf(from, item)) return false;
      return items.store.putInBag(to, item) >= 0;
    },
  });
  const vendor = new VendorSystem(wallet, {
    give: (c, def) => items.give(c, def).ok,
    take: (c, item) => {
      if (!items.store.inBagOf(c, item)) return false;
      items.store.destroy(item);
      return true;
    },
    defOf: (item) => {
      const slot = items.store.slot(item);
      return slot < 0 ? -1 : items.store.defs[slot];
    },
    nameOf: (def) => defs.names[def] ?? `item ${def}`,
  });
  vendor.define({
    id: "general",
    name: "General Goods",
    buybackRate: 0.5,
    stock: [
      { def: 0, price: 100, quantity: -1 },
      { def: 1, price: 5000, quantity: -1 },
    ],
  });
  const auction = new AuctionSystem(wallet, {
    owns: (c, item) => items.store.inBagOf(c, item),
    freeSlots: (c) => items.store.emptySlots(c),
    defOf: (item) => {
      const slot = items.store.slot(item);
      return slot < 0 ? -1 : items.store.defs[slot];
    },
    move: (item, from, to) => {
      if (!items.store.inBagOf(from, item)) return false;
      return items.store.putInBag(to, item) >= 0;
    },
    nameOf: (def) => defs.names[def] ?? `item ${def}`,
  });
  return { client, store, wallet, defs, items, sync, ops, trade, vendor, auction };
}

/**
 * Log a character in on a rig and establish its economy at the world
 * tier: gold + items exist locally, then one working save uploads
 * them. Returns the created item ids.
 */
async function seedCharacter(
  rig: Rig,
  characterId: number,
  gold: number,
  itemDefs: number[],
): Promise<number[]> {
  rig.store.saveState(characterId, STATE_A);
  const login = await rig.sync.login(characterId);
  assert.equal(login.ok, true, `login for character ${characterId}`);
  if (gold > 0) rig.wallet.grant(characterId, gold, 1);
  const ids = itemDefs.map((def) => {
    const id = rig.items.store.create(def, rig.defs.durability[def]);
    rig.items.store.putInBag(characterId, id);
    return id;
  });
  assert.equal(await rig.sync.save(characterId), true, "seed save uploads the economy");
  return ids;
}

async function worldEconomy(
  worldStore: MemoryWorldStore,
  characterId: number,
): Promise<{ version: number; gold: number; inventory: Array<{ instanceId: string; def: number; slot: number; count: number }> } | null> {
  const rec = await worldStore.getCharacterState(characterId);
  if (!rec) return null;
  const eco = economyOfState(rec.state);
  return eco ? { version: rec.version, ...eco } : null;
}

// ---------------------------------------------------------------------------
// WorldClient: the six operations' call/rejection shapes
// ---------------------------------------------------------------------------

test("WorldClient atomic ops: one call each, regionId + opId injected, settled outcomes returned, outages thrown", async (t) => {
  const defer = cleanups(t);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let fail = false;
  let nextResult: AtomicOpResult = {
    ok: false, opId: "stub", op: "tradeCommit", rejection: "INSUFFICIENT_FUNDS", message: "no gold",
  } as AtomicOpResult;
  const stub: WorldTransport = {
    async call(method, args) {
      if (method === "RegisterRegion") {
        return {
          lease: {
            regionId: "region-a", chunkRange: RANGE_A, heartbeatIntervalMs: 60_000,
            registryVersion: 1, token: "tok", epoch: 1, expiresAt: Date.now() + 60_000,
          },
        };
      }
      if (method === "DeregisterRegion" || method === "Heartbeat") return {};
      calls.push({ method, args });
      if (fail) throw new WorldTransportError(503, "world down");
      return { result: nextResult };
    },
  };
  const client = new WorldClient({
    transport: stub, regionId: "region-a", chunkRange: RANGE_A, endpoint: "",
    capacity: 100, apiKey: API_KEY, heartbeatIntervalMs: 60_000, onError: () => {},
  });
  await client.start();
  defer(() => client.stop());

  const fence = { characterId: 7, epoch: 3, expectedVersion: 2 };
  const settled = await client.tradeCommit({
    a: fence, b: { ...fence, characterId: 8 }, aGivesGold: 1, bGivesGold: 2, aGivesItems: [], bGivesItems: [],
  });
  assert.equal(settled.ok, false, "a typed rejection returns as a value, not a throw");
  if (!settled.ok) assert.equal(settled.rejection, "INSUFFICIENT_FUNDS");
  assert.equal(calls.length, 1, "one operation = one transport call");
  assert.equal(calls[0].method, "TradeCommit");
  const sent = (calls[0].args as { input: Record<string, unknown> }).input;
  assert.equal(sent["regionId"], "region-a", "the client injects its own regionId");
  assert.equal(typeof sent["opId"], "string");
  assert.ok((sent["opId"] as string).length > 0, "the client mints an opId");

  nextResult = { ok: true, opId: "stub", op: "lootGrant", characters: [], ledger: [] } as AtomicOpResult;
  const granted = await client.lootGrant({ participant: fence, sourceId: "system:grant", instanceId: "item-1", def: 0 });
  assert.equal(granted.ok, true);
  assert.equal(calls[1].method, "LootGrant");

  fail = true;
  await assert.rejects(
    client.vendorTransact({ participant: fence, vendorId: "general", direction: "buy", def: 0, price: 1, instanceId: "item-2" }),
    (err: unknown) => err instanceof WorldTransportError && err.code === 503,
    "a transport failure throws — distinguishable from a rejection",
  );
});

// ---------------------------------------------------------------------------
// Service level: happy paths commit at the world tier
// ---------------------------------------------------------------------------

test("auction settle: buyer on one shard, seller on another — the world commits, both shards reconcile", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  const clientB = makeClient(transport, "region-b", RANGE_B);
  await clientA.start();
  await clientB.start();
  defer(() => clientB.stop());
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  const b = makeRig(clientB);

  const [sword] = await seedCharacter(a, 7, 0, [0]);
  await seedCharacter(b, 8, 1000, []);
  const listingId = a.auction.list(7, sword, 100, 300, 60_000, 1);
  assert.notEqual(listingId, null);

  // The buyer's region settles: the seller's fence is read from the
  // world's own lock + record (cross-shard), the buyer's from its
  // sync. One world transaction moves gold and the item.
  const result = await a.ops.auction({
    buyer: 8, seller: 7, instanceId: itemInstanceId(sword), price: 300,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  a.auction.settleFromWorld(listingId!, 8, 2);
  assert.equal(a.auction.browse().length, 0, "the listing closed as sold");

  const sellerWorld = await worldEconomy(worldStore, 7);
  const buyerWorld = await worldEconomy(worldStore, 8);
  assert.equal(sellerWorld?.gold, 300, "the seller received the full price at the world tier");
  assert.equal(buyerWorld?.gold, 700);
  assert.deepEqual(buyerWorld?.inventory.map((i) => i.instanceId), [itemInstanceId(sword)]);
  assert.equal(sellerWorld?.inventory.length, 0);

  // The initiating shard reconciled its held participant at once.
  assert.equal(a.wallet.balanceOf(7), 300);
  assert.equal(a.items.store.inBagOf(7, sword), false);
  // The buyer's shard still holds its pre-settle cache — until its
  // next save, which refreshes from the world BEFORE writing, so
  // the settled outcome is adopted, never overwritten.
  assert.equal(b.wallet.balanceOf(8), 1000, "buyer cache untouched until its own save");
  assert.equal(await b.sync.save(8), true);
  assert.equal(b.wallet.balanceOf(8), 700, "buyer cache reconciled to the settled outcome");
  assert.equal(b.items.store.inBagOf(8, sword), true, "the item materialised in the buyer's bag");
  const buyerAfter = await worldEconomy(worldStore, 8);
  assert.equal(buyerAfter?.gold, 700, "the buyer's save did not revert the settlement");
  assert.deepEqual(buyerAfter?.inventory.map((i) => i.instanceId), [itemInstanceId(sword)]);
  const ledger = await worldStore.getAtomicLedger();
  assert.ok(ledger.some((e) => e.op === "auctionSettle"), "the settlement is in the world item ledger");
});

test("craft execution in fleet mode commits via craftExecute; standalone crafts locally with no world write", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  const [mat1, mat2] = await seedCharacter(a, 7, 100, [0, 0]);

  const fleet = new CraftingService({
    wallet: a.wallet,
    items: a.items,
    atomicCraft: {
      craft: async (character, consumes, goldFee, outputs) => {
        const r = await a.ops.craft({ character, consumes, goldFee, outputs });
        return r.ok ? { ok: true as const } : { ok: false as const, message: `craft refused by the world (${r.rejection}: ${r.message})` };
      },
    },
  });
  const crafted = await fleet.craft(7, { consumes: [mat1], goldFee: 10, outputs: [2] }, 2);
  assert.equal(crafted.ok, true, JSON.stringify(crafted));
  const produced = crafted.ok ? crafted.produced[0] : -1;
  assert.equal(a.items.store.inBagOf(7, mat1), false, "the consumed input left the bag");
  assert.equal(a.items.store.exists(mat1), false, "the consumed input was destroyed by the settled outcome");
  assert.equal(a.items.store.inBagOf(7, mat2), true, "the other input is untouched");
  assert.equal(a.items.store.inBagOf(7, produced), true, "the output materialised in the bag");
  assert.equal(a.wallet.balanceOf(7), 90, "the fee was charged exactly once");
  const world = await worldEconomy(worldStore, 7);
  assert.equal(world?.gold, 90);
  assert.deepEqual(
    world?.inventory.map((i) => i.instanceId).sort(),
    [itemInstanceId(mat2), itemInstanceId(produced)].sort(),
  );

  // Standalone: no executor — the same service crafts locally and
  // the world record does not move.
  const [mat3] = await seedCharacter(a, 8, 50, [0]);
  const versionBefore = (await worldStore.getCharacterState(8))!.version;
  const local = new CraftingService({ wallet: a.wallet, items: a.items });
  const done = await local.craft(8, { consumes: [mat3], goldFee: 5, outputs: [2] }, 3);
  assert.equal(done.ok, true);
  assert.equal(a.wallet.balanceOf(8), 45);
  assert.equal((await worldStore.getCharacterState(8))!.version, versionBefore, "no world call, no world write");
});

test("grant path: giveGranted commits via lootGrant; an outage grants nothing", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  await seedCharacter(a, 7, 50, []);

  const sizeBefore = a.items.store.size;
  const granted = await a.items.giveGranted(7, 0);
  assert.equal(granted.ok, true, JSON.stringify(granted));
  const bag = [...a.items.store.bag(7)].filter((id) => id !== 0);
  assert.equal(bag.length, 1, "the granted item is in the bag");
  const world = await worldEconomy(worldStore, 7);
  assert.deepEqual(world?.inventory.map((i) => i.instanceId), [itemInstanceId(bag[0])]);
  assert.equal(world?.gold, 50, "a grant moves no gold");

  // Outage at the commit step: fail closed — no item, no leftovers.
  transport.failAtomic = true;
  const refused = await a.items.giveGranted(7, 1);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /world tier is unreachable/);
  assert.equal(a.items.store.size, sizeBefore + 1, "the failed grant's allocation was destroyed");
  assert.equal([...a.items.store.bag(7)].filter((id) => id !== 0).length, 1, "the bag is unchanged");
  transport.failAtomic = false;

  // Without an executor (standalone), giveGranted is exactly give.
  const bare = new ItemService({ defs: a.defs, loot: LOOT, tickHz: 30 });
  const local = await bare.giveGranted(9, 0);
  assert.equal(local.ok, true);
  assert.equal([...bare.store.bag(9)].filter((id) => id !== 0).length, 1);
});

test("inventory mutate: a slot move commits via inventoryMutate and reconciles the local bag", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  const [sword] = await seedCharacter(a, 7, 0, [0]);
  const result = await a.ops.inventory({
    character: 7,
    mutations: [{ kind: "move", instanceId: itemInstanceId(sword), toSlot: 5 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(a.items.store.bag(7)[5], sword, "the local bag follows the settled outcome");
  const world = await worldEconomy(worldStore, 7);
  assert.equal(world?.inventory[0]?.slot, 5);
});

// ---------------------------------------------------------------------------
// Fail closed: rejections, fencing, ownership
// ---------------------------------------------------------------------------

test("typed rejection: the world's INSUFFICIENT_FUNDS returns as a value and nothing moves locally", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  await seedCharacter(a, 7, 50, []);
  // Gold granted locally but never uploaded: the region believes
  // 1050, the world record holds 50. The world is truth.
  a.wallet.grant(7, 1000, 2);
  const allocated = a.items.store.create(1, a.defs.durability[1]);
  const result = await a.ops.vendor({
    character: 7, vendorId: "general", direction: "buy", def: 1, price: 500,
    instanceId: itemInstanceId(allocated),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection, "INSUFFICIENT_FUNDS");
  assert.equal(a.wallet.balanceOf(7), 1050, "a rejection reconciles nothing — the local cache stands");
  assert.equal(a.items.store.inBagOf(7, allocated), false);
  a.items.store.destroy(allocated);
  const world = await worldEconomy(worldStore, 7);
  assert.equal(world?.gold, 50);
  assert.equal(world?.inventory.length, 0);
});

test("stale expected version: the world rejects VERSION_CONFLICT and both records stand", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  await seedCharacter(a, 7, 100, []);
  await seedCharacter(a, 8, 100, []);
  const epoch = a.sync.lockEpoch(7)!;
  const result = await clientA.tradeCommit({
    a: { characterId: 7, epoch, expectedVersion: 0 }, // the record is at v1
    b: { characterId: 8, epoch: a.sync.lockEpoch(8)!, expectedVersion: 1 },
    aGivesGold: 10, bGivesGold: 0, aGivesItems: [], bGivesItems: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection, "VERSION_CONFLICT");
  assert.equal((await worldEconomy(worldStore, 7))?.gold, 100);
  assert.equal((await worldEconomy(worldStore, 8))?.gold, 100);
});

test("stolen lock: the stale holder is fenced — no fence, no uphill writes", async (t) => {
  const defer = cleanups(t);
  const { transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  const clientB = makeClient(transport, "region-b", RANGE_B);
  await clientA.start();
  await clientB.start();
  defer(() => clientB.stop());
  defer(() => clientA.stop());
  const a = makeRig(clientA, { lockTtlMs: 150 });
  const b = makeRig(clientB);
  await seedCharacter(a, 7, 100, []);

  await sleep(250); // A's lock expires; B steals it with a bumped epoch.
  assert.equal((await b.sync.login(7)).ok, true);
  assert.equal(await a.sync.fence(7), null, "a fenced holder mints no fence");
  assert.equal(await a.sync.save(7), false, "a fenced holder writes nothing uphill");
  assert.equal(a.sync.isFenced(7), true);
  assert.equal(await b.sync.logout(7), true);
});

test("exactly one owner: two racing logins for one character admit exactly one holder", async (t) => {
  const defer = cleanups(t);
  const { transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  const clientB = makeClient(transport, "region-b", RANGE_B);
  await clientA.start();
  await clientB.start();
  defer(() => clientB.stop());
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  const b = makeRig(clientB);
  a.store.saveState(9, STATE_A);
  b.store.saveState(9, STATE_A);
  const [ra, rb] = await Promise.all([a.sync.login(9), b.sync.login(9)]);
  assert.equal([ra, rb].filter((r) => r.ok).length, 1, "exactly one region holds the character");
  const winner = ra.ok ? a : b;
  assert.equal(await winner.sync.logout(9), true);
});

// ---------------------------------------------------------------------------
// Gateway level
// ---------------------------------------------------------------------------

const LOOK = { gender: "female", parts: {}, colours: {} };
const creds = (username: string): HelloAuth => ({ username, password: TEST_PASSWORD });

interface GatewayRig {
  gw: Gateway;
  url: string;
  pump: (frames?: number) => Promise<void>;
  /** Advance the gateway clock and run one frame at the new time. */
  elapse: (ms: number) => void;
}

async function makeGatewayRig(t: TestContext, rig: Rig, defer: (fn: () => unknown) => void): Promise<GatewayRig> {
  let now = 1_000_000;
  const gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    characterStore: rig.store,
    worldCharacters: rig.sync,
    atomicOps: rig.ops,
    systems: [rig.wallet, rig.trade, rig.vendor, rig.auction],
    items: rig.items,
  });
  defer(() => gw.close());
  const port = await gw.listen();
  gw.frame(now);
  return {
    gw,
    url: `ws://127.0.0.1:${port}`,
    elapse: (ms) => {
      now += ms;
      gw.frame(now);
    },
    pump: async (frames = 3) => {
      await sleep(120);
      for (let i = 0; i < frames; i++) {
        now += 34;
        gw.frame(now);
      }
      await sleep(120);
    },
  };
}

async function createAndEnter(
  url: string,
  username: string,
  name: string,
): Promise<{ c: HeadlessClient; id: number }> {
  const c = new HeadlessClient();
  await c.connect(url);
  const acct = c.waitFor(MessageType.Account, 1);
  c.sendRaw(
    MessageType.Hello,
    encodeControl({
      protocol: PROTOCOL_VERSION,
      client: "test",
      want_snapshot: true,
      characters: true,
      username,
      password: TEST_PASSWORD,
    }),
  );
  await acct;
  const made = c.waitFor(MessageType.Account, 1);
  c.sendRaw(MessageType.CreateCharacter, encodeControl({ name, look: LOOK }));
  const id = decodeControl<AccountMessage>((await made)[0]).characters[0].id;
  const snapshot = c.waitFor(MessageType.Snapshot, 1);
  c.sendRaw(MessageType.EnterWorld, encodeControl({ character: id }));
  await snapshot;
  return { c, id };
}

async function enterExisting(
  url: string,
  username: string,
  id: number,
): Promise<{ c: HeadlessClient }> {
  const c = new HeadlessClient();
  await c.connect(url);
  const acct = c.waitFor(MessageType.Account, 1);
  c.sendRaw(
    MessageType.Hello,
    encodeControl({
      protocol: PROTOCOL_VERSION,
      client: "test",
      want_snapshot: true,
      characters: true,
      username,
      password: TEST_PASSWORD,
    }),
  );
  await acct;
  const snapshot = c.waitFor(MessageType.Snapshot, 1);
  c.sendRaw(MessageType.EnterWorld, encodeControl({ character: id }));
  await snapshot;
  return { c };
}

async function worldHttpServer(defer: (fn: () => unknown) => void): Promise<{ url: string; store: MemoryWorldStore }> {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 60_000,
    heartbeatIntervalMs: 60_000,
    apiKeyHash: await argon2.hash(API_KEY),
  });
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  defer(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
}

test("two-gateway trade over a real HTTP world server commits via tradeCommit; the second gateway seeds the settled outcome", async (t) => {
  const defer = cleanups(t);
  const { url: worldUrl, store: worldStore } = await worldHttpServer(defer);
  const mkClient = (regionId: string, range: typeof RANGE_A) =>
    new WorldClient({
      transport: new WebrpcWorldTransport(worldUrl),
      regionId,
      chunkRange: range,
      endpoint: "ws://pending", // replaced with the gateway's URL below
      capacity: 100,
      apiKey: API_KEY,
      heartbeatIntervalMs: 60_000,
      onError: () => {},
    });
  const clientA = mkClient("region-a", RANGE_A);
  const clientB = mkClient("region-b", RANGE_B);
  const a = makeRig(clientA);
  const b = makeRig(clientB);
  const gwA = await makeGatewayRig(t, a, defer);
  const gwB = await makeGatewayRig(t, b, defer);
  // Registration validates the endpoint (a real URL, as in P4's rigs):
  // point each client at its own gateway, then register.
  (clientA as unknown as { opts: { endpoint: string } }).opts.endpoint = gwA.url;
  (clientB as unknown as { opts: { endpoint: string } }).opts.endpoint = gwB.url;
  await clientA.start();
  await clientB.start();
  defer(() => clientB.stop());
  defer(() => clientA.stop());
  assert.equal(clientA.registered, true);
  assert.equal(clientB.registered, true);

  // Region B's local roster: a throwaway (id 1) so Bran is id 2 there
  // too — the same world character A knows as 2.
  await b.store.create("alice", "Throwaway", JSON.stringify(LOOK), 10);
  await b.store.create("user-b", "Bran", JSON.stringify(LOOK), 10);

  // Both traders play on region A (a trade is proximity-local; the
  // commit is what goes to the world).
  const arya = await createAndEnter(gwA.url, "alice", "Arya");
  defer(() => arya.c.close());
  const bran = await createAndEnter(gwA.url, "user-b", "Bran");
  defer(() => bran.c.close());
  assert.equal(arya.id, 1);
  assert.equal(bran.id, 2);

  // Establish the economy locally, then upload it: the world records
  // are the trade's starting truth.
  a.wallet.grant(1, 100, 1);
  a.wallet.grant(2, 100, 1);
  const sword = a.items.store.create(0, a.defs.durability[0]);
  a.items.store.putInBag(1, sword);
  gwA.gw.saveCharacters(); // persists session state + fires the uphill saves
  await until(async () => (await worldEconomy(worldStore, 1))?.gold === 100, "Arya's seed save to land");
  await until(async () => (await worldEconomy(worldStore, 2))?.gold === 100, "Bran's seed save to land");

  // The wire trade: Arya offers the sword, Bran offers 40 gold.
  const openP = arya.c.waitFor(MessageType.Trade, 1);
  arya.c.sendRaw(MessageType.Trade, encodeControl({
    kind: "trade", action: "open", target: bran.c.welcome!.player_entity.toString(),
  }));
  await gwA.pump();
  const tradeId = decodeControl<TradeMessage>((await openP)[0]).id;
  arya.c.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "offer", id: tradeId, addItem: sword }));
  bran.c.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "offer", id: tradeId, gold: 40 }));
  await gwA.pump();
  arya.c.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
  await gwA.pump();
  bran.c.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));

  // The completing accept routes the settlement through tradeCommit.
  await until(async () => (await worldEconomy(worldStore, 1))?.gold === 140, "the world trade to settle");
  const w1 = await worldEconomy(worldStore, 1);
  const w2 = await worldEconomy(worldStore, 2);
  assert.equal(w1?.gold, 140);
  assert.equal(w1?.inventory.length, 0);
  assert.equal(w2?.gold, 60);
  assert.deepEqual(w2?.inventory.map((i) => i.instanceId), [itemInstanceId(sword)]);
  assert.equal(w1?.version, 2, "one save + one atomic commit");
  assert.equal(w2?.version, 2);
  // Region A's live caches reconciled to the settled outcome.
  assert.equal(a.wallet.balanceOf(1), 140);
  assert.equal(a.wallet.balanceOf(2), 60);
  assert.equal(a.items.store.inBagOf(1, sword), false);
  assert.equal(a.items.store.inBagOf(2, sword), true);
  const ledger = await worldStore.getAtomicLedger();
  assert.ok(ledger.some((e) => e.op === "tradeCommit"), "the trade is in the world item ledger");

  // Bran leaves A (logout commits + releases) and enters on region B:
  // B's login seeds its caches from the world record — the settled
  // outcome is what B starts from.
  await bran.c.close();
  await sleep(50);
  gwA.elapse(2000);
  await until(async () => (await worldStore.getCharacterLock(2)) === null, "A's logout to release Bran");
  const entered = await enterExisting(gwB.url, "user-b", 2);
  defer(() => entered.c.close());
  assert.equal((await worldStore.getCharacterLock(2))?.regionId, "region-b");
  assert.equal(b.wallet.balanceOf(2), 60, "B's wallet seeded from the settled world record");
  assert.equal(b.items.store.inBagOf(2, sword), true, "B's bag seeded with the traded sword");
});

test("gateway vendor: buy and sell commit via vendorTransact; a world rejection surfaces as 4005", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  const g = await makeGatewayRig(t, a, defer);

  const arya = await createAndEnter(g.url, "alice", "Arya");
  defer(() => arya.c.close());
  a.wallet.grant(1, 500, 1);
  g.gw.saveCharacters();
  await until(async () => (await worldEconomy(worldStore, 1))?.gold === 500, "the seed save to land");

  // A vendor NPC stands where the player stands.
  const avatar = g.gw.world.resolveWireId(BigInt(arya.c.welcome!.player_entity));
  const vEid = g.gw.world.spawn();
  addComponent(g.gw.world.ecs, C.Transform, vEid);
  C.Transform.px[vEid] = C.Transform.px[avatar];
  C.Transform.pz[vEid] = C.Transform.pz[avatar];
  assert.equal(a.vendor.attach(vEid, "general"), true);
  const wire = g.gw.world.wireId(vEid).toString();

  // Buy: 500 - 100 = 400 everywhere.
  const boughtP = arya.c.waitFor(MessageType.Trade, 1);
  arya.c.sendRaw(MessageType.Trade, encodeControl({ kind: "vendor", action: "buy", vendor: wire, def: 0 }));
  await g.pump();
  const bought = decodeControl<VendorMessage>((await boughtP)[0]);
  assert.equal(bought.state, "bought");
  assert.equal(a.wallet.balanceOf(1), 400);
  const bagAfterBuy = [...a.items.store.bag(1)].filter((id) => id !== 0);
  assert.equal(bagAfterBuy.length, 1);
  const boughtItem = bagAfterBuy[0];
  let world = await worldEconomy(worldStore, 1);
  assert.equal(world?.gold, 400);
  assert.deepEqual(world?.inventory.map((i) => i.instanceId), [itemInstanceId(boughtItem)]);

  // Sell it back at the 50% buyback: 400 + 50 = 450 everywhere.
  const soldP = arya.c.waitFor(MessageType.Trade, 1);
  arya.c.sendRaw(MessageType.Trade, encodeControl({ kind: "vendor", action: "sell", vendor: wire, item: boughtItem }));
  await g.pump();
  const sold = decodeControl<VendorMessage>((await soldP)[0]);
  assert.equal(sold.state, "sold");
  assert.equal(a.wallet.balanceOf(1), 450);
  assert.equal(a.items.store.exists(boughtItem), false, "the sold item left existence via the settled outcome");
  world = await worldEconomy(worldStore, 1);
  assert.equal(world?.gold, 450);
  assert.equal(world?.inventory.length, 0);

  // Typed rejection over the wire: gold the world never saw cannot
  // be spent — INSUFFICIENT_FUNDS surfaces as the existing 4005
  // "not enough gold" refusal, and nothing moves.
  a.wallet.grant(1, 10_000, 2);
  const sizeBefore = a.items.store.size;
  const errP = arya.c.waitFor(MessageType.Error, 1);
  arya.c.sendRaw(MessageType.Trade, encodeControl({ kind: "vendor", action: "buy", vendor: wire, def: 1 }));
  await g.pump();
  const err = decodeControl<ErrorMessage>((await errP)[0]);
  assert.equal(err.code, 4005);
  assert.match(err.message, /not enough gold/);
  assert.equal(a.wallet.balanceOf(1), 10_450, "the rejection moved no local gold");
  assert.equal(a.items.store.size, sizeBefore, "the rejected buy's allocation was destroyed");
  assert.equal((await worldEconomy(worldStore, 1))?.gold, 450);
});

test("gateway auction: a buyout commits via auctionSettle at the full price", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  const g = await makeGatewayRig(t, a, defer);

  const seller = await createAndEnter(g.url, "alice", "Arya");
  defer(() => seller.c.close());
  const buyer = await createAndEnter(g.url, "user-b", "Bran");
  defer(() => buyer.c.close());
  const sword = a.items.store.create(0, a.defs.durability[0]);
  a.items.store.putInBag(1, sword);
  a.wallet.grant(2, 1000, 1);
  g.gw.saveCharacters();
  await until(async () => (await worldEconomy(worldStore, 2))?.gold === 1000, "the buyer's seed save to land");
  await until(
    async () => (await worldEconomy(worldStore, 1))?.inventory.length === 1,
    "the seller's seed save to land",
  );

  const listedP = seller.c.waitFor(MessageType.Trade, 1);
  seller.c.sendRaw(MessageType.Trade, encodeControl({
    kind: "auction", action: "list", item: sword, startBid: 100, buyout: 300,
  }));
  await g.pump();
  const listed = decodeControl<AuctionMessage>((await listedP)[0]);
  assert.equal(listed.state, "listed");
  const listingId = listed.listing!.id;

  const soldP = buyer.c.waitFor(MessageType.Trade, 1);
  buyer.c.sendRaw(MessageType.Trade, encodeControl({ kind: "auction", action: "buyout", listing: listingId }));
  await g.pump();
  const sold = decodeControl<AuctionMessage>((await soldP)[0]);
  assert.equal(sold.state, "sold");

  // The world tier conserves gold exactly: the seller receives the
  // full 300 (no local 5% house cut on a world-settled sale).
  assert.equal(a.wallet.balanceOf(1), 300);
  assert.equal(a.wallet.balanceOf(2), 700);
  assert.equal(a.items.store.inBagOf(2, sword), true);
  assert.equal(a.items.store.inBagOf(1, sword), false);
  assert.equal(a.auction.browse().length, 0);
  const w1 = await worldEconomy(worldStore, 1);
  const w2 = await worldEconomy(worldStore, 2);
  assert.equal(w1?.gold, 300);
  assert.equal(w2?.gold, 700);
  assert.deepEqual(w2?.inventory.map((i) => i.instanceId), [itemInstanceId(sword)]);
});

test("gateway trade: an outage at the completing accept fails closed — refused, cancelled, nothing moved", async (t) => {
  const defer = cleanups(t);
  const { store: worldStore, transport } = await makeWorld();
  const clientA = makeClient(transport, "region-a", RANGE_A);
  await clientA.start();
  defer(() => clientA.stop());
  const a = makeRig(clientA);
  const g = await makeGatewayRig(t, a, defer);

  const arya = await createAndEnter(g.url, "alice", "Arya");
  defer(() => arya.c.close());
  const bran = await createAndEnter(g.url, "user-b", "Bran");
  defer(() => bran.c.close());
  a.wallet.grant(1, 100, 1);
  a.wallet.grant(2, 100, 1);
  g.gw.saveCharacters();
  await until(async () => (await worldEconomy(worldStore, 1))?.gold === 100, "Arya's seed save to land");
  await until(async () => (await worldEconomy(worldStore, 2))?.gold === 100, "Bran's seed save to land");

  const openP = arya.c.waitFor(MessageType.Trade, 1);
  arya.c.sendRaw(MessageType.Trade, encodeControl({
    kind: "trade", action: "open", target: bran.c.welcome!.player_entity.toString(),
  }));
  await g.pump();
  const tradeId = decodeControl<TradeMessage>((await openP)[0]).id;
  arya.c.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "offer", id: tradeId, gold: 30 }));
  await g.pump();
  arya.c.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
  await g.pump();

  // The world goes away before the completing accept.
  transport.failAtomic = true;
  const errP = bran.c.waitFor(MessageType.Error, 1);
  bran.c.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
  await g.pump();
  const err = decodeControl<ErrorMessage>((await errP)[0]);
  assert.equal(err.code, 4005);
  assert.match(err.message, /world tier is unreachable/);
  transport.failAtomic = false;

  assert.equal(a.trade.pending(tradeId), null, "the trade was cancelled, not settled");
  assert.equal(a.wallet.balanceOf(1), 100, "no local fallback commit");
  assert.equal(a.wallet.balanceOf(2), 100);
  assert.equal((await worldEconomy(worldStore, 1))?.gold, 100);
  assert.equal((await worldEconomy(worldStore, 1))?.version, 1, "the world record never moved");
  assert.equal((await worldEconomy(worldStore, 2))?.version, 1);
});

test("standalone gateway: the full trade flow settles locally and the world is never called", async (t) => {
  const defer = cleanups(t);
  let worldCalls = 0;
  const counting: CharacterWorldClient = {
    async acquireCharacterLock(): Promise<CharacterSessionLock> {
      worldCalls++;
      throw new Error("standalone must not call the world");
    },
    async getCharacterState(): Promise<null> {
      worldCalls++;
      return null;
    },
    async putCharacterState(): Promise<CharacterStateRecord> {
      worldCalls++;
      throw new Error("standalone must not call the world");
    },
    async releaseCharacterLock(): Promise<void> {
      worldCalls++;
    },
  };
  // Built but never handed to the gateway — exactly a standalone boot.
  void new WorldCharacterSync({ client: counting, store: new MemoryCharacterStore() });

  let now = 1_000_000;
  const wallet = new WalletSystem();
  const owned = new Map<number, number[]>([[-1, [101]]]);
  const trade = new TradeSystem(wallet, {
    owns: (c, item) => owned.get(c)?.includes(item) ?? false,
    freeSlots: () => 20,
    move: (item, from, to) => {
      const arr = owned.get(from);
      const i = arr?.indexOf(item) ?? -1;
      if (!arr || i < 0) return false;
      arr.splice(i, 1);
      owned.set(to, [...(owned.get(to) ?? []), item]);
      return true;
    },
  });
  const gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [wallet, trade],
  });
  defer(() => gw.close());
  const port = await gw.listen();
  gw.frame(now);
  const url = `ws://127.0.0.1:${port}`;
  const frames = async (n: number): Promise<void> => {
    await sleep(120);
    for (let i = 0; i < n; i++) {
      now += 34;
      gw.frame(now);
    }
    await sleep(120);
  };
  const join = async (username: string): Promise<{ client: HeadlessClient; entity: bigint }> => {
    const client = new HeadlessClient();
    await client.connect(url);
    const snapP = client.waitFor(MessageType.Snapshot, 1);
    const welcome = await client.hello(username, creds(username));
    await snapP;
    return { client, entity: BigInt(welcome.player_entity) };
  };

  const alice = await join("alice");
  defer(() => alice.client.close());
  const bob = await join("user-b");
  defer(() => bob.client.close());
  wallet.grant(-1, 100, gw.world.currentTick);
  wallet.grant(-2, 100, gw.world.currentTick);
  await frames(1);

  const openP = alice.client.waitFor(MessageType.Trade, 1);
  alice.client.sendRaw(MessageType.Trade, encodeControl({
    kind: "trade", action: "open", target: bob.entity.toString(),
  }));
  await frames(3);
  const tradeId = decodeControl<TradeMessage>((await openP)[0]).id;
  alice.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "offer", id: tradeId, gold: 30 }));
  await frames(3);
  const settledP = alice.client.waitFor(MessageType.Trade, 3);
  alice.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
  bob.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
  await frames(3);
  const msgs = (await settledP).map((p) => decodeControl<TradeMessage | WalletMessage>(p));
  assert.ok(msgs.some((m) => m.kind === "trade" && m.state === "settled"), "the trade settled locally");
  assert.equal(wallet.balanceOf(-1), 70);
  assert.equal(wallet.balanceOf(-2), 130);
  assert.equal(worldCalls, 0, "no world calls at all in standalone mode");
});
