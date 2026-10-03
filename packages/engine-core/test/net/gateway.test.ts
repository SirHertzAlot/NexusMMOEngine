/**
 * Gateway end-to-end tests (slice 1.3): real WebSocket clients against a
 * real Gateway, driven by a synthetic clock so ticks, heartbeats, and
 * grace periods are fully deterministic.
 *
 * Race discipline: every waitFor() is registered BEFORE the action that
 * produces the messages (hello, frames), because waitFor only counts
 * payloads received after registration. The welcome snapshot in
 * particular arrives microseconds after the welcome on the same server
 * processing step, so it must be awaited from a waiter armed first.
 *
 * Covered:
 * - hello -> welcome -> full snapshot -> parseable per-tick deltas
 * - an intent moves the sender's OWN player entity
 * - three concurrent clients drive independent players with no cross-talk
 * - foreign-entity intents are rejected (authority)
 * - stale (out-of-order) intents are dropped
 * - token reconnect inside the grace period re-attaches the same entity;
 *   after the grace period a fresh entity spawns
 * - a live same-token connection takes over (last connection wins)
 * - heartbeat drops silent clients; the grace sweep removes them
 * - bad hellos (protocol mismatch, malformed auth) are rejected
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { defineQuery } from "bitecs";
import {
  Ability,
  decodeControl,
  encodeControl,
  LocomotionMode,
  MessageType,
  PROTOCOL_VERSION,
  type ErrorMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import * as C from "../../src/components.js";
import { PLAYER_SPEED } from "../../src/systems.js";
import {
  decodeDelta,
  decodeSnapshot,
  type CollectedState,
} from "../../src/snapshot.js";
import type { QueuedIntent } from "../../src/world.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Let the event loop turn so in-flight WebSocket messages are delivered
 * and processed by the server. Required between sendIntent() and frames():
 * frames() runs the sim synchronously, so an intent still sitting in a
 * socket buffer would miss every tick.
 */
const settle = (): Promise<void> => sleep(50);

const move = (mx: number, my: number, mz: number): QueuedIntent => ({
  mx, my, mz,
  lookYaw: 0, lookPitch: 0, jump: false, buttons: 0,
});

// ---------------------------------------------------------------- harness

let now = 0;
let gw: Gateway | null = null;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    ...opts,
  });
  const port = await gw.listen();
  // Prime the loop clock: TickLoop.frame() only arms its clock on the
  // first call, so without this frames(n) would run n-1 ticks.
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

/** Advance the synthetic clock by n ticks, running the sim each tick. */
function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

interface JoinedClient {
  client: HeadlessClient;
  entity: bigint;
  snapshot: CollectedState;
  sessionToken: string;
  welcome: Awaited<ReturnType<HeadlessClient["hello"]>>;
}

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

async function connectHello(
  url: string,
  name: string,
  auth: HelloAuth,
): Promise<JoinedClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  // Arm the snapshot waiter BEFORE hello: the server sends it on the same
  // processing step as the welcome.
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(name, auth);
  assert.equal(welcome.protocol, PROTOCOL_VERSION);
  assert.match(
    welcome.session_token,
    /^[0-9a-f]{64}$/,
    "welcome carries a session token",
  );
  const [snapPayload] = await snapP;
  return {
    client,
    entity: BigInt(welcome.player_entity),
    snapshot: decodeSnapshot(snapPayload),
    sessionToken: welcome.session_token,
    welcome,
  };
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

// ---------------------------------------------------------------- tests

describe("gateway: hello / welcome / snapshot / deltas", () => {
  it("welcomes the client, sends a full snapshot, then per-tick deltas", async () => {
    const url = await startGateway();
    const { client, entity, snapshot } = await connectHello(url, "alice", creds("alice"));

    const me = snapshot.transforms.find((r) => r.wireId === entity);
    assert(me, "player entity is present in the welcome snapshot");
    assert.equal(snapshot.spawned.length, 1, "one entity spawned so far");

    const deltasP = client.waitFor(MessageType.Delta, 30);
    frames(35);
    const deltas = await deltasP;
    assert(deltas.length >= 30, "at least 30 deltas received");
    for (const d of deltas) decodeDelta(d); // must parse, never throw
    await client.close();
  });

  it("spawns players standing on the ground (groundHeightAt)", async () => {
    const ground = (x: number, z: number): number => 120 + x * 0.5 - z * 0.25;
    const url = await startGateway({ groundHeightAt: ground });
    const a = await connectHello(url, "alice", creds("alice"));
    const b = await connectHello(url, "user-a", creds("user-a"));
    for (const { entity, snapshot } of [a, b]) {
      const me = snapshot.transforms.find((r) => r.wireId === entity);
      assert(me);
      assert.equal(me.py, Math.fround(ground(me.px, me.pz)), `spawned on the ground at (${me.px}, ${me.pz})`);
    }
    await a.client.close();
    await b.client.close();
  });

  it("players can swim by default; flight is granted by the playerAbilities option", async () => {
    const swimmer = await connectHello(await startGateway(), "alice", creds("alice"));
    assert.deepEqual(
      swimmer.snapshot.locomotions.map((r) => [r.wireId, r.mode, r.abilities, r.breath]),
      [[swimmer.entity, LocomotionMode.Ground, Ability.Swim, 1]],
    );
    await swimmer.client.close();
    await gw!.close();

    const flyer = await connectHello(await startGateway({ playerAbilities: Ability.Swim | Ability.Fly }), "alice", creds("alice"));
    assert.equal(flyer.snapshot.locomotions[0].abilities, Ability.Swim | Ability.Fly);
    await flyer.client.close();
  });

  it("the welcome carries the day clock when the server runs one", async () => {
    const plain = await connectHello(await startGateway(), "alice", creds("alice"));
    assert.equal(plain.welcome.day, undefined, "no day clock configured: none sent");
    await plain.client.close();
    await gw!.close();

    const day = { seconds: 1200, offset: 0.25 };
    const withDay = await connectHello(await startGateway({ dayClock: day }), "alice", creds("alice"));
    assert.deepEqual(withDay.welcome.day, day);
    await withDay.client.close();
  });
});

describe("gateway: intents drive the sim", () => {
  it("an intent moves the sender's own player entity", async () => {
    const url = await startGateway();
    const { client, entity, snapshot } = await connectHello(
      url,
      "alice",
      creds("alice"),
    );
    const px0 = snapshot.transforms.find((r) => r.wireId === entity)!.px;

    client.sendIntent(1n, entity, move(1, 0, 0));
    await settle();
    const deltasP = client.waitFor(MessageType.Delta, 10);
    frames(10);
    const deltas = await deltasP;
    const last = decodeDelta(deltas[deltas.length - 1]);
    const row = last.transforms.find((r) => r.wireId === entity);
    assert(row, "player transform present in delta");
    assert(
      row.px > px0 + 1,
      `player moved +x: ${px0} -> ${row.px}`,
    );
    await client.close();
  });

  it("three concurrent clients drive independent players with no cross-talk", async () => {
    const url = await startGateway();
    const a = await connectHello(url, "user-a", creds("user-a"));
    const b = await connectHello(url, "user-b", creds("user-b"));
    const c = await connectHello(url, "user-c", creds("user-c"));
    const ids = [a.entity, b.entity, c.entity];
    assert.equal(new Set(ids).size, 3, "each client gets a distinct entity");

    // Each hello triggers a fresh snapshot of the CURRENT world state, so
    // only the LAST hello (c) sees all three players. Use it as the
    // start-position baseline.
    const start = new Map(
      c.snapshot.transforms.map((r) => [r.wireId, r] as const),
    );

    a.client.sendIntent(1n, a.entity, move(1, 0, 0));
    b.client.sendIntent(1n, b.entity, move(0, 0, 1));
    c.client.sendIntent(1n, c.entity, move(-1, 0, 0));
    await settle();
    // Every client receives the same broadcast deltas.
    const waits = [a, b, c].map((p) => p.client.waitFor(MessageType.Delta, 10));
    frames(10);
    await Promise.all(waits);
    const last = decodeDelta(a.client.payloads(MessageType.Delta).at(-1)!);
    const row = (id: bigint) => last.transforms.find((r) => r.wireId === id)!;
    assert(row(a.entity).px > start.get(a.entity)!.px, "A moved +x");
    assert(row(b.entity).pz > start.get(b.entity)!.pz, "B moved +z");
    assert(row(c.entity).px < start.get(c.entity)!.px, "C moved -x");

    for (const p of [a, b, c]) await p.client.close();
  });

  it("rejects intents for another client's entity", async () => {
    const url = await startGateway();
    const a = await connectHello(url, "user-a", creds("user-a"));
    const b = await connectHello(url, "user-b", creds("user-b"));
    const bStart = b.snapshot.transforms.find((r) => r.wireId === b.entity)!;

    a.client.sendIntent(1n, b.entity, move(1, 0, 0)); // not A's entity
    const [errPayload] = await a.client.waitFor(MessageType.Error, 1);
    const err = decodeControl<ErrorMessage>(errPayload);
    assert.equal(err.code, 4003);

    const deltasP = b.client.waitFor(MessageType.Delta, 5);
    frames(5);
    const deltas = await deltasP;
    const last = decodeDelta(deltas[deltas.length - 1]);
    const row = last.transforms.find((r) => r.wireId === b.entity);
    if (row) {
      assert.equal(row.px, bStart.px, "B's position unchanged");
      assert.equal(row.pz, bStart.pz, "B's position unchanged");
    }
    // (row absent is the common case: nothing about B changed at all)

    await a.client.close();
    await b.client.close();
  });

  it("drops stale (out-of-order) intents", async () => {
    const url = await startGateway();
    const { client, entity } = await connectHello(url, "alice", creds("alice"));

    client.sendIntent(5n, entity, move(1, 0, 0));
    await settle();
    const firstP = client.waitFor(MessageType.Delta, 3);
    frames(3);
    const first = await firstP;
    const midPx = decodeDelta(first[first.length - 1]).transforms.find(
      (r) => r.wireId === entity,
    )!.px;

    client.sendIntent(3n, entity, move(-1, 0, 0)); // stale: must be dropped
    await settle();
    const secondP = client.waitFor(MessageType.Delta, 6);
    frames(6);
    const second = await secondP;
    const finalPx = decodeDelta(second[second.length - 1]).transforms.find(
      (r) => r.wireId === entity,
    )!.px;
    assert(
      finalPx > midPx,
      `stale -x intent dropped, +x motion continued: ${midPx} -> ${finalPx}`,
    );
    await client.close();
  });
});

describe("gateway: untrusted input", () => {
  const avatars = defineQuery([C.PlayerIntent]);
  const avatarCount = (): number => avatars(gw!.world.ecs).length;
  const tokenHello = (token: string): Uint8Array =>
    encodeControl({ protocol: PROTOCOL_VERSION, client: "x", want_snapshot: true, token });

  it("refuses a second hello on a joined connection (no extra avatar)", async () => {
    const url = await startGateway();
    const { client, sessionToken } = await connectHello(url, "alice", creds("alice"));
    assert.equal(avatarCount(), 1);
    const errP = client.waitFor(MessageType.Error, 3);
    for (let i = 0; i < 3; i++) client.sendRaw(MessageType.Hello, tokenHello(sessionToken));
    const errs = (await errP).map((p) => decodeControl<ErrorMessage>(p));
    assert.deepEqual(errs.map((e) => [e.code, e.message]), Array(3).fill([4003, "already joined"]));
    frames(1);
    assert.equal(avatarCount(), 1, "still one avatar for one client");
    await client.close();
  });

  it("refuses hellos pipelined behind one still being checked", async () => {
    const url = await startGateway();
    const client = new HeadlessClient();
    await client.connect(url);
    const hello = encodeControl({
      protocol: PROTOCOL_VERSION, client: "x", want_snapshot: true,
      username: "alice", password: TEST_PASSWORD,
    });
    const welcomeP = client.waitFor(MessageType.Welcome, 1);
    const errP = client.waitFor(MessageType.Error, 2);
    for (let i = 0; i < 3; i++) client.sendRaw(MessageType.Hello, hello);
    await welcomeP;
    const errs = (await errP).map((p) => decodeControl<ErrorMessage>(p));
    assert.deepEqual(errs.map((e) => e.message), ["join already in progress", "join already in progress"]);
    assert.equal(avatarCount(), 1);
    await client.close();
  });

  it("rejects non-finite intents; the sim keeps running", async () => {
    const url = await startGateway();
    const { client, entity } = await connectHello(url, "alice", creds("alice"));
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendIntent(1n, entity, move(Number.NaN, 0, 0));
    const [err] = (await errP).map((p) => decodeControl<ErrorMessage>(p));
    assert.deepEqual([err.code, err.message], [4003, "malformed intent"]);
    frames(5);
    const eid = Number(entity & 0xffffffffn);
    assert.ok(Number.isFinite(C.Transform.px[eid]), `px ${C.Transform.px[eid]}`);
    await client.close();
  });

  it("caps the move vector: no faster than PLAYER_SPEED", async () => {
    const url = await startGateway();
    const { client, entity } = await connectHello(url, "alice", creds("alice"));
    const eid = Number(entity & 0xffffffffn);
    client.sendIntent(1n, entity, move(1000, 0, 1000));
    await settle();
    const x0 = C.Transform.px[eid];
    const z0 = C.Transform.pz[eid];
    frames(30); // one second
    const moved = Math.hypot(C.Transform.px[eid] - x0, C.Transform.pz[eid] - z0);
    assert.ok(Math.abs(moved - PLAYER_SPEED) < 0.01, `moved ${moved} m in 1 s`);
    await client.close();
  });

  // Memory-exhaustion guard: `ws` buffers a whole frame before any handler
  // runs, and its own default cap is 100 MiB — so without a limit one
  // unauthenticated peer could spend ~99 MiB of server memory per
  // connection. The cap is enforced by WebSocketServer maxPayload: `ws`
  // sees the declared frame length and closes the connection (1009)
  // *without* allocating the payload, so onMessage never even runs.
  it("closes a connection that sends a frame over the payload cap", async () => {
    const cap = 1024;
    const url = await startGateway({ maxClientPayloadBytes: cap });
    const client = new HeadlessClient();
    client.autoPong = false;
    await client.connect(url);

    // A "type" byte plus an oversized body.
    client.sendRaw(MessageType.Hello, new Uint8Array(cap + 1));

    const deadline = Date.now() + 3000;
    while (!client.closed && Date.now() < deadline) await sleep(10);
    assert.ok(client.closed, "the oversized frame must close the connection");
    assert.equal(client.closeCode, 1009, "ws close code: message too big");
    await client.close();
  });

  it("keeps serving other clients after an oversized frame arrives", async () => {
    const cap = 1024;
    const url = await startGateway({ maxClientPayloadBytes: cap });

    const attacker = new HeadlessClient();
    attacker.autoPong = false;
    await attacker.connect(url);
    attacker.sendRaw(MessageType.Hello, new Uint8Array(cap + 1));
    // Let the server act on it before the next client connects.
    await settle();

    // The authority must be unaffected: a normal client still connects and
    // is still answered. A ping→pong needs no tick, so this measures the
    // server's health rather than the frame loop's.
    const client = new HeadlessClient();
    await client.connect(url);
    const pongP = client.waitFor(MessageType.Pong, 1);
    client.sendPing();
    assert.equal((await pongP).length, 1, "the good client is still served");
    assert.ok(!client.closed, "and its connection stays open");

    assert.ok(attacker.closed, "the attacker's connection is gone");
    assert.equal(attacker.closeCode, 1009);
    await client.close();
    await attacker.close();
  });

  it("still serves a well-formed frame under the cap", async () => {
    const cap = 4096;
    const url = await startGateway({ maxClientPayloadBytes: cap });
    const client = new HeadlessClient();
    await client.connect(url);
    // Size alone must not be a rejection: a normal hello, comfortably
    // under the cap, still joins.
    const hello = encodeControl({
      protocol: PROTOCOL_VERSION,
      client: "x",
      want_snapshot: true,
      username: "alice",
      password: TEST_PASSWORD,
    });
    assert.ok(hello.length < cap, `hello is ${hello.length} bytes, cap ${cap}`);
    client.sendRaw(MessageType.Hello, hello);
    const [welcome] = await client.waitFor(MessageType.Welcome, 1);
    assert.ok(welcome.length > 0, "a frame under the cap is still served");
    await client.close();
  });

  it("rejects a nonsense payload cap instead of silently accepting one", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => new Gateway({ maxClientPayloadBytes: bad }),
        RangeError,
        `maxClientPayloadBytes=${bad} must throw`,
      );
    }
  });
});

describe("gateway: reconnect and sessions", () => {
  it("re-attaches the same player entity inside the grace period", async () => {
    const url = await startGateway();
    const first = await connectHello(url, "alice", creds("alice"));
    const e1 = first.entity;
    await first.client.close();
    await sleep(50); // let the server observe the close

    now += 500; // inside the 1000 ms grace period
    const second = await connectHello(url, "alice", { token: first.sessionToken });
    assert.equal(
      second.entity,
      e1,
      "same token inside grace -> same player entity",
    );
    assert(
      second.snapshot.transforms.some((r) => r.wireId === e1),
      "re-attached client gets a fresh snapshot containing its entity",
    );
    await second.client.close();
  });

  it("spawns a fresh entity after the grace period expires", async () => {
    const url = await startGateway();
    const first = await connectHello(url, "alice", creds("alice"));
    const e1 = first.entity;
    await first.client.close();
    await sleep(50);

    now += 2000; // past the 1000 ms grace period
    frames(2); // sweep runs on tick: entity despawned, session deleted
    assert.equal(gw!.clientCount(), 0, "expired session swept");

    const second = await connectHello(url, "alice", { token: first.sessionToken });
    assert.notEqual(second.entity, e1, "new token session -> new entity");
    const rows = second.snapshot.transforms;
    assert(!rows.some((r) => r.wireId === e1), "old entity is gone");
    assert(rows.some((r) => r.wireId === second.entity), "new entity present");
    await second.client.close();
  });

  it("a live same-token connection takes over (last connection wins)", async () => {
    const url = await startGateway();
    const first = await connectHello(url, "alice", creds("alice"));
    const e1 = first.entity;

    // Same session token while the first socket is still live.
    const second = await connectHello(url, "alice", { token: first.sessionToken });
    assert.equal(second.entity, e1, "takeover keeps the player entity");
    await first.client.waitForClose(5000);
    assert(first.client.closed, "old socket was superseded");

    // The new socket drives the entity.
    const px0 = second.snapshot.transforms.find((r) => r.wireId === e1)!.px;
    second.client.sendIntent(1n, e1, move(1, 0, 0));
    await settle();
    const deltasP = second.client.waitFor(MessageType.Delta, 5);
    frames(5);
    const deltas = await deltasP;
    const row = decodeDelta(deltas[deltas.length - 1]).transforms.find(
      (r) => r.wireId === e1,
    )!;
    assert(row.px > px0, "takeover socket controls the player");
    await second.client.close();
  });

  it("drops silent clients after missed heartbeats, then sweeps them", async () => {
    const url = await startGateway({
      heartbeatIntervalMs: 100,
      maxMissedHeartbeats: 3,
    });
    const zombie = new HeadlessClient();
    zombie.autoPong = false; // never answers pings
    await zombie.connect(url);
    const snapP = zombie.waitFor(MessageType.Snapshot, 1);
    await zombie.hello("zombie", creds("zombie"));
    await snapP;
    assert.equal(gw!.clientCount(), 1);

    for (let i = 0; i < 6; i++) {
      now += 100;
      frames(1);
      await sleep(10);
    }
    await zombie.waitForClose(5000);
    assert(zombie.closed, "server dropped the silent client");
    assert.equal(gw!.clientCount(), 1, "session parked in grace period");

    now += 1500; // past grace
    frames(2);
    assert.equal(gw!.clientCount(), 0, "grace-expired session swept");
  });

  it("keeps idle clients that answer pings, even with tick-clock jitter", async () => {
    // Regression: "missed" used to mean "silent for > interval". An idle
    // client's only traffic is the pong right after each ping, and the
    // heartbeat runs on the tick clock a little past the interval, so the
    // gap was just over it every time — healthy idle players were kicked
    // after 3 rounds (~20 s in production).
    const url = await startGateway({
      heartbeatIntervalMs: 100,
      maxMissedHeartbeats: 3,
    });
    const idle = new HeadlessClient(); // autoPong: answers every ping, sends nothing else
    await idle.connect(url);
    const snapP = idle.waitFor(MessageType.Snapshot, 1);
    await idle.hello("idle", creds("idle"));
    await snapP;

    for (let i = 0; i < 12; i++) {
      now += 103; // heartbeat fires a few ms late, like 30 Hz ticks do
      frames(1);
      await sleep(10); // let the pong arrive
    }
    assert.equal(idle.closed, false, "an idle client that answers pings stays connected");
    await idle.close();
  });

  it("rejects hellos with a protocol mismatch or malformed auth", async () => {
    const url = await startGateway();

    const bad1 = new HeadlessClient();
    await bad1.connect(url);
    await assert.rejects(
      bad1.hello("x", creds("alice"), 999),
      /4001/,
      "protocol mismatch",
    );
    await bad1.waitForClose(5000);

    const bad2 = new HeadlessClient();
    await bad2.connect(url);
    // Empty token matches neither hello variant -> malformed (4003, no close).
    await assert.rejects(bad2.hello("x", { token: "" }), /4003/);
    await bad2.close();

    const bad3 = new HeadlessClient();
    await bad3.connect(url);
    // Wrong password -> auth failed (4002) and the connection is closed.
    await assert.rejects(
      bad3.hello("x", { username: "alice", password: "wrong-password" }),
      /4002/,
    );
    await bad3.waitForClose(5000);

    assert.equal(gw!.clientCount(), 0, "rejected clients leave no sessions");
  });
});
