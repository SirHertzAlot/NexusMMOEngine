/** Guild ops, guild chat and nameplate tags over the wire (roadmap S4, 0x11 kind:"guild"). */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type ChatBroadcast,
  type GuildState,
  type NamesMessage,
} from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
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

const op = (c: HeadlessClient, o: string, f: Record<string, unknown> = {}): void =>
  c.sendRaw(MessageType.Chat, encodeControl({ kind: "guild", op: o, ...f }));

type Msg = Partial<GuildState> & Partial<ChatBroadcast>;
const all = (c: HeadlessClient): Msg[] => c.payloads(MessageType.Chat).map((f) => decodeControl<Msg>(f));

/** Polls until the latest message of the family (guild state, or a chat line) satisfies `pred`. */
async function latest(c: HeadlessClient, isGuild: boolean, pred: (m: Msg) => boolean, ms = 2000): Promise<Msg> {
  const end = Date.now() + ms;
  for (;;) {
    const mine = all(c).filter((m) => (m.kind === "guild") === isGuild);
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

describe("gateway: guilds", () => {
  it("create, invite, accept, then guild chat reaches only members", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const c = await join(url, "user-b");
    op(a, "create", { name: "Night Owls", tag: "owl" });
    const st = await latest(a, true, (m) => m.name === "Night Owls");
    assert.equal(st.tag, "OWL");
    assert.equal(st.rank, "leader");
    op(a, "invite", { name: "user-a" });
    const inv = await latest(b, true, (m) => m.invite !== undefined);
    assert.equal(inv.invite?.guild, "Night Owls");
    op(b, "accept");
    const two = await latest(a, true, (m) => m.members?.length === 2);
    assert.deepEqual(two.members?.map((m) => [m.name, m.rank, m.online]), [
      ["alice", "leader", true],
      ["user-a", "recruit", true],
    ]);
    assert.ok(two.log && two.log.length > 0, "leader sees the log");
    const joined = await latest(b, true, (m) => m.rank === "recruit");
    assert.deepEqual(joined.log, [], "recruit sees no log");
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "guild", text: "hi guild" }));
    const got = await latest(b, false, (m) => m.text === "hi guild");
    assert.equal(got.channel, "guild");
    await sleep(200);
    assert.equal(all(c).some((m) => m.text === "hi guild"), false);
  });

  it("guild chat and invites outside the rules are refused", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    a.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "guild", text: "anyone?" }));
    await latest(a, false, (m) => m.text === "not in a guild");
    op(a, "invite", { name: "user-a" });
    await latest(a, false, (m) => m.text === "not in a guild");
    op(a, "create", { name: "Owls", tag: "OWL" });
    await latest(a, true, (m) => m.name === "Owls");
    op(a, "invite", { name: "nobody" });
    await latest(a, false, (m) => m.text === "not online");
    b.sendRaw(MessageType.Chat, encodeControl({ kind: "block", name: "alice", on: true }));
    await sleep(100);
    op(a, "invite", { name: "user-a" });
    await sleep(100);
    assert.equal(all(b).some((m) => m.kind === "guild" && m.invite !== undefined), false);
  });

  it("a malformed guild op is rejected", async () => {
    const url = await start();
    const a = await join(url, "alice");
    op(a, "create", { name: "Owls" });
    await sleep(150);
    assert.equal(all(a).some((m) => m.kind === "guild" && m.name === "Owls"), false);
  });

  it("the tag rides the names rows, and MOTD and rank changes reach members", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    const namesP = b.waitFor(MessageType.Names, 1);
    op(a, "create", { name: "Owls", tag: "OWL" });
    const rows = decodeControl<NamesMessage>((await namesP)[0]).names;
    assert.ok(rows.some(([, name, tag]) => name === "alice" && tag === "OWL"));
    op(a, "invite", { name: "user-a" });
    await latest(b, true, (m) => m.invite !== undefined);
    op(b, "accept");
    await latest(a, true, (m) => m.members?.length === 2);
    op(a, "motd", { text: "raid at 8" });
    await latest(b, true, (m) => m.motd === "raid at 8");
    op(a, "setRank", { name: "user-a", rank: "officer" });
    await latest(b, true, (m) => m.rank === "officer");
  });

  it("leaving hands leadership on and tells the leaver", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-a");
    op(a, "create", { name: "Owls", tag: "OWL" });
    op(a, "invite", { name: "user-a" });
    await latest(b, true, (m) => m.invite !== undefined);
    op(b, "accept");
    await latest(a, true, (m) => m.members?.length === 2);
    op(a, "leave");
    await latest(a, true, (m) => m.name === "");
    const rest = await latest(b, true, (m) => m.members?.length === 1);
    assert.equal(rest.rank, "leader");
  });
});
