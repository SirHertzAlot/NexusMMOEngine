/**
 * The block list (roadmap U8): the server pushes a session its blocks by
 * name on login and after each change, and an offline character can be
 * unblocked from the list.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type BlocksState } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { memorySocialStore, type SocialStore } from "../../src/social-store.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

async function start(store: SocialStore): Promise<string> {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore(), socialStore: store });
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

type Control = { kind?: string; text?: string };
const chats = (c: HeadlessClient): Control[] => c.payloads(MessageType.Chat).map((p) => decodeControl<Control>(p));
const blockStates = (c: HeadlessClient): BlocksState[] => chats(c).filter((m) => m.kind === "blocks") as unknown as BlocksState[];

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "condition not met in time");
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: block list", () => {
  it("pushes the list on login and on every change, and unblocks an offline character by name", async () => {
    const store = memorySocialStore();
    const url = await start(store);
    const a = await join(url, "alice");
    await until(() => blockStates(a).length === 1);
    assert.deepEqual(blockStates(a)[0]!.blocked, []);

    const b = await join(url, "user-a");
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "block", name: "USER-A", on: true }));
    await until(() => blockStates(a).length === 2);
    // Listed under the character's own spelling, not what was typed.
    assert.deepEqual(blockStates(a)[1]!.blocked, ["user-a"]);
    await b.close();

    a.sendRaw(MessageType.Chat, encodeControl({ kind: "block", name: "User-A", on: false }));
    await until(() => blockStates(a).length === 3);
    assert.deepEqual(blockStates(a)[2]!.blocked, []);
    assert.ok(chats(a).some((m) => m.text === "unblocked User-A"));
    assert.deepEqual(store.loadBlocks(), []);
    await a.close();
  });

  it("an unknown name that is neither listed nor online answers not online and pushes nothing", async () => {
    const url = await start(memorySocialStore());
    const a = await join(url, "alice");
    await until(() => blockStates(a).length === 1);
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "block", name: "nobody", on: false }));
    await until(() => chats(a).some((m) => m.text === "not online"));
    assert.equal(blockStates(a).length, 1);
    await a.close();
  });
});
