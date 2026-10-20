/**
 * Persistence P5: fleet boot with resource-aware assignment.
 *
 * - planFleetBoot decides the boot mode from the env alone:
 *   standalone (no WORLD_URL — no client, no world calls), explicit
 *   (REGION_CHUNK_RANGE set — the P3 path, assignment never
 *   consulted), assigned (WORLD_URL without an explicit range).
 * - An unassigned WorldClient registers with its hostId (no
 *   chunkRange on the wire), adopts the lease's assigned range +
 *   epoch, and P3 recall then runs for THAT range before any
 *   restore/simulation — proven here against the real recall path
 *   and local stores, with the transport call order recorded.
 * - The P2 shipper picks up the assigned range/epoch through the
 *   same client, unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { addComponent } from "bitecs";
import Database from "better-sqlite3";
import { rangeKeyFor, type ShardSnapshotRecord } from "@mmo-engine/world-server";
import { Health, SimWorld, SnapshotStore, Transform } from "../src/index.js";
import {
  WorldClient,
  WorldTransportError,
  type WorldTransport,
} from "../src/world/client.js";
import {
  DEFAULT_CHUNK_RANGE,
  parseChunkRangeEnv,
  planFleetBoot,
} from "../src/world/fleet-boot.js";
import { recallShardState } from "../src/world/state-recall.js";
import { ShardStateShipper } from "../src/world/state-shipper.js";
import { ItemLedger } from "../src/persist/item-ledger.js";

// ---------------------------------------------------------------------------
// planFleetBoot: the mode decision (standalone makes no world calls
// because server.ts constructs no client in this mode — the plan is
// the exact value that decision reads)
// ---------------------------------------------------------------------------

test("planFleetBoot: no WORLD_URL is standalone, whatever else is set", () => {
  assert.deepEqual(planFleetBoot({}), { mode: "standalone" });
  assert.deepEqual(planFleetBoot({ REGION_CHUNK_RANGE: "0,0,10,10" }), {
    mode: "standalone",
  });
  assert.deepEqual(planFleetBoot({ MMO_HOST_ID: "h1" }), { mode: "standalone" });
});

test("planFleetBoot: WORLD_URL + explicit REGION_CHUNK_RANGE is explicit mode", () => {
  const plan = planFleetBoot({
    WORLD_URL: "http://world:7780",
    REGION_CHUNK_RANGE: "10,20,110,220",
  });
  // Env order is "x0,z0,x1,z1".
  assert.deepEqual(plan, {
    mode: "explicit",
    chunkRange: { x0: 10, z0: 20, x1: 110, z1: 220 },
  });
  assert.deepEqual(parseChunkRangeEnv("0,0,4096,4096"), DEFAULT_CHUNK_RANGE);
});

test("planFleetBoot: WORLD_URL without a range is assigned mode, hostId from env or hostname", () => {
  assert.deepEqual(
    planFleetBoot({ WORLD_URL: "http://world:7780", MMO_HOST_ID: " host-big " }),
    { mode: "assigned", hostId: "host-big" },
  );
  assert.deepEqual(planFleetBoot({ WORLD_URL: "http://world:7780" }, "my-laptop"), {
    mode: "assigned",
    hostId: "my-laptop",
  });
});

// ---------------------------------------------------------------------------
// WorldClient in assignment mode, against a stub transport
// ---------------------------------------------------------------------------

class StubTransport implements WorldTransport {
  calls: { method: string; args: Record<string, unknown>; token?: string }[] = [];
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

const ASSIGNED = { x0: 4096, x1: 8192, z0: 0, z1: 4096 };
const ASSIGNED_KEY = rangeKeyFor(ASSIGNED);
const TOKEN = "e".repeat(64);

function assignedTransport(): StubTransport {
  const t = new StubTransport();
  t.handlers.set("RegisterRegion", () => ({
    lease: {
      regionId: "r-assigned",
      chunkRange: ASSIGNED,
      heartbeatIntervalMs: 60_000,
      registryVersion: 1,
      token: TOKEN,
      epoch: 7,
    },
  }));
  return t;
}

function assignedClient(t: StubTransport): WorldClient {
  return new WorldClient({
    transport: t,
    regionId: "r-assigned",
    hostId: "host-big",
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000,
    onError: () => {},
  });
}

test("unassigned client registers with hostId (no chunkRange) and adopts the lease's range + epoch", async () => {
  const t = assignedTransport();
  const c = assignedClient(t);
  // Before registration there is no range to key state by.
  assert.equal(c.chunkRange, null);
  assert.throws(() => c.rangeKey, /no chunk range yet/);

  await c.start();
  assert.equal(c.registered, true);
  assert.equal(c.epoch, 7);
  assert.deepEqual(c.chunkRange, ASSIGNED);
  assert.equal(c.rangeKey, ASSIGNED_KEY);

  const reg = t.calls.find((x) => x.method === "RegisterRegion")!;
  const input = reg.args["input"] as Record<string, unknown>;
  assert.equal(input["hostId"], "host-big");
  assert.ok(!("chunkRange" in input), "assignment mode sends no fixed range");
  await c.stop();
});

test("explicit-range client performs no assignment request: the wire carries its range and no hostId", async () => {
  const t = new StubTransport();
  const RANGE = { x0: 0, x1: 100, z0: 0, z1: 100 };
  t.handlers.set("RegisterRegion", () => ({
    lease: {
      regionId: "r1",
      chunkRange: RANGE,
      heartbeatIntervalMs: 60_000,
      registryVersion: 1,
      token: TOKEN,
      epoch: 3,
    },
  }));
  const c = new WorldClient({
    transport: t,
    regionId: "r1",
    chunkRange: RANGE,
    hostId: "host-should-be-ignored",
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000,
    onError: () => {},
  });
  // The explicit range keys state from construction, pre-registration.
  assert.equal(c.rangeKey, rangeKeyFor(RANGE));
  await c.start();
  const input = t.calls.find((x) => x.method === "RegisterRegion")!.args[
    "input"
  ] as Record<string, unknown>;
  assert.deepEqual(input["chunkRange"], RANGE);
  assert.ok(!("hostId" in input), "explicit mode never consults assignment");
  await c.stop();
});

// ---------------------------------------------------------------------------
// Assigned boot end to end: register -> recall the assigned range ->
// only then would restore/simulate run (the store is seeded by recall)
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

test("assigned shard recalls the assigned range's state after registering and before simulating", async () => {
  // The world holds a snapshot for the ASSIGNED range (written by a
  // previous holder of that range).
  const sourceStore = new SnapshotStore({ dbPath: ":memory:" });
  const saved = sourceStore.saveWorld(300, buildSim(3, 10));
  sourceStore.close();
  const snap: ShardSnapshotRecord = {
    rangeKey: ASSIGNED_KEY,
    regionId: "r-previous",
    tick: 300,
    epoch: 6,
    digest: "digest",
    payload: snapshotPayload(saved.snapshotBytes),
    storedAt: 1234,
  };

  const t = assignedTransport();
  t.handlers.set("GetShardSnapshot", (args) => {
    const input = args["input"] as { rangeKey: string };
    // The recall read must ask for the assigned range, not any other.
    assert.equal(input.rangeKey, ASSIGNED_KEY);
    return { snapshot: snap };
  });
  t.handlers.set("GetLedgerEvents", () => ({ events: [] }));

  const c = assignedClient(t);
  await c.start();
  assert.equal(c.registered, true);

  const store = new SnapshotStore({ dbPath: ":memory:" });
  const ledger = new ItemLedger(new Database(":memory:"));
  const outcome = await recallShardState({ client: c, store, ledger });

  assert.equal(outcome.source, "world");
  assert.equal(outcome.tick, 300);
  assert.equal(outcome.worldEpoch, 6);
  // Ordering: registration strictly before the recall reads — recall
  // is what seeds the store the boot restore then simulates from.
  assert.deepEqual(
    t.calls.map((x) => x.method),
    ["RegisterRegion", "GetShardSnapshot", "GetLedgerEvents"],
  );
  assert.equal(store.loadLatest()?.tick, 300);
  assert.deepEqual(store.loadLatest()?.bytes, saved.snapshotBytes);
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  assert.equal(store.restoreInto(sim), 300, "the recalled state is what simulates");

  // The P2 shipper rides the same client: its writes carry the
  // assigned range's key (via the client) and the lease's epoch.
  t.handlers.set("PutShardSnapshot", () => ({ snapshot: snap }));
  const shipper = new ShardStateShipper({
    client: c,
    ledger,
    snapshotIntervalTicks: 300,
  });
  const fresh = new SnapshotStore({ dbPath: ":memory:" });
  const saved2 = fresh.saveWorld(600, buildSim(2, 20));
  fresh.close();
  shipper.offerSnapshot(600, "digest-2", saved2.snapshotBytes);
  await shipper.pump(600 + shipper.snapshotPhaseOffsetTicks);
  const put = t.calls.find((x) => x.method === "PutShardSnapshot")!;
  const putInput = put.args["input"] as Record<string, unknown>;
  assert.equal(putInput["rangeKey"], ASSIGNED_KEY);
  assert.equal(putInput["epoch"], 7);

  await c.stop();
  store.close();
  ledger.close();
});
