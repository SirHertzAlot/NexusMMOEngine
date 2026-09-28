/**
 * Gateway restore-from-snapshot boot (slice 1.4).
 *
 * A world is saved at tick 300, "rebooted" into a fresh SimWorld via
 * SnapshotStore.restoreInto, and served by a Gateway constructed with
 * { world, startTick: 301 }. Asserted:
 * - the gateway ticks from restored tick + 1 (serverTick, welcome.server_tick)
 * - a joining client transparently receives the restored entities in
 *   its welcome snapshot (no resync storm, no empty world)
 * - per-tick deltas flow on top of the restored baseline
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MessageType } from "@mmo-engine/protocol";
import { Gateway } from "../../src/index.js";
import {
  SnapshotStore,
  SimWorld,
  Transform,
  Health,
  decodeSnapshot,
  decodeDelta,
  type CollectedState,
} from "../../src/index.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const settle = (): Promise<void> => sleep(50);

let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

/** Save a 10-entity world at tick 300, return the DB path. */
function saveWorldAt300(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-gw-restore-"));
  const dbPath = path.join(dir, "world.db");
  const store = new SnapshotStore({ dbPath });
  const sim = new SimWorld();
  for (let i = 0; i < 10; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Health, e);
    Transform.px[e] = i * 10;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Health.current[e] = 100;
    Health.max[e] = 100;
  }
  store.saveWorld(300, sim);
  store.close();
  return dbPath;
}

async function bootRestoredGateway(dbPath: string): Promise<string> {
  const store = new SnapshotStore({ dbPath });
  // Fresh-process model: reset the cursor so the restored world gets
  // dense eids from 0.
  SimWorld.resetEntityCursorForTesting();
  const restored = new SimWorld();
  const restoredTick = store.restoreInto(restored);
  store.close();
  assert.equal(restoredTick, 300);

  now = 1_000_000;
  gw = new Gateway({
    world: restored,
    startTick: restoredTick! + 1,
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
  });
  const port = await gw.listen();
  gw.frame(now); // prime the loop clock (see gateway.test.ts)
  return `ws://127.0.0.1:${port}`;
}

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

async function join(url: string): Promise<{
  client: HeadlessClient;
  entity: bigint;
  snapshot: CollectedState;
  serverTick: number;
}> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello("alice", {
    username: "alice",
    password: TEST_PASSWORD,
  });
  const [snapPayload] = await snapP;
  return {
    client,
    entity: BigInt(welcome.player_entity),
    snapshot: decodeSnapshot(snapPayload),
    serverTick: welcome.server_tick,
  };
}

describe("gateway: restore-from-snapshot boot", () => {
  it("ticks from restored tick + 1 and serves the restored world", async () => {
    const url = await bootRestoredGateway(saveWorldAt300());

    frames(3); // ticks 301, 302, 303
    assert.equal(gw!.serverTick, 303, "serverTick resumes at restored tick + 1");

    const { client, entity, snapshot, serverTick } = await join(url);
    assert.equal(serverTick, 303, "welcome carries the resumed tick");

    // The restored entities are in the welcome snapshot, transparently.
    const restoredRows = snapshot.transforms.filter((r) => r.wireId !== entity);
    assert.equal(restoredRows.length, 10, "all 10 restored entities present");
    const px = restoredRows.map((r) => r.px).sort((a, b) => a - b);
    assert.deepEqual(px, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const me = snapshot.transforms.find((r) => r.wireId === entity);
    assert.ok(me, "the joining player's own entity is present too");

    // Deltas keep flowing on top of the restored baseline.
    const deltasP = client.waitFor(MessageType.Delta, 10);
    frames(10);
    const deltas = await deltasP;
    assert.ok(deltas.length >= 10, "per-tick deltas flow after restore");
    for (const d of deltas) decodeDelta(d); // must parse, never throw
    await settle();
    await client.close();
  });

  it("rejects a startTick below 1", () => {
    assert.throws(
      () => new Gateway({ startTick: 0 }),
      /startTick must be an integer >= 1/,
    );
  });
});
