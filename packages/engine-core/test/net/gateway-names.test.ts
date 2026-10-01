/**
 * Character identity (C3): CharacterRef rows ride snapshots/deltas, and
 * the names control message (0x12) arrives before the state that first
 * shows each character entity. Real Gateway + WebSocket clients.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  PROTOCOL_VERSION,
  type AccountMessage,
  type CreateCharacterMessage,
  type HelloMessage,
  type NamesMessage,
  type WelcomeMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { decodeSnapshot } from "../../src/snapshot.js";
import { MemoryCharacterStore } from "../../src/index.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
const gateways: Gateway[] = [];
const clients: HeadlessClient[] = [];

async function startGateway(opts: GatewayOptions = {}): Promise<{ url: string; gw: Gateway }> {
  now = 1_000_000;
  const gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    characterStore: new MemoryCharacterStore(),
    ...opts,
  });
  gateways.push(gw);
  const port = await gw.listen();
  gw.frame(now);
  return { url: `ws://127.0.0.1:${port}`, gw };
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  while (gateways.length > 0) await gateways.pop()!.close();
});

async function connect(url: string): Promise<HeadlessClient> {
  const c = new HeadlessClient();
  clients.push(c);
  await c.connect(url);
  return c;
}

const HEAD_LOOK = {
  gender: "female",
  parts: { head: "Chr_Head_Female_04" },
  colours: { skin: "#6E4225" },
};

async function joinChoosing(url: string, username: string): Promise<{ c: HeadlessClient; account: AccountMessage }> {
  const c = await connect(url);
  const hello: HelloMessage = {
    protocol: PROTOCOL_VERSION,
    client: "test",
    want_snapshot: true,
    characters: true,
    username,
    password: TEST_PASSWORD,
  };
  const account = c.waitFor(MessageType.Account, 1);
  c.sendRaw(MessageType.Hello, encodeControl(hello));
  return { c, account: decodeControl<AccountMessage>((await account)[0]) };
}

describe("gateway: character names", () => {
  it("a joiner's snapshot is preceded by names for every avatar", async () => {
    const { url } = await startGateway();
    const a = await connect(url);
    const snapA = a.waitFor(MessageType.Snapshot, 1);
    a.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "a", want_snapshot: true, username: "alice", password: TEST_PASSWORD }),
    );
    await snapA;
    const b = await connect(url);
    const namesP = b.waitFor(MessageType.Names, 1);
    const snapP = b.waitFor(MessageType.Snapshot, 1);
    b.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "b", want_snapshot: true, username: "user-a", password: TEST_PASSWORD }),
    );
    const names = decodeControl<NamesMessage>((await namesP)[0]);
    await snapP;
    const byName = new Map(names.names.map(([entity, name]) => [name, entity]));
    assert.ok(byName.has("alice"), "first avatar named");
    assert.ok(byName.has("user-a"), "own avatar named");
  });

  it("entering as a character writes its CharacterRef row and name", async () => {
    const { url } = await startGateway();
    const { c, account } = await joinChoosing(url, "alice");
    assert.equal(account.characters.length, 0);
    const createP = c.waitFor(MessageType.Account, 1);
    const msg: CreateCharacterMessage = { name: "Arya", look: HEAD_LOOK };
    c.sendRaw(MessageType.CreateCharacter, encodeControl(msg));
    const created = decodeControl<AccountMessage>((await createP)[0]);
    const id = created.created!;
    const namesP = c.waitFor(MessageType.Names, 1);
    const snapP = c.waitFor(MessageType.Snapshot, 1);
    c.sendRaw(MessageType.EnterWorld, encodeControl({ character: id }));
    const snap = decodeSnapshot((await snapP)[0]);
    const names = decodeControl<NamesMessage>((await namesP)[0]);
    const me = c.welcome!.player_entity;
    assert.deepEqual(
      snap.characterRefs.map((r) => [r.wireId.toString(), r.characterId]),
      [[me, id]],
    );
    assert.deepEqual(names.names, [[me, "Arya", ""]]);
  });

  it("a later joiner's spawn is named to sessions before their delta shows it", async () => {
    const { url, gw } = await startGateway();
    const a = await connect(url);
    const snapA = a.waitFor(MessageType.Snapshot, 1);
    a.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "a", want_snapshot: true, username: "alice", password: TEST_PASSWORD }),
    );
    await snapA;
    // Drain alice's per-tick deltas so the next Chat/Names wait sees only
    // what bob's join produces.
    const namesP = a.waitFor(MessageType.Names, 1);
    const b = await connect(url);
    const snapB = b.waitFor(MessageType.Snapshot, 1);
    b.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "b", want_snapshot: true, username: "user-b", password: TEST_PASSWORD }),
    );
    await snapB;
    // Join processing is async, but deltas only flow on ticks: run some
    // so the delta carrying bob's spawn (preceded by his names) goes out.
    for (let i = 0; i < 3; i++) {
      now += 1000 / 30;
      gw.frame(now);
    }
    const names = decodeControl<NamesMessage>((await namesP)[0]);
    assert.ok(names.names.some(([, name]) => name === "user-b"), "new avatar named before its delta");
    assert.equal(gw.clientCount(), 2);
  });
});
