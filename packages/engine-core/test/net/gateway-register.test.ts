/**
 * Gateway 0x0b register (in-client account creation).
 *
 * - register with a fresh username → welcome + snapshot, same join
 *   semantics as a credentials hello (player entity spawns, session
 *   token issued); the new credentials then pass a normal hello login.
 * - duplicate username → 4002 "username is taken", connection closed.
 * - malformed payload (bad shape / short password) → 4003.
 * - protocol mismatch → 4001.
 * - allowRegister: false → 4002 "registration disabled".
 * - failed attempts consume the per-IP auth budget (rate-limited).
 *
 * Race discipline (same as gateway.test.ts): the snapshot waiter is
 * armed BEFORE the register goes out — the server sends it on the same
 * processing step as the welcome.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  PROTOCOL_VERSION,
  type ErrorMessage,
  type RegisterMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { decodeSnapshot } from "../../src/snapshot.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let now = 0;
const gateways: Gateway[] = [];

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  const g = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    ...opts,
  });
  gateways.push(g);
  const port = await g.listen();
  g.frame(now); // prime the loop clock
  return `ws://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (gateways.length > 0) {
    await gateways.pop()!.close();
  }
});

const regPayload = (
  username: string,
  password: string,
  protocol: number = PROTOCOL_VERSION,
): RegisterMessage => ({ protocol, client: "test", username, password });

/** Send register; resolve when the welcome lands, reject on error/close. */
async function registerOk(
  client: HeadlessClient,
  payload: RegisterMessage,
): Promise<void> {
  client.sendRaw(MessageType.Register, encodeControl(payload));
  const deadline = Date.now() + 8000;
  for (;;) {
    if (client.welcome) return;
    if (client.lastError) {
      throw new Error(
        `register rejected: ${client.lastError.code} ${client.lastError.message}`,
      );
    }
    if (client.closed) throw new Error("register: connection closed by server");
    if (Date.now() > deadline) {
      throw new Error("register: timed out waiting for welcome");
    }
    await sleep(10);
  }
}

/** Send register; resolve with the error the server answers with. */
async function registerError(
  client: HeadlessClient,
  payload: RegisterMessage | object,
): Promise<ErrorMessage> {
  const p = client.waitFor(MessageType.Error, 1);
  client.sendRaw(MessageType.Register, encodeControl(payload));
  const [raw] = await p;
  return decodeControl<ErrorMessage>(raw);
}

describe("gateway: 0x0b register", () => {
  it("creates the account and joins like a credentials hello", async () => {
    const url = await startGateway();
    const client = new HeadlessClient();
    await client.connect(url);
    const snapP = client.waitFor(MessageType.Snapshot, 1);
    await registerOk(client, regPayload("newbie", TEST_PASSWORD));

    const welcome = client.welcome!;
    assert.equal(welcome.protocol, PROTOCOL_VERSION);
    assert.match(welcome.session_token, /^[0-9a-f]{64}$/);
    // Wire ID 0 is a valid entity id — just check it parses as a u64.
    const entity = BigInt(welcome.player_entity);
    assert.ok(entity >= 0n && entity < 2n ** 64n, "player entity spawned");
    const [snapPayload] = await snapP;
    const snap = decodeSnapshot(snapPayload);
    // Fresh-join semantics: the snapshot baselines the new player entity.
    assert.ok(
      snap.spawned.includes(BigInt(welcome.player_entity)),
      "fresh snapshot carries the spawned player",
    );

    // The minted credentials pass a normal hello login on a new connection.
    const login = new HeadlessClient();
    await login.connect(url);
    const w2 = await login.hello("newbie", {
      username: "newbie",
      password: TEST_PASSWORD,
    });
    assert.match(w2.session_token, /^[0-9a-f]{64}$/);
  });

  it("rejects a duplicate username with 4002 and closes", async () => {
    const url = await startGateway();
    const client = new HeadlessClient();
    await client.connect(url);
    // "alice" is pre-seeded by the auth harness.
    const err = await registerError(client, regPayload("alice", TEST_PASSWORD));
    assert.equal(err.code, 4002);
    assert.match(err.message, /username is taken/);
    const deadline = Date.now() + 5000;
    while (!client.closed && Date.now() < deadline) await sleep(10);
    assert.ok(client.closed, "server closes after failed register");
  });

  it("rejects malformed payloads with 4003", async () => {
    const url = await startGateway();
    const bad: object[] = [
      { protocol: PROTOCOL_VERSION, client: "test", username: "newbie" }, // no password
      { protocol: PROTOCOL_VERSION, client: "test", username: "x", password: TEST_PASSWORD }, // bad username
      { protocol: PROTOCOL_VERSION, client: "test", username: "newbie", password: "short" }, // short password
      { protocol: PROTOCOL_VERSION, client: "test", username: "newbie", password: TEST_PASSWORD, extra: 1 }, // strict()
    ];
    for (const payload of bad) {
      const client = new HeadlessClient();
      await client.connect(url);
      const err = await registerError(client, payload);
      assert.equal(err.code, 4003, `payload ${JSON.stringify(payload)}`);
      await client.close();
    }
  });

  it("rejects a protocol mismatch with 4001", async () => {
    const url = await startGateway();
    const client = new HeadlessClient();
    await client.connect(url);
    const err = await registerError(
      client,
      regPayload("newbie", TEST_PASSWORD, 999),
    );
    assert.equal(err.code, 4001);
    assert.match(err.message, /protocol mismatch/);
  });

  it("refuses registration when allowRegister is false", async () => {
    const url = await startGateway({ allowRegister: false });
    const client = new HeadlessClient();
    await client.connect(url);
    const err = await registerError(client, regPayload("newbie", TEST_PASSWORD));
    assert.equal(err.code, 4002);
    assert.match(err.message, /registration disabled/);
  });

  it("failed registrations consume the per-IP auth budget", async () => {
    const url = await startGateway({
      authRateLimit: { maxFailures: 2, windowMs: 60_000 },
    });
    // Two failures on the pre-seeded "alice"...
    for (let i = 0; i < 2; i++) {
      const c = new HeadlessClient();
      await c.connect(url);
      const err = await registerError(c, regPayload("alice", TEST_PASSWORD));
      assert.equal(err.code, 4002);
    }
    // ...then even a fresh username is rate-limited.
    const c = new HeadlessClient();
    await c.connect(url);
    const err = await registerError(c, regPayload("freshuser", TEST_PASSWORD));
    assert.equal(err.code, 4002);
    assert.match(err.message, /too many attempts/);
  });
});
