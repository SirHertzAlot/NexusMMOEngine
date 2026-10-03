/**
 * Friends and blocks survive a gateway restart (roadmap S2c): the same
 * SocialStore handed to a fresh Gateway brings back the friends list on
 * login and keeps a blocked sender's whispers answered "not online".
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeControl, encodeControl, MessageType, type ChatBroadcast, type FriendsState } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { NOT_ONLINE } from "../../src/chat.js";
import { SqliteSocialStore } from "../../src/social-store.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;
let dir = "";

async function start(store: SqliteSocialStore): Promise<string> {
  now = 1_000_000;
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    socialStore: store,
  });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

async function join(url: string, username: string): Promise<HeadlessClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  await client.hello(username, { username, password: TEST_PASSWORD });
  await snapP;
  return client;
}

type Control = { kind?: string };
const chats = (c: HeadlessClient): Array<Control & Record<string, unknown>> =>
  c.payloads(MessageType.Chat).map((p) => decodeControl<Control & Record<string, unknown>>(p));
const lastFriends = (c: HeadlessClient): FriendsState | undefined =>
  chats(c).filter((m) => m.kind === "friends").at(-1) as FriendsState | undefined;

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "condition not met in time");
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("gateway: friends and blocks persist", () => {
  it("brings back the friends list and blocks after a restart", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-gw-"));
    const file = path.join(dir, "social.db");

    let store = new SqliteSocialStore(file);
    let url = await start(store);
    let a = await join(url, "alice");
    let b = await join(url, "user-a");
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "friend", name: "user-a", on: true }));
    b.sendRaw(MessageType.Chat, encodeControl({ kind: "block", name: "alice", on: true }));
    await until(() => (lastFriends(a)?.friends.length ?? 0) === 1);
    await until(() => chats(b).some((m) => m.text === "blocked alice"));
    await a.close();
    await b.close();
    await gw!.close();
    gw = null;
    store.close();

    store = new SqliteSocialStore(file);
    url = await start(store);
    b = await join(url, "user-a");
    a = await join(url, "alice");
    // user-a blocks alice, so alice sees her friend as offline.
    await until(() => lastFriends(a) !== undefined);
    assert.deepEqual(lastFriends(a)!.friends, [{ name: "user-a", online: false }]);
    const p = a.waitFor(MessageType.Chat, 1);
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "whisper", text: "hi", to: "user-a" }));
    const r = decodeControl<ChatBroadcast>((await p)[0]);
    assert.equal(r.channel, "system");
    assert.equal(r.text, NOT_ONLINE);
    await a.close();
    await b.close();
    await gw!.close();
    gw = null;
    store.close();
  });
});
