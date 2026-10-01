/**
 * Region chat (roadmap S1, protocol 0x11): real Gateway + WebSocket
 * clients. Say/emote reach nearby avatars only, yell reaches every
 * welcomed session; malformed, too-frequent, filtered, and out-of-world
 * lines are answered 4003.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  PROTOCOL_VERSION,
  type ChatBroadcast,
  type ErrorMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import * as C from "../../src/components.js";
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

async function join(url: string, username: string): Promise<{ client: HeadlessClient; entity: bigint }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(username, creds(username));
  await snapP;
  return { client, entity: BigInt(welcome.player_entity) };
}

/** Move an avatar (test-only direct write; the sim is idle between frames). */
function teleport(entity: bigint, x: number, z: number): void {
  const eid = gw!.world.resolveWireId(entity);
  assert.ok(eid >= 0);
  C.Transform.px[eid] = x;
  C.Transform.pz[eid] = z;
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: region chat", () => {
  it("say reaches nearby avatars with speaker and text", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const bP = b.client.waitFor(MessageType.Chat, 1);
    clientSend(a.client, "say", "hello nearby");
    const [payload] = await bP;
    const msg = decodeControl<ChatBroadcast>(payload);
    assert.equal(msg.channel, "say");
    assert.equal(msg.text, "hello nearby");
    assert.equal(msg.entity, a.entity.toString());
    assert.ok(msg.from.length > 0);
    await a.client.close();
    await b.client.close();
  });

  it("say skips far avatars; yell reaches them", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    teleport(b.entity, 1000, 1000);
    // Say: arm b's waiter, then prove nothing arrives within a tick run.
    const bSay = b.client.waitFor(MessageType.Chat, 1, 500);
    clientSend(a.client, "say", "can you hear me");
    await assert.rejects(bSay, /timeout/);
    // Yell: the same far avatar hears it.
    const got = await yellHears(a.client, b.client, "loud and clear");
    assert.equal(got.channel, "yell");
    assert.equal(got.text, "loud and clear");
    await a.client.close();
    await b.client.close();
  });

  it("emote behaves like say", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const msg = await sayBoth(a.client, b.client, "emote", "waves");
    assert.equal(msg.channel, "emote");
    assert.equal(msg.text, "waves");
    await a.client.close();
    await b.client.close();
  });

  it("rejects empty, oversize, and unknown channels, and too-frequent lines", async () => {
    const url = await startGateway();
    const { client } = await join(url, "alice");
    const bad: Array<{ channel: string; text: string }> = [
      { channel: "say", text: "   " },
      { channel: "say", text: "x".repeat(501) },
      { channel: "shout", text: "hi" },
    ];
    for (const m of bad) {
      const errP = client.waitFor(MessageType.Error, 1);
      client.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", ...m }));
      const [payload] = await errP;
      assert.equal(decodeControl<ErrorMessage>(payload).code, 4003, JSON.stringify(m.channel));
    }
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "say", text: "one" }));
    // Same synthetic millisecond: the cooldown (2000 ms) rejects the burst.
    client.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "say", text: "two" }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    await client.close();
  });

  it("rejects a custom text filter and out-of-world senders", async () => {
    const url = await startGateway({ textFilter: (t) => !t.includes("banned") });
    const { client } = await join(url, "alice");
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "say", text: "this is banned talk" }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    await client.close();
    await gw!.close();
    gw = null;

    const url2 = await startGateway();
    const choosing = new HeadlessClient();
    await choosing.connect(url2);
    const accP = choosing.waitFor(MessageType.Account, 1);
    choosing.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "c", want_snapshot: true, username: "alice", password: TEST_PASSWORD, characters: true }),
    );
    await accP;
    const errP2 = choosing.waitFor(MessageType.Error, 1);
    choosing.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "say", text: "choosing" }));
    const [payload2] = await errP2;
    assert.equal(decodeControl<ErrorMessage>(payload2).code, 4003);
    await choosing.close();
  });
});

function clientSend(client: HeadlessClient, channel: string, text: string): void {
  client.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel, text }));
}

async function sayBoth(
  a: HeadlessClient,
  b: HeadlessClient,
  channel: string,
  text: string,
): Promise<ChatBroadcast> {
  const resP = b.waitFor(MessageType.Chat, 1);
  clientSend(a, channel, text);
  const [payload] = await resP;
  return decodeControl<ChatBroadcast>(payload);
}

async function yellHears(
  a: HeadlessClient,
  b: HeadlessClient,
  text: string,
): Promise<ChatBroadcast> {
  // Yell cooldown is 10 s; the synthetic clock only advanced a few ticks,
  // so this is the channel's first line — no wait needed.
  return sayBoth(a, b, "yell", text);
}
