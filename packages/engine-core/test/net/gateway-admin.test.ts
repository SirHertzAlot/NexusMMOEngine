/**
 * Admin console (roadmap A1, protocol 0x10): real Gateway + WebSocket
 * clients. An admin runs help/whoami and lands in the command log; a
 * non-admin, a malformed or unknown command, and a pre-welcome sender
 * are all answered 4003 and logged as rejected.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type AdminResult,
  type ErrorMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

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
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

async function join(url: string, username: string): Promise<HeadlessClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  await client.hello(username, creds(username));
  await snapP;
  return client;
}

async function admin(client: HeadlessClient, command: string): Promise<AdminResult> {
  const resP = client.waitFor(MessageType.Admin, 1);
  client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command }));
  const [payload] = await resP;
  return decodeControl<AdminResult>(payload);
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: admin console", () => {
  it("a named admin runs help and whoami", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = await join(url, "alice");
    const help = await admin(client, "help");
    assert.equal(help.ok, true);
    assert.match(help.message, /whoami/);
    const who = await admin(client, "whoami");
    assert.equal(who.ok, true);
    assert.match(who.message, /alice/);
    const log = gw!.adminLogEntries();
    assert.deepEqual(
      log.map((e) => [e.username, e.command, e.ok]),
      [["alice", "help", true], ["alice", "whoami", true]],
    );
    await client.close();
  });

  it("a non-admin is rejected and logged", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = await join(url, "user-a");
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "whoami" }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    assert.deepEqual(
      gw!.adminLogEntries().map((e) => [e.username, e.command, e.ok]),
      [["user-a", "whoami", false]],
    );
    await client.close();
  });

  it("unknown and malformed commands are rejected", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = await join(url, "alice");
    const errP = client.waitFor(MessageType.Error, 2);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "nuke" }));
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin" }));
    const errs = await errP;
    for (const payload of errs) assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    await client.close();
  });

  it("pre-welcome senders are rejected", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = new HeadlessClient();
    await client.connect(url);
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "whoami" }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    await client.close();
  });

  it("a dev server treats every account as admin", async () => {
    const url = await startGateway({ devServer: true });
    const client = await join(url, "user-b");
    const who = await admin(client, "whoami");
    assert.equal(who.ok, true);
    assert.match(who.message, /dev server/);
    await client.close();
  });
});
