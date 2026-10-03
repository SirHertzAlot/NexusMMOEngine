/**
 * Whispers and blocks (roadmap S2, protocol 0x11): routed by name, "not
 * online" for unknown or blocking targets (never telling which), and blocks
 * that silence say/yell silently.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type ChatBroadcast } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { BLOCK_LIMIT, BlockList, NOT_ONLINE } from "../../src/chat.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

async function start(): Promise<string> {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore() });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

async function join(url: string, username: string): Promise<{ client: HeadlessClient; name: string }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  await client.hello(username, { username, password: TEST_PASSWORD });
  await snapP;
  return { client, name: username };
}

const whisper = (c: HeadlessClient, to: string, text: string): void =>
  c.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "whisper", text, to }));
const say = (c: HeadlessClient, channel: string, text: string): void =>
  c.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel, text }));
const block = (c: HeadlessClient, name: string, on: boolean): void =>
  c.sendRaw(MessageType.Chat, encodeControl({ kind: "block", name, on }));
const next = async (c: HeadlessClient): Promise<ChatBroadcast> =>
  decodeControl<ChatBroadcast>((await c.waitFor(MessageType.Chat, 1))[0]);

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: whispers and blocks", () => {
  it("a whisper reaches only its target, echoed to the sender", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const c = await join(url, "user-b");
    const bP = next(b.client);
    const aP = next(a.client);
    const cP = c.client.waitFor(MessageType.Chat, 1, 400);
    whisper(a.client, "USER-A", "psst");
    const got = await bP;
    assert.equal(got.channel, "whisper");
    assert.equal(got.text, "psst");
    assert.equal(got.to, "user-a");
    assert.equal((await aP).text, "psst");
    await assert.rejects(cP, /timeout/);
    for (const x of [a, b, c]) await x.client.close();
  });

  it("unknown names and yourself answer 'not online'", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const p = next(a.client);
    whisper(a.client, "nobody", "hi");
    const r = await p;
    assert.equal(r.channel, "system");
    assert.equal(r.text, NOT_ONLINE);
    now += 2000;
    const p2 = next(a.client);
    whisper(a.client, "alice", "me");
    assert.equal((await p2).text, NOT_ONLINE);
    await a.client.close();
  });

  it("a blocked sender gets the same 'not online' and the blocker hears nothing", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const notice = next(b.client);
    block(b.client, "alice", true);
    assert.match((await notice).text, /blocked/);
    const aP = next(a.client);
    const bP = b.client.waitFor(MessageType.Chat, 1, 400);
    whisper(a.client, "user-a", "hello?");
    const r = await aP;
    assert.equal(r.channel, "system");
    assert.equal(r.text, NOT_ONLINE);
    await assert.rejects(bP, /timeout/);
    for (const x of [a, b]) await x.client.close();
  });

  it("blocks silence say and yell, and unblocking restores them", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const n1 = next(b.client);
    block(b.client, "alice", true);
    await n1;
    const quiet = b.client.waitFor(MessageType.Chat, 1, 400);
    say(a.client, "say", "can you hear me");
    await assert.rejects(quiet, /timeout/);
    const n2 = next(b.client);
    block(b.client, "alice", false);
    assert.match((await n2).text, /unblocked/);
    now += 5000;
    const heard = next(b.client);
    say(a.client, "say", "now?");
    assert.equal((await heard).text, "now?");
    for (const x of [a, b]) await x.client.close();
  });

  it("malformed whispers are rejected", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const err = a.client.waitFor(MessageType.Error, 1);
    a.client.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "whisper", text: "no target" }));
    await err;
    await a.client.close();
  });
});

describe("BlockList", () => {
  it("is per account, case-insensitive, limited, and refuses self", () => {
    const l = new BlockList();
    assert.ok(l.add("Bob", "Eve"));
    assert.ok(l.isBlocked("bob", "EVE"));
    assert.ok(!l.isBlocked("eve", "bob"));
    assert.ok(!l.add("bob", "BOB"));
    l.remove("bob", "eve");
    assert.ok(!l.isBlocked("bob", "eve"));
    for (let i = 0; i < BLOCK_LIMIT; i++) assert.ok(l.add("bob", `u${i}`));
    assert.ok(!l.add("bob", "one-more"));
    assert.ok(l.add("bob", "u0"), "re-blocking an existing entry is fine");
  });
});
