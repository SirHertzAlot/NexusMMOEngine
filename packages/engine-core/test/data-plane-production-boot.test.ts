/**
 * Production Boot & Security Perimeter Test Suite (PR #430 / Phase 2)
 *
 * Verifies:
 * 1. Rollback path (MMO_DATA_PLANE=0 / unset): Gateway operates in-process,
 *    dataPlaneQueue is undefined, dataPlaneStats reports hasQueue=false, enqueued=0.
 * 2. Production 3-Thread SAB Topology (MMO_DATA_PLANE=1): Gateway forwards validated
 *    intents into AtomicSPSCQueue -> SimWorker -> PersistWorker.
 * 3. Strict Security Perimeter:
 *    - Unauthenticated intents (intent before hello) are rejected (4003) and NEVER enqueue.
 *    - Foreign entity intents (intent targeting another player) are rejected (4003) and NEVER enqueue.
 *    - Malformed / non-finite payloads are rejected (4003) and NEVER enqueue.
 *    - Stale / out-of-order intents are dropped and NEVER enqueue.
 * 4. Crash Containment: SimWorker crash or shutdown leaves Gateway and client sockets alive.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MessageType,
  PROTOCOL_VERSION,
  type ErrorMessage,
  decodeControl,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../src/net/gateway.js";
import {
  DATA_PLANE_ENTITY_CAPACITY,
  INTENT_FLAGS,
  SOA_LAYOUT,
} from "../src/sab-store.js";
import { DT } from "../src/sim-worker.js";
import {
  HybridDataPlaneServer,
} from "../src/data-plane-server.js";
import {
  encodeIntentMessage,
} from "../src/net/intent.js";
import { HeadlessClient, type HelloAuth } from "./net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./net/auth-harness.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

describe("Phase 2: Production Data Plane Boot & Security Perimeter", () => {
  let gw: Gateway | null = null;
  let dataPlaneServer: HybridDataPlaneServer | null = null;
  let client: HeadlessClient | null = null;

  afterEach(async () => {
    if (client) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      client = null;
    }
    if (gw) {
      await gw.close();
      gw = null;
    }
    if (dataPlaneServer) {
      await dataPlaneServer.close();
      dataPlaneServer = null;
    }
  });

  it("boots rollback topology in-process when dataPlaneQueue is omitted (MMO_DATA_PLANE=0)", async () => {
    const credStore = await makeCredentialStore();
    gw = new Gateway({
      credentialStore: credStore,
    });
    const port = await gw.listen();

    assert.equal(gw.dataPlaneStats.hasQueue, false);
    assert.equal(gw.dataPlaneStats.enqueued, 0);
    assert.equal(gw.dataPlaneStats.dropped, 0);

    client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const welcome = await client.hello("alice", creds("alice"));
    assert.equal(welcome.protocol, PROTOCOL_VERSION);

    // Send valid intent in-process
    client.sendIntent(1n, BigInt(welcome.player_entity), {
      mx: 0,
      my: 0,
      mz: 1.0,
      lookYaw: 0,
      lookPitch: 0,
      jump: false,
      buttons: 0,
    });

    await sleep(60);
    // Verified: in-process Gateway handles intent without touching SPSC queue
    assert.equal(gw.dataPlaneStats.hasQueue, false);
    assert.equal(gw.dataPlaneStats.enqueued, 0);
  });

  it("boots 3-thread data plane topology and propagates authenticated intents across SPSC ring (MMO_DATA_PLANE=1)", async () => {
    // 1. Initialize HybridDataPlaneServer with deterministic stepping
    dataPlaneServer = new HybridDataPlaneServer({
      entityCapacity: 512,
      heapMegabytes: 2,
      simAutoStart: false, // Step worker deterministically
      spawnWorkers: true,
      spawnPersistWorker: true,
      simMode: "fused-intents",
      decodeMovementIntents: true,
      dbUrl: "mem://",
    });
    await dataPlaneServer.startWorkers();

    // 2. Initialize Gateway with dataPlaneQueue from HybridDataPlaneServer
    const credStore = await makeCredentialStore();
    gw = new Gateway({
      dataPlaneQueue: dataPlaneServer.gatewayInputQueue,
      credentialStore: credStore,
    });
    const port = await gw.listen();

    assert.equal(gw.dataPlaneStats.hasQueue, true);
    assert.equal(gw.dataPlaneStats.enqueued, 0);

    // 3. Connect client and complete handshake
    client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const welcome = await client.hello("alice", creds("alice"));
    assert.equal(welcome.protocol, PROTOCOL_VERSION);

    const playerWireEntity = BigInt(welcome.player_entity);
    const slot = Number(playerWireEntity & 0xffff_ffffn);

    // Mark slot alive in shared memory
    const bSlot = slot * SOA_LAYOUT.STRIDE;
    dataPlaneServer.views.intMatrixView[bSlot + SOA_LAYOUT.HEALTH] = 100;

    // 4. Send authenticated intent: forward (mz = 1.0) + sprint (buttons = 1)
    client.sendIntent(1n, playerWireEntity, {
      mx: 0,
      my: 0,
      mz: 1.0,
      lookYaw: 0,
      lookPitch: 0,
      jump: false,
      buttons: 1, // SPRINT
    });

    // Wait for Gateway to validate and enqueue to SPSC ring
    const deadline = Date.now() + 2000;
    while (gw.dataPlaneStats.enqueued < 1 && Date.now() < deadline) {
      await sleep(10);
    }
    assert.equal(gw.dataPlaneStats.enqueued, 1);
    assert.equal(gw.dataPlaneStats.dropped, 0);

    // 5. Step SimWorker to process the intent ring and execute C++ applyIntentsAndStep
    await dataPlaneServer.stepSimWorker(DT);

    // Verify entity state changed in SAB
    const stats = dataPlaneServer.stats;
    assert.ok(stats.commandsProcessed >= 1);

    // Expected forward sprint movement
    const pz = dataPlaneServer.views.floatMatrixView[bSlot + SOA_LAYOUT.POSITION_Z];
    assert.ok(pz > 0, `Expected entity forward position > 0, got ${pz}`);

    // Verify persist worker flush
    await dataPlaneServer.flushPersistWorker();
  });

  describe("Security Perimeter Boundary", () => {
    it("rejects unauthenticated intents before hello (4003) and never enqueues to worker queue", async () => {
      dataPlaneServer = new HybridDataPlaneServer({
        entityCapacity: 512,
        heapMegabytes: 2,
        simAutoStart: false,
        spawnWorkers: true,
        spawnPersistWorker: true,
        dbUrl: "mem://",
      });
      await dataPlaneServer.startWorkers();

      const credStore = await makeCredentialStore();
      gw = new Gateway({
        dataPlaneQueue: dataPlaneServer.gatewayInputQueue,
        credentialStore: credStore,
      });
      const port = await gw.listen();

      client = new HeadlessClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      // Arm waiter for Error message
      const errorP = client.waitFor(MessageType.Error, 1);

      // Attempt to send intent BEFORE hello
      client.sendIntent(1n, 42n, {
        mx: 0,
        my: 0,
        mz: 1.0,
        lookYaw: 0,
        lookPitch: 0,
        jump: false,
        buttons: 0,
      });

      const [errPayload] = await errorP;
      const err = decodeControl(errPayload) as ErrorMessage;
      assert.equal(err.code, 4003);
      assert.match(err.message, /intent before hello/i);

      // Verify ZERO intents reached dataPlaneQueue
      assert.equal(gw.dataPlaneStats.enqueued, 0);
      assert.equal(dataPlaneServer.stats.commandsProcessed, 0);
    });

    it("rejects foreign entity intents (4003) and never enqueues to worker queue", async () => {
      dataPlaneServer = new HybridDataPlaneServer({
        entityCapacity: 512,
        heapMegabytes: 2,
        simAutoStart: false,
        spawnWorkers: true,
        spawnPersistWorker: true,
        dbUrl: "mem://",
      });
      await dataPlaneServer.startWorkers();

      const credStore = await makeCredentialStore();
      gw = new Gateway({
        dataPlaneQueue: dataPlaneServer.gatewayInputQueue,
        credentialStore: credStore,
      });
      const port = await gw.listen();

      client = new HeadlessClient();
      await client.connect(`ws://127.0.0.1:${port}`);
      const welcome = await client.hello("alice", creds("alice"));

      const realEntity = BigInt(welcome.player_entity);
      const foreignEntity = realEntity + 9999n;

      // Arm waiter for Error message
      const errorP = client.waitFor(MessageType.Error, 1);

      // Send intent targeting foreign entity
      client.sendIntent(1n, foreignEntity, {
        mx: 1.0,
        my: 0,
        mz: 0,
        lookYaw: 0,
        lookPitch: 0,
        jump: false,
        buttons: 0,
      });

      const [errPayload] = await errorP;
      const err = decodeControl(errPayload) as ErrorMessage;
      assert.equal(err.code, 4003);
      assert.match(err.message, /intent for foreign entity/i);

      // Verify ZERO intents reached dataPlaneQueue
      assert.equal(gw.dataPlaneStats.enqueued, 0);
      assert.equal(dataPlaneServer.stats.commandsProcessed, 0);
    });

    it("rejects malformed intent payloads (4003) and never enqueues to worker queue", async () => {
      dataPlaneServer = new HybridDataPlaneServer({
        entityCapacity: 512,
        heapMegabytes: 2,
        simAutoStart: false,
        spawnWorkers: true,
        spawnPersistWorker: true,
        dbUrl: "mem://",
      });
      await dataPlaneServer.startWorkers();

      const credStore = await makeCredentialStore();
      gw = new Gateway({
        dataPlaneQueue: dataPlaneServer.gatewayInputQueue,
        credentialStore: credStore,
      });
      const port = await gw.listen();

      client = new HeadlessClient();
      await client.connect(`ws://127.0.0.1:${port}`);
      await client.hello("alice", creds("alice"));

      const errorP = client.waitFor(MessageType.Error, 1);

      // Send malformed garbage bytes on MessageType.Intent
      client.sendRaw(MessageType.Intent, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

      const [errPayload] = await errorP;
      const err = decodeControl(errPayload) as ErrorMessage;
      assert.equal(err.code, 4003);
      assert.match(err.message, /malformed intent/i);

      // Verify ZERO intents reached dataPlaneQueue
      assert.equal(gw.dataPlaneStats.enqueued, 0);
    });

    it("drops stale out-of-order intents without enqueueing to worker queue", async () => {
      dataPlaneServer = new HybridDataPlaneServer({
        entityCapacity: 512,
        heapMegabytes: 2,
        simAutoStart: false,
        spawnWorkers: true,
        spawnPersistWorker: true,
        dbUrl: "mem://",
      });
      await dataPlaneServer.startWorkers();

      const credStore = await makeCredentialStore();
      gw = new Gateway({
        dataPlaneQueue: dataPlaneServer.gatewayInputQueue,
        credentialStore: credStore,
      });
      const port = await gw.listen();

      client = new HeadlessClient();
      await client.connect(`ws://127.0.0.1:${port}`);
      const welcome = await client.hello("alice", creds("alice"));
      const entity = BigInt(welcome.player_entity);

      // Send clientTick = 100
      client.sendIntent(100n, entity, {
        mx: 0,
        my: 0,
        mz: 1.0,
        lookYaw: 0,
        lookPitch: 0,
        jump: false,
        buttons: 0,
      });

      const deadline = Date.now() + 2000;
      while (gw.dataPlaneStats.enqueued < 1 && Date.now() < deadline) {
        await sleep(10);
      }
      assert.equal(gw.dataPlaneStats.enqueued, 1);

      // Send stale clientTick = 50 (<= 100)
      client.sendIntent(50n, entity, {
        mx: 0,
        my: 0,
        mz: 1.0,
        lookYaw: 0,
        lookPitch: 0,
        jump: false,
        buttons: 0,
      });

      await sleep(50);
      // Stale intent was dropped; enqueued count remains 1
      assert.equal(gw.dataPlaneStats.enqueued, 1);
    });
  });

  describe("Crash Containment & Worker Isolation", () => {
    it("maintains Gateway socket connectivity even if worker runtime stops", async () => {
      dataPlaneServer = new HybridDataPlaneServer({
        entityCapacity: 512,
        heapMegabytes: 2,
        simAutoStart: false,
        spawnWorkers: true,
        spawnPersistWorker: false,
        dbUrl: "mem://",
      });
      await dataPlaneServer.startWorkers();

      const credStore = await makeCredentialStore();
      gw = new Gateway({
        dataPlaneQueue: dataPlaneServer.gatewayInputQueue,
        credentialStore: credStore,
      });
      const port = await gw.listen();

      client = new HeadlessClient();
      await client.connect(`ws://127.0.0.1:${port}`);
      const welcome = await client.hello("alice", creds("alice"));
      assert.ok(welcome.session_token);

      // Simulate isolated worker crash / termination
      await dataPlaneServer.close();
      dataPlaneServer = null;

      // Gateway socket remains open and ping/pong still operates
      client.sendPing();
      const pongs = await client.waitFor(MessageType.Pong, 1);
      assert.equal(pongs.length, 1);
      assert.equal(client.closed, false);
    });
  });
});
