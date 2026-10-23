/**
 * Persistence P3: boot recall + takeover.
 *
 * - WorldClient recall reads (GetShardSnapshot / GetLedgerEvents /
 *   GetLedgerHead) against a stub transport.
 * - recallShardState against a fake recall client + the REAL local
 *   stores (in-memory SnapshotStore + ItemLedger): world-newer hot-load
 *   (snapshot seeded, ledger imported, existing restore paths do the
 *   rest), local-newer divergence safety, ledger tail semantics
 *   (post-snapshot events win, tombstones included; pre-snapshot items
 *   restored exactly once), fresh range, unregistered and world-down
 *   fallbacks.
 * - Takeover end-to-end: a fake transport backed by the REAL world
 *   core (WorldCoreImpl + MemoryWorldStore). Region A registers,
 *   writes state through the P2 shipper; its lease expires and is
 *   reaped; replacement B registers the same range (higher epoch),
 *   recalls A's state through the same boot path, continues writing;
 *   A's stale-epoch writes are rejected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { addComponent } from "bitecs";
import Database from "better-sqlite3";
import * as argon2 from "argon2";
import {
  MemoryWorldStore,
  WorldCoreImpl,
  WorldError,
  rangeKeyFor,
  type ShardSnapshotRecord,
  type StoredLedgerEvent,
} from "@mmo-engine/world-server";
import { engineDefaults } from "@mmo-engine/rules";
import {
  SimWorld,
  SnapshotStore,
  Transform,
  Health,
  collectFullState,
  compareStates,
  stateFromCollected,
} from "../src/index.js";
import {
  WorldClient,
  WorldTransportError,
  type WorldTransport,
} from "../src/world/client.js";
import { ShardStateShipper } from "../src/world/state-shipper.js";
import {
  recallShardState,
  unwrapShardSnapshotPayload,
  type StateRecallClient,
} from "../src/world/state-recall.js";
import { ItemLedger, LedgerKind } from "../src/persist/item-ledger.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../src/items/index.js";

const RANGE = { x0: 0, x1: 100, z0: 0, z1: 100 };
const RANGE_KEY = rangeKeyFor(RANGE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSim(count: number, xBase: number): SimWorld {
  const sim = new SimWorld();
  for (let i = 0; i < count; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Health, e);
    Transform.px[e] = xBase + i * 3;
    Transform.py[e] = 1;
    Transform.pz[e] = xBase - i;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Health.current[e] = 50 + i;
    Health.max[e] = 100;
  }
  return sim;
}

function snapshotPayload(bytes: Uint8Array): Record<string, unknown> {
  return {
    format: "flatbuffers-base64",
    contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
    data: Buffer.from(bytes).toString("base64"),
  };
}

function snapRecord(
  bytes: Uint8Array,
  tick: number,
  epoch: number,
): ShardSnapshotRecord {
  return {
    rangeKey: RANGE_KEY,
    regionId: "r-old",
    tick,
    epoch,
    digest: "digest",
    payload: snapshotPayload(bytes),
    storedAt: 1234,
  };
}

function storedEvent(
  seq: number,
  tick: number,
  fields: {
    itemId: number;
    kind: number;
    def?: number;
    owner?: number;
    slot?: number;
    durability?: number;
    x?: number;
    z?: number;
  },
): StoredLedgerEvent {
  return {
    seq,
    tick,
    rangeKey: RANGE_KEY,
    payload: {
      itemId: fields.itemId,
      kind: fields.kind,
      def: fields.def ?? 0,
      owner: fields.owner ?? 0,
      slot: fields.slot ?? 0,
      durability: fields.durability ?? 10,
      x: fields.x ?? 0,
      z: fields.z ?? 0,
      committedAt: 5000 + seq,
    },
  };
}

const POOL: PoolItemLike[] = [
  {
    id: "a",
    rank: "common",
    source: "mob",
    item: "ring",
    seed: 0,
    bundle: {
      Identity: { id: "a", name: "a", base: "ring" },
      Rank: { id: "common", color: "#fff" },
      Stats: {},
    },
  },
];

function makeItemService(): ItemService {
  const defs = new ItemDefs(POOL, engineDefaults());
  return new ItemService({
    defs,
    loot: {
      ownershipSeconds: 30,
      despawnSeconds: 300,
      pickupRange: 2.5,
      bagSlots: 4,
      maxGroundItems: 100,
    },
    tickHz: 30,
    groundHeightAt: () => 0,
  });
}

function memStore(): SnapshotStore {
  return new SnapshotStore({ dbPath: ":memory:" });
}

function memLedger(): ItemLedger {
  return new ItemLedger(new Database(":memory:"));
}

// ---------------------------------------------------------------------------
// WorldClient recall reads against a stub transport
// ---------------------------------------------------------------------------

class StubTransport implements WorldTransport {
  calls: { method: string; args: Record<string, unknown>; token?: string }[] =
    [];
  handlers = new Map<
    string,
    (args: Record<string, unknown>) => Record<string, unknown>
  >();

  async call(method: string, args: Record<string, unknown>, token?: string) {
    this.calls.push({ method, args, token });
    const h = this.handlers.get(method);
    if (!h) throw new WorldTransportError(501, `${method} not stubbed`);
    return h(args);
  }
}

const TOKEN = "d".repeat(64);

async function registeredStubClient(t: StubTransport): Promise<WorldClient> {
  t.handlers.set("RegisterRegion", () => ({
    lease: {
      regionId: "r1",
      heartbeatIntervalMs: 60_000,
      registryVersion: 1,
      token: TOKEN,
      epoch: 4,
    },
  }));
  const c = new WorldClient({
    transport: t,
    regionId: "r1",
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000,
    onError: () => {},
  });
  await c.start();
  assert.equal(c.registered, true);
  return c;
}

test("client recall reads send rangeKey + token and return snapshot/events/head", async () => {
  const t = new StubTransport();
  const c = await registeredStubClient(t);
  const snap = snapRecord(new Uint8Array([1, 2]), 300, 3);
  t.handlers.set("GetShardSnapshot", () => ({ snapshot: snap }));
  t.handlers.set("GetLedgerEvents", () => ({
    events: [storedEvent(7, 350, { itemId: 2, kind: LedgerKind.Ground })],
  }));
  t.handlers.set("GetLedgerHead", () => ({ ackedSeq: 7 }));

  assert.deepEqual(await c.getShardSnapshot(), snap);
  const events = await c.getLedgerEvents(3);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 7);
  assert.equal(await c.getLedgerHead(), 7);

  const snapCall = t.calls.find((x) => x.method === "GetShardSnapshot")!;
  assert.equal(snapCall.token, TOKEN);
  assert.deepEqual(snapCall.args["input"], { regionId: "r1", rangeKey: RANGE_KEY });
  const evCall = t.calls.find((x) => x.method === "GetLedgerEvents")!;
  assert.equal(evCall.token, TOKEN);
  assert.deepEqual(evCall.args["input"], {
    regionId: "r1",
    rangeKey: RANGE_KEY,
    afterSeq: 3,
  });
  await c.stop();
});

test("client recall reads throw while unregistered (recall decides the fallback)", async () => {
  const t = new StubTransport();
  t.handlers.set("RegisterRegion", () => {
    throw new WorldTransportError(0, "connection refused");
  });
  const c = new WorldClient({
    transport: t,
    regionId: "r1",
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000,
    onError: () => {},
  });
  await c.start();
  assert.equal(c.registered, false);
  await assert.rejects(() => c.getShardSnapshot(), /not registered/);
  await assert.rejects(() => c.getLedgerEvents(0), /not registered/);
  await c.stop();
});

test("unwrapShardSnapshotPayload accepts exactly the P2 encoding", () => {
  const bytes = new Uint8Array([9, 8, 7]);
  assert.deepEqual(unwrapShardSnapshotPayload(snapshotPayload(bytes)), bytes);
  assert.equal(unwrapShardSnapshotPayload(null), null);
  assert.equal(unwrapShardSnapshotPayload({ format: "raw", data: "AA==" }), null);
  const badHash = snapshotPayload(bytes);
  badHash["contentHash"] = "0".repeat(64);
  assert.equal(unwrapShardSnapshotPayload(badHash), null, "hash mismatch is corrupt, not a snapshot");
});

// ---------------------------------------------------------------------------
// recallShardState against a fake recall client + real local stores
// ---------------------------------------------------------------------------

class FakeRecallClient implements StateRecallClient {
  readonly rangeKey = RANGE_KEY;
  epoch: number | null = 5;
  registered = true;
  snapshot: ShardSnapshotRecord | null = null;
  events: StoredLedgerEvent[] = [];
  calls: string[] = [];
  failSnapshot = false;
  failEvents = false;

  async getShardSnapshot(): Promise<ShardSnapshotRecord | null> {
    this.calls.push("snapshot");
    if (this.failSnapshot) throw new Error("world unreachable");
    return this.snapshot;
  }

  async getLedgerEvents(afterSeq: number): Promise<StoredLedgerEvent[]> {
    this.calls.push(`events:${afterSeq}`);
    if (this.failEvents) throw new Error("world unreachable");
    return this.events.filter((e) => e.seq > afterSeq);
  }
}

test("world-newer: boot hot-loads the world snapshot + ledger tail via the local stores", async () => {
  // Source world state at tick 300 (the bytes P2 would have uploaded).
  const sourceStore = memStore();
  const simA = buildSim(4, 10);
  const saved = sourceStore.saveWorld(300, simA);
  const stateA = stateFromCollected(collectFullState(simA, 300));
  sourceStore.close();

  // Local cache: an older snapshot (tick 100) and the first ledger
  // event already present (same lineage — import must not duplicate).
  const store = memStore();
  store.saveWorld(100, buildSim(2, 90));
  const ledger = memLedger();
  ledger.tick = 120;
  ledger.record(LedgerKind.Bag, 1, 0, 42, 0, 10);
  assert.equal(ledger.flush(), 1);

  const client = new FakeRecallClient();
  client.snapshot = snapRecord(saved.snapshotBytes, 300, 3);
  client.events = [
    storedEvent(1, 120, { itemId: 1, kind: LedgerKind.Bag, owner: 42, slot: 0 }),
    // The tail: events newer than the snapshot.
    storedEvent(2, 350, { itemId: 2, kind: LedgerKind.Ground, x: 5, z: 7, durability: 8 }),
    storedEvent(3, 360, { itemId: 3, kind: LedgerKind.Bag, owner: 42, slot: 1 }),
  ];
  const logs: string[] = [];
  const outcome = await recallShardState({
    client,
    store,
    ledger,
    log: (l) => logs.push(l),
  });

  assert.equal(outcome.source, "world");
  assert.equal(outcome.tick, 300);
  assert.equal(outcome.worldTick, 300);
  assert.equal(outcome.worldEpoch, 3);
  assert.equal(outcome.localTick, 100);
  assert.equal(outcome.diverged, true, "the superseded local copy is surfaced, not silent");
  assert.ok(logs.some((l) => l.includes("DIVERGENCE") && l.includes("superseded")));
  assert.equal(outcome.ledgerEventsSeen, 3);
  assert.equal(outcome.ledgerEventsImported, 2, "seq 1 was already local: idempotent import");
  assert.deepEqual(client.calls, ["snapshot", "events:0"], "snapshot first, ledger second");

  // The seeded local store restores through the existing path.
  const latest = store.loadLatest();
  assert.equal(latest?.tick, 300);
  assert.deepEqual(latest?.bytes, saved.snapshotBytes);
  SimWorld.resetEntityCursorForTesting();
  const restored = new SimWorld();
  assert.equal(store.restoreInto(restored), 300);
  const cmp = compareStates(
    stateA,
    stateFromCollected(collectFullState(restored, 300)),
  );
  assert.ok(cmp.equal, `restored state differs: ${cmp.diffs.join("; ")}`);

  // Ledger replay is the existing item-restore path over load().
  assert.equal(ledger.count(), 3);
  const rows = ledger.load();
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  SimWorld.resetEntityCursorForTesting();
  const itemSim = new SimWorld();
  const items = makeItemService();
  assert.equal(items.restore(itemSim, rows), 3);
  assert.equal(items.store.size, 3, "no item double-applied");
  assert.deepEqual([...items.store.bag(42)], [1, 3, 0, 0]);
  const ground = rows.find((r) => r.id === 2)!;
  assert.equal(ground.kind, LedgerKind.Ground);
  assert.equal(ground.x, 5);
  assert.equal(ground.z, 7);
  assert.ok(items.groundEntity(2) >= 0, "tail ground item placed");
  store.close();
  ledger.close();
});

test("local-newer divergence: local state kept, world copy not applied", async () => {
  const store = memStore();
  const localSaved = store.saveWorld(600, buildSim(3, 30));
  const ledger = memLedger();
  ledger.tick = 550;
  ledger.record(LedgerKind.Bag, 9, 0, 7, 0, 10);
  ledger.flush();

  const otherStore = memStore();
  const worldBytes = otherStore.saveWorld(300, buildSim(4, 60)).snapshotBytes;
  otherStore.close();

  const client = new FakeRecallClient();
  client.snapshot = snapRecord(worldBytes, 300, 3);
  client.events = [
    storedEvent(1, 120, { itemId: 1, kind: LedgerKind.Bag, owner: 42, slot: 0 }),
  ];
  const logs: string[] = [];
  const outcome = await recallShardState({
    client,
    store,
    ledger,
    log: (l) => logs.push(l),
  });

  assert.equal(outcome.source, "local");
  assert.equal(outcome.tick, 600);
  assert.equal(outcome.diverged, true);
  assert.ok(logs.some((l) => l.includes("DIVERGENCE") && l.includes("NOT applied")));
  assert.equal(outcome.ledgerEventsImported, 0);
  assert.equal(store.loadLatest()?.tick, 600);
  assert.deepEqual(store.loadLatest()?.bytes, localSaved.snapshotBytes);
  assert.deepEqual(ledger.load().map((r) => r.id), [9], "local ledger untouched");
  store.close();
  ledger.close();
});

test("ledger tail after the snapshot decides item state (tombstone wins, tail items live)", async () => {
  const sourceStore = memStore();
  const saved = sourceStore.saveWorld(300, buildSim(1, 0));
  sourceStore.close();

  const store = memStore();
  const ledger = memLedger();
  const client = new FakeRecallClient();
  client.snapshot = snapRecord(saved.snapshotBytes, 300, 1);
  client.events = [
    storedEvent(1, 100, { itemId: 1, kind: LedgerKind.Create }),
    storedEvent(2, 110, { itemId: 1, kind: LedgerKind.Ground, x: 1, z: 2 }),
    // Tail (tick > snapshot tick): item 1 is destroyed, item 2 appears.
    storedEvent(3, 400, { itemId: 1, kind: LedgerKind.Destroy }),
    storedEvent(4, 410, { itemId: 2, kind: LedgerKind.Bag, owner: 7, slot: 0 }),
  ];
  const outcome = await recallShardState({ client, store, ledger });
  assert.equal(outcome.source, "world");
  assert.equal(outcome.ledgerEventsImported, 4);
  const rows = ledger.load();
  assert.deepEqual(rows.map((r) => r.id), [2], "destroyed pre-snapshot item stays dead");
  SimWorld.resetEntityCursorForTesting();
  const items = makeItemService();
  assert.equal(items.restore(new SimWorld(), rows), 1);
  assert.deepEqual([...items.store.bag(7)], [2, 0, 0, 0]);
  store.close();
  ledger.close();
});

test("fresh range: world holds nothing, boot is today's (local or empty)", async () => {
  // Nothing anywhere.
  {
    const store = memStore();
    const ledger = memLedger();
    const client = new FakeRecallClient();
    const logs: string[] = [];
    const outcome = await recallShardState({
      client,
      store,
      ledger,
      log: (l) => logs.push(l),
    });
    assert.equal(outcome.source, "fresh");
    assert.equal(outcome.tick, null);
    assert.equal(store.loadLatest(), null);
    assert.equal(ledger.count(), 0);
    assert.ok(logs.some((l) => l.includes("fresh range")));
    store.close();
    ledger.close();
  }
  // Local state exists, world empty: local boot, unchanged bytes.
  {
    const store = memStore();
    const saved = store.saveWorld(200, buildSim(2, 5));
    const ledger = memLedger();
    const client = new FakeRecallClient();
    const outcome = await recallShardState({ client, store, ledger });
    assert.equal(outcome.source, "local");
    assert.equal(outcome.tick, 200);
    assert.equal(outcome.diverged, false);
    assert.deepEqual(store.loadLatest()?.bytes, saved.snapshotBytes);
    store.close();
    ledger.close();
  }
});

test("unregistered client and world fetch failure both fall back to local, fetching nothing extra", async () => {
  const store = memStore();
  store.saveWorld(200, buildSim(2, 5));
  const ledger = memLedger();

  const unregistered = new FakeRecallClient();
  unregistered.registered = false;
  unregistered.epoch = null;
  unregistered.snapshot = snapRecord(new Uint8Array([1]), 300, 3);
  const out1 = await recallShardState({ client: unregistered, store, ledger });
  assert.equal(out1.source, "local");
  assert.equal(out1.tick, 200);
  assert.deepEqual(unregistered.calls, [], "no recall reads without a lease");

  const failing = new FakeRecallClient();
  failing.failSnapshot = true;
  const logs: string[] = [];
  const out2 = await recallShardState({
    client: failing,
    store,
    ledger,
    log: (l) => logs.push(l),
  });
  assert.equal(out2.source, "local");
  assert.equal(out2.tick, 200);
  assert.ok(logs.some((l) => l.includes("fetch failed")));
  assert.equal(store.loadLatest()?.tick, 200);
  store.close();
  ledger.close();
});

test("ledger-only world state (no snapshot yet) still recalls its items", async () => {
  const store = memStore();
  const ledger = memLedger();
  const client = new FakeRecallClient();
  client.events = [
    storedEvent(1, 50, { itemId: 4, kind: LedgerKind.Bag, owner: 3, slot: 2 }),
  ];
  const outcome = await recallShardState({ client, store, ledger });
  assert.equal(outcome.source, "world");
  assert.equal(outcome.tick, null, "no snapshot anywhere: sim still boots fresh");
  assert.equal(store.loadLatest(), null);
  assert.deepEqual(ledger.load().map((r) => r.id), [4]);
  store.close();
  ledger.close();
});

// ---------------------------------------------------------------------------
// Takeover: fake transport backed by the real world core + fake store
// ---------------------------------------------------------------------------

class CoreTransport implements WorldTransport {
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
          if (caller !== input["regionId"])
            throw new WorldTransportError(403, "regionId does not match token");
          return { ack: await this.core.heartbeat(input as never) };
        }
        case "ReportSnapshot":
          await this.core.reportSnapshot(input as never);
          return {};
        case "AppendLedgerEvents":
          return await this.core.appendLedgerEvents(
            await this.caller(token),
            input as never,
          );
        case "PutShardSnapshot":
          return {
            snapshot: await this.core.putShardSnapshot(
              await this.caller(token),
              input as never,
            ),
          };
        case "GetShardSnapshot":
          return {
            snapshot: await this.core.getShardSnapshot(
              await this.caller(token),
              String(input["rangeKey"]),
            ),
          };
        case "GetLedgerEvents":
          return await this.core.getLedgerEvents(
            await this.caller(token),
            input as never,
          );
        case "GetLedgerHead":
          return await this.core.getLedgerHead(
            await this.caller(token),
            input as never,
          );
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

const API_KEY = "recall-test-bootstrap-key";
let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

function makeClient(
  transport: WorldTransport,
  regionId: string,
  errors: unknown[],
): WorldClient {
  return new WorldClient({
    transport,
    regionId,
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: API_KEY,
    heartbeatIntervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
}

test("takeover: replacement registers the same range, recalls the dead shard's state, continues; stale epoch fenced", async () => {
  const worldStore = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store: worldStore,
    heartbeatTimeoutMs: 1000,
    heartbeatIntervalMs: 60_000,
    apiKeyHash: await apiKeyHash(),
  });
  const transport = new CoreTransport(core);
  const errorsA: unknown[] = [];
  const errorsB: unknown[] = [];

  // --- Shard A: registers (epoch 1), simulates, ships state uphill.
  const clientA = makeClient(transport, "region-a", errorsA);
  await clientA.start();
  assert.equal(clientA.registered, true);
  assert.equal(clientA.epoch, 1);

  const storeA = memStore();
  const simA = buildSim(4, 10);
  const savedA = storeA.saveWorld(300, simA);
  const stateA = stateFromCollected(collectFullState(simA, 300));
  const ledgerA = memLedger();
  ledgerA.tick = 120;
  ledgerA.record(LedgerKind.Bag, 1, 0, 42, 0, 10);
  ledgerA.flush();
  ledgerA.tick = 350;
  ledgerA.record(LedgerKind.Ground, 2, 0, 0, 0, 8, 5, 7);
  ledgerA.flush();

  const shipperA = new ShardStateShipper({
    client: clientA,
    ledger: ledgerA,
    snapshotIntervalTicks: 300,
  });
  shipperA.offerSnapshot(300, "digest-a", savedA.snapshotBytes);
  await shipperA.pump(300 + shipperA.snapshotPhaseOffsetTicks);
  assert.equal(shipperA.worldAckedSeq, 2);
  const worldSnap = await worldStore.getLatestShardSnapshot(RANGE_KEY);
  assert.equal(worldSnap?.tick, 300);
  assert.equal(worldSnap?.epoch, 1);
  assert.equal(await worldStore.getLedgerHead(RANGE_KEY), 2);

  // --- A dies: its lease expires and the world reaps it.
  const recA = (await worldStore.getRegion("region-a"))!;
  recA.lastHeartbeat = Date.now() - 60_000;
  await worldStore.upsertRegion(recA);
  const reaped = await core.reapStale();
  assert.deepEqual(reaped, ["region-a"]);

  // --- Replacement B: same range, bumped epoch, recall before sim.
  const clientB = makeClient(transport, "region-b", errorsB);
  await clientB.start();
  assert.equal(clientB.registered, true);
  assert.equal(clientB.epoch, 2, "takeover grant bumps the fencing epoch");

  const storeB = memStore();
  const ledgerB = memLedger();
  const outcome = await recallShardState({
    client: clientB,
    store: storeB,
    ledger: ledgerB,
  });
  assert.equal(outcome.source, "world");
  assert.equal(outcome.tick, 300);
  assert.equal(outcome.worldEpoch, 1);
  assert.equal(outcome.ledgerEventsImported, 2);

  SimWorld.resetEntityCursorForTesting();
  const simB = new SimWorld();
  assert.equal(storeB.restoreInto(simB), 300);
  const cmp = compareStates(
    stateA,
    stateFromCollected(collectFullState(simB, 300)),
  );
  assert.ok(cmp.equal, `takeover state differs: ${cmp.diffs.join("; ")}`);

  SimWorld.resetEntityCursorForTesting();
  const itemsB = makeItemService();
  assert.equal(itemsB.restore(new SimWorld(), ledgerB.load()), 2);
  assert.deepEqual([...itemsB.store.bag(42)], [1, 0, 0, 0]);
  assert.ok(itemsB.groundEntity(2) >= 0);

  // --- B continues: new ledger events keep the world seq, shipped
  // under B's post-boot epoch.
  ledgerB.tick = 400;
  ledgerB.record(LedgerKind.Bag, 3, 0, 42, 1, 10);
  ledgerB.flush();
  assert.deepEqual(
    ledgerB.eventsAfter(2, 10).map((r) => r.seq),
    [3],
    "local seq continues after the imported world stream",
  );
  const shipperB = new ShardStateShipper({
    client: clientB,
    ledger: ledgerB,
    snapshotIntervalTicks: 300,
  });
  await shipperB.pump(400);
  assert.equal(shipperB.worldAckedSeq, 3);
  assert.equal(await clientB.getLedgerHead(), 3);
  assert.deepEqual(
    (await clientB.getLedgerEvents(2)).map((e) => e.seq),
    [3],
  );

  // --- The zombie A is fenced out, mechanically, two ways.
  // (1) A's own client: its token died with its lease, writes fail.
  assert.equal(
    await clientA.putShardSnapshot({ tick: 600, digest: "zombie", payload: {} }),
    false,
  );
  assert.ok(errorsA.length > 0);
  // (2) A stale-epoch write under a live token: the core's epoch fence
  // rejects it with 409.
  await assert.rejects(
    transport.call(
      "PutShardSnapshot",
      {
        input: {
          regionId: "region-b",
          rangeKey: RANGE_KEY,
          tick: 600,
          epoch: 1,
          digest: "stale",
          payload: {},
          opId: "op-stale-epoch-1",
        },
      },
      clientB.currentLease!.token,
    ),
    (err: unknown) =>
      err instanceof WorldTransportError && err.code === 409,
  );
  // And the world still holds B's world, not the zombie's.
  assert.equal((await worldStore.getLatestShardSnapshot(RANGE_KEY))?.tick, 300);

  await clientB.stop();
  await clientA.stop();
  storeA.close();
  storeB.close();
  ledgerA.close();
  ledgerB.close();
});

test("the world snapshot's places (node stocks, PL3a) seed the local stores; none, nothing seeded", async () => {
  const source = memStore();
  const saved = source.saveWorld(300, buildSim(2, 10));
  source.close();
  const places = { resource_nodes: [{ key: "town/oak-1", stock: 2, regrowAt: null }] };

  const client = new FakeRecallClient();
  client.snapshot = snapRecord(saved.snapshotBytes, 300, 3);
  (client.snapshot.payload as Record<string, unknown>).places = places;
  const seeded: unknown[] = [];
  await recallShardState({ client, store: memStore(), ledger: memLedger(), seedPlaces: (p) => seeded.push(p) });
  assert.deepEqual(seeded, [places]);

  const bare = new FakeRecallClient();
  bare.snapshot = snapRecord(saved.snapshotBytes, 300, 3);
  const none: unknown[] = [];
  await recallShardState({ client: bare, store: memStore(), ledger: memLedger(), seedPlaces: (p) => none.push(p) });
  assert.deepEqual(none, [], "a payload from before PL3a seeds nothing");
});
