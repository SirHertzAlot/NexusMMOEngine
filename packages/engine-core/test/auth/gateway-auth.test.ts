/**
 * Auth slice end-to-end tests: real WebSocket clients against a real
 * Gateway with a temp CSV credential store.
 *
 * - register -> login -> welcome (session token) -> snapshot -> deltas
 * - wrong password / unknown user rejected (4002, connection closed)
 * - reconnect with the session token re-attaches the same entity
 * - expired tokens are rejected
 * - the per-IP rate limiter trips after N failures, then recovers
 * - the CSV file is created with mode 0600
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { MessageType, PROTOCOL_VERSION } from "@mmo-engine/protocol";
import {
  Gateway,
  hashPassword,
  type CsvCredentialStore,
  type GatewayOptions,
} from "../../src/index.js";
import { decodeSnapshot } from "../../src/snapshot.js";
import { HeadlessClient } from "../net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "../net/auth-harness.js";

const STEP_MS = 1000 / 30;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let now = 0;
let gw: Gateway | null = null;
let store: CsvCredentialStore | null = null;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  store = await makeCredentialStore();
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: store,
    ...opts,
  });
  const port = await gw.listen();
  gw.frame(now); // prime the loop clock
  return `ws://127.0.0.1:${port}`;
}

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
  store = null;
});

// Windows has no POSIX permission bits (files always read back 0o666);
// owner-only access there comes from the profile directory ACLs.
const POSIX_ONLY = process.platform === "win32" ? "POSIX permissions do not exist on Windows" : false;

describe("auth: gateway end-to-end", () => {
  it("register -> login -> welcome -> snapshot -> deltas", async () => {
    const url = await startGateway();
    await store!.createUser("dave", await hashPassword("dave-password-1"));

    const client = new HeadlessClient();
    await client.connect(url);
    const snapP = client.waitFor(MessageType.Snapshot, 1);
    const welcome = await client.hello("dave", {
      username: "dave",
      password: "dave-password-1",
    });
    assert.equal(welcome.protocol, PROTOCOL_VERSION);
    assert.match(welcome.session_token, /^[0-9a-f]{64}$/);

    const [snapPayload] = await snapP;
    const snapshot = decodeSnapshot(snapPayload);
    const entity = BigInt(welcome.player_entity);
    assert(
      snapshot.transforms.some((r) => r.wireId === entity),
      "player entity present in the welcome snapshot",
    );

    const deltasP = client.waitFor(MessageType.Delta, 5);
    frames(5);
    const deltas = await deltasP;
    assert(deltas.length >= 5, "per-tick deltas flow after login");
    await client.close();
  });

  it("rejects a wrong password (4002) and closes the connection", async () => {
    const url = await startGateway();
    const client = new HeadlessClient();
    await client.connect(url);
    await assert.rejects(
      client.hello("alice", { username: "alice", password: "wrong-password" }),
      /4002/,
    );
    await client.waitForClose(5000);
    assert.equal(gw!.clientCount(), 0, "failed login leaves no session");
  });

  it("rejects an unknown user (4002)", async () => {
    const url = await startGateway();
    const client = new HeadlessClient();
    await client.connect(url);
    await assert.rejects(
      client.hello("ghost", { username: "ghost", password: "some-password" }),
      /4002/,
    );
    await client.waitForClose(5000);
  });

  it("reconnects with the session token inside the grace period", async () => {
    const url = await startGateway();

    const first = new HeadlessClient();
    await first.connect(url);
    const snapP = first.waitFor(MessageType.Snapshot, 1);
    const welcome = await first.hello("alice", {
      username: "alice",
      password: TEST_PASSWORD,
    });
    await snapP;
    const entity = BigInt(welcome.player_entity);
    await first.close();
    await sleep(50);

    now += 500; // inside the 1000 ms grace period
    const second = new HeadlessClient();
    await second.connect(url);
    const snapP2 = second.waitFor(MessageType.Snapshot, 1);
    const welcome2 = await second.hello("alice", {
      token: welcome.session_token,
    });
    assert.equal(
      BigInt(welcome2.player_entity),
      entity,
      "same session token -> same player entity",
    );
    assert.equal(
      welcome2.session_token,
      welcome.session_token,
      "token is stable across the re-attach",
    );
    const [snapPayload] = await snapP2;
    assert(
      decodeSnapshot(snapPayload).transforms.some((r) => r.wireId === entity),
      "re-attached client gets its entity in a fresh snapshot",
    );
    await second.close();
  });

  it("rejects an expired session token (4002)", async () => {
    const url = await startGateway({ sessionTtlMs: 1000 });

    const first = new HeadlessClient();
    await first.connect(url);
    const welcome = await first.hello("alice", {
      username: "alice",
      password: TEST_PASSWORD,
    });
    await first.close();

    now += 2000; // past the 1000 ms token TTL
    frames(1); // heartbeat tick runs the session sweep
    const second = new HeadlessClient();
    await second.connect(url);
    await assert.rejects(
      second.hello("alice", { token: welcome.session_token }),
      /4002/,
      "expired token is rejected",
    );
    await second.waitForClose(5000);
  });

  it("rate-limits failed attempts per IP, then recovers", async () => {
    const url = await startGateway({
      authRateLimit: { maxFailures: 3, windowMs: 60_000 },
    });

    // Three failures consume the budget (each on its own connection,
    // since a failed hello closes the socket).
    for (let i = 0; i < 3; i++) {
      const bad = new HeadlessClient();
      await bad.connect(url);
      await assert.rejects(
        bad.hello("alice", { username: "alice", password: "wrong-password" }),
        /4002/,
      );
      await bad.waitForClose(5000);
    }

    // The next attempt is refused as rate-limited without checking
    // the password (even the RIGHT password is refused here).
    const limited = new HeadlessClient();
    await limited.connect(url);
    await assert.rejects(
      limited.hello("alice", { username: "alice", password: TEST_PASSWORD }),
      /too many attempts/,
    );
    await limited.waitForClose(5000);

    // The window slides: the same correct login succeeds afterwards.
    now += 61_000;
    const ok = new HeadlessClient();
    await ok.connect(url);
    const welcome = await ok.hello("alice", {
      username: "alice",
      password: TEST_PASSWORD,
    });
    assert.match(welcome.session_token, /^[0-9a-f]{64}$/);
    await ok.close();
  });

  it("creates the CSV file with mode 0600", { skip: POSIX_ONLY }, async () => {
    await startGateway();
    const csvPath = store!.path;
    const mode = fs.statSync(csvPath).mode & 0o777;
    assert.equal(mode, 0o600, "credential file must be owner-only");
  });
});
