/** Party ops and party chat over the wire (roadmap S3, 0x11 kind:"party"). */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type ChatBroadcast, type PartyState } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { NOT_ONLINE } from "../../src/chat.js";
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

async function join(url: string, username: string): Promise<HeadlessClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  await client.hello(username, { username, password: TEST_PASSWORD });
  await snapP;
  return client;
}

const op = (c: HeadlessClient, o: string, name?: string): void =>
  c.sendRaw(MessageType.Chat, encodeControl({ kind: "party", op: o, ...(name ? { name } : {}) }));

type Msg = Partial<PartyState> & Partial<ChatBroadcast>;
const all = (c: HeadlessClient): Msg[] => c.payloads(MessageType.Chat).map((f) => decodeControl<Msg>(f));

/** Polls until the latest message of `kind` ("party" state or a chat line) satisfies `pred`. */
async function latest(c: HeadlessClient, isParty: boolean, pred: (m: Msg) => boolean, ms = 2000): Promise<Msg> {
  const end = Date.now() + ms;
  for (;;) {
    const mine = all(c).filter((m) => (m.kind === "party") === isParty);
    const last = mine[mine.length - 1];
    if (last && pred(last)) return last;
    if (Date.now() > end) throw new Error("timeout waiting for message");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: parties", () => {
  it("invite, accept, then party chat reaches only members", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const c = await join(url, "user-b");
    op(a, "invite", "user-a");
    assert.deepEqual((await latest(b, true, (m) => m.invite !== undefined)).invite, { from: "alice" });
    op(b, "accept");
    const st = await latest(a, true, (m) => m.members?.length === 2);
    assert.deepEqual(st.members?.map((m) => [m.name, m.leader]), [["alice", true], ["user-a", false]]);
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "party", text: "hi team" }));
    const got = await latest(b, false, (m) => m.text === "hi team");
    assert.equal(got.channel, "party");
    await sleep(200);
    assert.equal(all(c).some((m) => m.text === "hi team"), false);
  });

  it("inviting an unknown or blocking character says not online; party chat outside a party is refused", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    b.sendRaw(MessageType.Chat, encodeControl({ kind: "block", name: "alice", on: true }));
    await sleep(100);
    op(a, "invite", "nobody");
    await latest(a, false, (m) => m.text === NOT_ONLINE);
    op(a, "invite", "user-a");
    await sleep(100);
    assert.equal(all(b).some((m) => m.kind === "party" && m.invite !== undefined), false);
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "party", text: "anyone?" }));
    await latest(a, false, (m) => m.text === "not in a party");
  });

  it("leaving down to one disbands and tells both", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    op(a, "invite", "user-a");
    await latest(b, true, (m) => m.invite !== undefined);
    op(b, "accept");
    await latest(a, true, (m) => m.members?.length === 2);
    await latest(b, true, (m) => m.members?.length === 2);
    op(b, "leave");
    await latest(b, true, (m) => m.members?.length === 0);
    await latest(a, true, (m) => m.members?.length === 0);
  });
});
