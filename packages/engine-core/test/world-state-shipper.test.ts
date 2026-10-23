/**
 * Persistence P2: region write-through to the world store.
 *
 * WorldClient state-plane methods against a fake transport, and the
 * ShardStateShipper against a fake state-plane client + a real
 * in-memory ItemLedger: batching, ack tracking, retry after failure,
 * world outage = local-only, phase-offset snapshot uploads with
 * supersede, content-hash skip, and standalone/idle shipping nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import type { LedgerEvent } from "@mmo-engine/world-server";
import {
  WorldClient,
  WorldTransportError,
  type WorldTransport,
} from "../src/world/client.js";
import {
  ShardStateShipper,
  LEDGER_BATCH_MAX_EVENTS,
  type StatePlaneClient,
} from "../src/world/state-shipper.js";
import { ItemLedger, LedgerKind } from "../src/persist/item-ledger.js";

// ---------------------------------------------------------------------------
// WorldClient against a fake transport
// ---------------------------------------------------------------------------

class StubTransport implements WorldTransport {
  calls: { method: string; args: Record<string, unknown>; token?: string }[] = [];
  handlers = new Map<string, (args: Record<string, unknown>) => Record<string, unknown>>();

  async call(method: string, args: Record<string, unknown>, token?: string) {
    this.calls.push({ method, args, token });
    const h = this.handlers.get(method);
    if (!h) throw new WorldTransportError(501, `${method} not stubbed`);
    return h(args);
  }
}

const RANGE = { x0: 0, x1: 100, z0: 0, z1: 100 };
const RANGE_KEY = "0:100:0:100";
const EPOCH = 7;
const TOKEN = "c".repeat(64);

function makeWorldClient(t: StubTransport, errors: unknown[] = []) {
  return new WorldClient({
    transport: t,
    regionId: "r1",
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
}

async function registeredClient(t: StubTransport, errors: unknown[] = []) {
  t.handlers.set("RegisterRegion", () => ({
    lease: {
      regionId: "r1",
      heartbeatIntervalMs: 1000,
      registryVersion: 1,
      token: TOKEN,
      epoch: EPOCH,
    },
  }));
  const c = makeWorldClient(t, errors);
  await c.start();
  assert.equal(c.registered, true);
  return c;
}

test("client retains the lease epoch and its rangeKey", async () => {
  const t = new StubTransport();
  const c = await registeredClient(t);
  assert.equal(c.epoch, EPOCH);
  assert.equal(c.rangeKey, RANGE_KEY);
  await c.stop();
});

test("appendLedgerEvents sends rangeKey + epoch and returns the acked head", async () => {
  const t = new StubTransport();
  const c = await registeredClient(t);
  t.handlers.set("AppendLedgerEvents", () => ({ ackedSeq: 3 }));
  const events: LedgerEvent[] = [
    { seq: 1, tick: 10, payload: { itemId: 1 } },
    { seq: 2, tick: 10, payload: { itemId: 2 } },
    { seq: 3, tick: 11, payload: { itemId: 3 } },
  ];
  const acked = await c.appendLedgerEvents(events);
  assert.equal(acked, 3);
  const call = t.calls.find((x) => x.method === "AppendLedgerEvents")!;
  assert.equal(call.token, TOKEN);
  const input = call.args["input"] as Record<string, unknown>;
  assert.equal(input["regionId"], "r1");
  assert.equal(input["rangeKey"], RANGE_KEY);
  assert.equal(input["epoch"], EPOCH);
  assert.equal(typeof input["opId"], "string");
  assert.deepEqual(input["events"], events);
  await c.stop();
});

test("appendLedgerEvents failure surfaces via onError and returns null, never throws", async () => {
  const t = new StubTransport();
  const errors: unknown[] = [];
  const c = await registeredClient(t, errors);
  t.handlers.set("AppendLedgerEvents", () => {
    throw new WorldTransportError(0, "connection refused");
  });
  const acked = await c.appendLedgerEvents([{ seq: 1, tick: 1, payload: {} }]);
  assert.equal(acked, null);
  assert.equal(errors.length, 1);
  await c.stop();
});

test("putShardSnapshot sends {rangeKey, tick, epoch, digest} + payload; failure is false, not a throw", async () => {
  const t = new StubTransport();
  const errors: unknown[] = [];
  const c = await registeredClient(t, errors);
  t.handlers.set("PutShardSnapshot", () => ({ snapshot: {} }));
  const payload = { format: "flatbuffers-base64", data: "AAE=" };
  assert.equal(await c.putShardSnapshot({ tick: 300, digest: "d".repeat(64), payload }), true);
  const call = t.calls.find((x) => x.method === "PutShardSnapshot")!;
  assert.equal(call.token, TOKEN);
  const input = call.args["input"] as Record<string, unknown>;
  assert.equal(input["rangeKey"], RANGE_KEY);
  assert.equal(input["epoch"], EPOCH);
  assert.equal(input["tick"], 300);
  assert.equal(input["digest"], "d".repeat(64));
  assert.deepEqual(input["payload"], payload);

  t.handlers.set("PutShardSnapshot", () => {
    throw new WorldTransportError(409, "stale epoch");
  });
  assert.equal(await c.putShardSnapshot({ tick: 600, digest: "e".repeat(64), payload }), false);
  assert.equal(errors.length, 1);
  await c.stop();
});

test("an unregistered client ships nothing (standalone / world down at boot)", async () => {
  const t = new StubTransport();
  t.handlers.set("RegisterRegion", () => {
    throw new WorldTransportError(0, "connection refused");
  });
  const c = makeWorldClient(t);
  await c.start();
  assert.equal(c.registered, false);
  assert.equal(c.epoch, null);
  assert.equal(await c.appendLedgerEvents([{ seq: 1, tick: 1, payload: {} }]), null);
  assert.equal(await c.putShardSnapshot({ tick: 1, digest: "x", payload: {} }), false);
  assert.equal(
    t.calls.filter((x) => x.method !== "RegisterRegion").length,
    0,
    "no state-plane call left the region",
  );
  await c.stop();
});

test("character client methods mirror the world ops (P4 contract)", async () => {
  const t = new StubTransport();
  const c = await registeredClient(t);
  t.handlers.set("AcquireCharacterLock", () => ({
    lock: { characterId: 7, regionId: "r1", epoch: 3, expiresAt: 9999 },
  }));
  t.handlers.set("PutCharacterState", () => ({
    character: { characterId: 7, state: { hp: 5 }, version: 2, epoch: 3, regionId: "r1", updatedAt: 1 },
  }));
  t.handlers.set("GetCharacterState", () => ({ character: null }));
  t.handlers.set("ReleaseCharacterLock", () => ({}));

  const lock = await c.acquireCharacterLock(7, 30_000);
  assert.equal(lock.epoch, 3);
  const acquire = t.calls.find((x) => x.method === "AcquireCharacterLock")!;
  assert.equal(acquire.token, TOKEN);
  const acquireInput = acquire.args["input"] as Record<string, unknown>;
  assert.equal(acquireInput["regionId"], "r1");
  assert.equal(acquireInput["characterId"], 7);
  assert.equal(acquireInput["ttlMs"], 30_000);
  assert.equal(typeof acquireInput["opId"], "string");

  const put = await c.putCharacterState(7, lock.epoch, { hp: 5 });
  assert.equal(put.version, 2);
  const putCall = t.calls.find((x) => x.method === "PutCharacterState")!;
  assert.equal((putCall.args["input"] as Record<string, unknown>)["epoch"], 3);

  assert.equal(await c.getCharacterState(7), null);

  await c.releaseCharacterLock(7, lock.epoch);
  const rel = t.calls.find((x) => x.method === "ReleaseCharacterLock")!;
  assert.equal((rel.args["input"] as Record<string, unknown>)["epoch"], 3);
  await c.stop();
});

// ---------------------------------------------------------------------------
// ShardStateShipper against a fake state-plane client
// ---------------------------------------------------------------------------

/** Simulates the world store: dedups on seq, acks only the contiguous head. */
class FakeStatePlaneClient implements StatePlaneClient {
  readonly rangeKey: string;
  constructor(rangeKey: string = RANGE_KEY) {
    this.rangeKey = rangeKey;
  }
  ledgerCalls: LedgerEvent[][] = [];
  snapshotCalls: { tick: number; digest: string; payload: unknown }[] = [];
  ackedHead = 0;
  failLedger = false;
  failSnapshot = false;
  /** When set, ledger appends block on it (in-flight guard test). */
  gate: Promise<void> | null = null;

  async appendLedgerEvents(events: readonly LedgerEvent[]): Promise<number | null> {
    if (this.gate) await this.gate;
    this.ledgerCalls.push([...events]);
    if (this.failLedger) return null;
    let head = this.ackedHead;
    for (const e of events) {
      if (e.seq !== head + 1) break;
      head = e.seq;
    }
    this.ackedHead = head;
    return head;
  }

  async putShardSnapshot(snapshot: {
    tick: number;
    digest: string;
    payload: unknown;
  }): Promise<boolean> {
    this.snapshotCalls.push(snapshot);
    return !this.failSnapshot;
  }
}

function makeLedger(): ItemLedger {
  return new ItemLedger(new Database(":memory:"));
}

function makeShipper(client: FakeStatePlaneClient, ledger: ItemLedger) {
  return new ShardStateShipper({
    client,
    ledger,
    snapshotIntervalTicks: 300,
  });
}

function recordEvents(ledger: ItemLedger, n: number, firstId = 1): void {
  for (let i = 0; i < n; i++) {
    ledger.record(LedgerKind.Create, firstId + i, 3, 0, 0, 10);
  }
}

test("shipper sends each flushed batch once, keyed by the ledger's own seq", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);

  ledger.tick = 42;
  recordEvents(ledger, 3);
  assert.equal(ledger.flush(), 3);
  await shipper.pump(0);
  assert.equal(client.ledgerCalls.length, 1);
  const batch = client.ledgerCalls[0];
  assert.deepEqual(batch.map((e) => e.seq), [1, 2, 3], "seq is the item_events row identity");
  assert.equal(batch[0].tick, 42);
  const { committedAt, ...payload } = batch[0].payload as Record<string, unknown>;
  assert.equal(typeof committedAt, "number", "payload carries the row's commit time");
  assert.deepEqual(payload, {
    itemId: 1,
    kind: LedgerKind.Create,
    def: 3,
    owner: 0,
    slot: 0,
    durability: 10,
    x: 0,
    z: 0,
  });
  assert.equal(shipper.worldAckedSeq, 3);

  await shipper.pump(0);
  assert.equal(client.ledgerCalls.length, 1, "acked events are not resent");

  recordEvents(ledger, 2, 4);
  ledger.flush();
  await shipper.pump(0);
  assert.equal(client.ledgerCalls.length, 2);
  assert.deepEqual(client.ledgerCalls[1].map((e) => e.seq), [4, 5]);
  assert.equal(shipper.worldAckedSeq, 5);
});

test("shipper caps each request and continues the remainder on the next cycle", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);

  recordEvents(ledger, LEDGER_BATCH_MAX_EVENTS + 10);
  ledger.flush();
  await shipper.pump(0);
  assert.equal(client.ledgerCalls.length, 1, "one capped request per cycle");
  assert.equal(client.ledgerCalls[0].length, LEDGER_BATCH_MAX_EVENTS);
  assert.equal(shipper.worldAckedSeq, LEDGER_BATCH_MAX_EVENTS);

  await shipper.pump(0);
  assert.equal(client.ledgerCalls.length, 2);
  assert.equal(client.ledgerCalls[1].length, 10);
  assert.equal(client.ledgerCalls[1][0].seq, LEDGER_BATCH_MAX_EVENTS + 1);
  assert.equal(shipper.worldAckedSeq, LEDGER_BATCH_MAX_EVENTS + 10);
});

test("shipper retries the unacked tail after a failure, in order", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);

  recordEvents(ledger, 2);
  ledger.flush();
  client.failLedger = true;
  await shipper.pump(0);
  assert.equal(shipper.worldAckedSeq, 0);
  assert.equal(client.ledgerCalls.length, 1);

  client.failLedger = false;
  await shipper.pump(0);
  assert.equal(client.ledgerCalls.length, 2);
  assert.deepEqual(client.ledgerCalls[1].map((e) => e.seq), [1, 2], "same events retried");
  assert.equal(shipper.worldAckedSeq, 2);
});

test("world outage never blocks or fails the local flush", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);
  client.failLedger = true;
  client.failSnapshot = true;

  recordEvents(ledger, 3);
  // The local flush succeeds exactly as it does standalone…
  assert.equal(ledger.flush(), 3);
  assert.equal(ledger.load().length, 3);
  assert.equal(ledger.count(), 3);
  // …and the pump reports the outage by acking nothing, not by throwing.
  await shipper.pump(0);
  assert.equal(shipper.worldAckedSeq, 0);
  assert.equal(ledger.count(), 3, "local rows are the outbox; nothing was dropped");
});

test("pumps coalesce while an upload is in flight", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);

  recordEvents(ledger, 1);
  ledger.flush();
  let release!: () => void;
  client.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = shipper.pump(0);
  await shipper.pump(0); // returns at once: an upload is already running
  assert.equal(shipper.uploadInFlight, true);
  release();
  await first;
  assert.equal(client.ledgerCalls.length, 1, "no piled-up duplicate request");
  assert.equal(shipper.worldAckedSeq, 1);
});

test("an idle cycle ships nothing", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);
  await shipper.pump(0);
  await shipper.pump(300);
  assert.equal(client.ledgerCalls.length, 0);
  assert.equal(client.snapshotCalls.length, 0);
});

test("snapshot phase offset is deterministic per rangeKey and inside the interval", () => {
  const ledger = makeLedger();
  const a = makeShipper(new FakeStatePlaneClient(), ledger);
  const b = makeShipper(new FakeStatePlaneClient(), ledger);
  assert.equal(a.snapshotPhaseOffsetTicks, b.snapshotPhaseOffsetTicks);
  assert.ok(a.snapshotPhaseOffsetTicks >= 0);
  assert.ok(a.snapshotPhaseOffsetTicks < 300);
  const other = new ShardStateShipper({
    client: new FakeStatePlaneClient("100:200:100:200"),
    ledger,
    snapshotIntervalTicks: 300,
  });
  assert.notEqual(
    other.snapshotPhaseOffsetTicks,
    a.snapshotPhaseOffsetTicks,
    "different ranges spread across the interval",
  );
});

test("snapshot uploads at its phase offset, with the exact bytes + content hash", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);
  const bytes = new Uint8Array([9, 8, 7, 6, 5]);
  const digest = "telemetry-digest";

  shipper.offerSnapshot(300, digest, bytes);
  const due = 300 + shipper.snapshotPhaseOffsetTicks;
  await shipper.pump(Math.max(0, due - 1));
  assert.equal(client.snapshotCalls.length, 0, "not before the phase slot");
  await shipper.pump(due);
  assert.equal(client.snapshotCalls.length, 1);
  const call = client.snapshotCalls[0];
  assert.equal(call.tick, 300);
  assert.equal(call.digest, digest, "telemetry digest carried verbatim");
  const payload = call.payload as { format: string; contentHash: string; data: string };
  assert.equal(payload.format, "flatbuffers-base64");
  assert.equal(
    payload.contentHash,
    crypto.createHash("sha256").update(bytes).digest("hex"),
    "content hash is over the serialized bytes, not tick:entityCount",
  );
  assert.deepEqual(new Uint8Array(Buffer.from(payload.data, "base64")), bytes);
});

test("a fresher checkpoint supersedes a pending older one", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);
  const offset = shipper.snapshotPhaseOffsetTicks;

  shipper.offerSnapshot(300, "d1", new Uint8Array([1]));
  shipper.offerSnapshot(600, "d2", new Uint8Array([2]));
  await shipper.pump(600 + offset);
  assert.equal(client.snapshotCalls.length, 1, "the stale checkpoint never uploads");
  assert.equal(client.snapshotCalls[0].tick, 600);
  const payload = client.snapshotCalls[0].payload as { data: string };
  assert.deepEqual(new Uint8Array(Buffer.from(payload.data, "base64")), new Uint8Array([2]));
});

test("the server's save loop (offer every 30 ticks, pump right after) still uploads once per interval", async () => {
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, makeLedger());
  for (let t = 30; t <= 900; t += 30) {
    shipper.offerSnapshot(t, `d${t}`, new Uint8Array([t & 255, t >> 8]));
    await shipper.pump(t);
  }
  const n = client.snapshotCalls.length;
  assert.ok(n >= 2 && n <= 4, `three intervals give about three uploads (got ${n})`);
  for (const c of client.snapshotCalls) assert.equal((c.tick - 30) % 30, 0, "each upload carries a saved checkpoint");
});

test("unchanged snapshot content skips the upload entirely", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);
  const offset = shipper.snapshotPhaseOffsetTicks;
  const bytes = new Uint8Array([4, 2]);

  shipper.offerSnapshot(300, "d1", bytes);
  await shipper.pump(300 + offset);
  assert.equal(client.snapshotCalls.length, 1);

  // Same bytes at the next checkpoint (idle range): zero snapshot I/O.
  shipper.offerSnapshot(600, "d2", bytes);
  await shipper.pump(600 + offset);
  assert.equal(client.snapshotCalls.length, 1, "content hash matched the last acked upload");

  // Changed bytes upload again.
  shipper.offerSnapshot(900, "d3", new Uint8Array([4, 3]));
  await shipper.pump(900 + offset);
  assert.equal(client.snapshotCalls.length, 2);
  assert.equal(client.snapshotCalls[1].tick, 900);
});

test("a failed snapshot upload stays pending and retries until superseded", async () => {
  const ledger = makeLedger();
  const client = new FakeStatePlaneClient();
  const shipper = makeShipper(client, ledger);
  const offset = shipper.snapshotPhaseOffsetTicks;

  client.failSnapshot = true;
  shipper.offerSnapshot(300, "d1", new Uint8Array([1]));
  await shipper.pump(300 + offset);
  assert.equal(client.snapshotCalls.length, 1);

  client.failSnapshot = false;
  await shipper.pump(300 + offset);
  assert.equal(client.snapshotCalls.length, 2, "retried on the next cycle");
  assert.equal(client.snapshotCalls[1].tick, 300);
});

test("places (node stocks, PL3a) ride the snapshot, and a change to them alone still uploads", async () => {
  const client = new FakeStatePlaneClient();
  let stock = 3;
  const shipper = new ShardStateShipper({
    client,
    ledger: makeLedger(),
    snapshotIntervalTicks: 300,
    places: () => ({ resource_nodes: [{ key: "town/oak-1", stock, regrowAt: null }] }),
  });
  const offset = shipper.snapshotPhaseOffsetTicks;
  const bytes = new Uint8Array([7, 7]);

  shipper.offerSnapshot(300, "d1", bytes);
  await shipper.pump(300 + offset);
  assert.deepEqual((client.snapshotCalls[0].payload as { places: unknown }).places, { resource_nodes: [{ key: "town/oak-1", stock: 3, regrowAt: null }] });

  shipper.offerSnapshot(600, "d2", bytes);
  await shipper.pump(600 + offset);
  assert.equal(client.snapshotCalls.length, 1, "same bytes, same places: skipped");

  stock = 2; // a gather: the ECS bytes are the same, the stock isn't
  shipper.offerSnapshot(900, "d3", bytes);
  await shipper.pump(900 + offset);
  assert.equal(client.snapshotCalls.length, 2);
  assert.equal(((client.snapshotCalls[1].payload as { places: { resource_nodes: { stock: number }[] } }).places.resource_nodes[0]).stock, 2);
});
