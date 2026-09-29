/**
 * Gateway characters (protocol v5): account → create_character →
 * enter_world, the Appearance on the wire, refusals, legacy joins, one
 * character in the world at a time, and re-entering on reconnect.
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
  type WelcomeMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { decodeDelta, decodeSnapshot } from "../../src/snapshot.js";
import { DEFAULT_LOOK_JSON, MemoryCharacterStore } from "../../src/index.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const decodeAccount = (p: Uint8Array): AccountMessage => decodeControl<AccountMessage>(p);

/** Log in asking to choose a character; resolve with the account message. */
async function loginChoosing(c: HeadlessClient, username: string, auth?: { token: string }): Promise<AccountMessage> {
  const hello: HelloMessage = {
    protocol: PROTOCOL_VERSION,
    client: "test",
    want_snapshot: true,
    characters: true,
    ...(auth ?? { username, password: TEST_PASSWORD }),
  };
  const account = c.waitFor(MessageType.Account, 1);
  c.sendRaw(MessageType.Hello, encodeControl(hello));
  return decodeAccount((await account)[0]);
}

async function create(c: HeadlessClient, msg: CreateCharacterMessage): Promise<AccountMessage> {
  const account = c.waitFor(MessageType.Account, 1);
  c.sendRaw(MessageType.CreateCharacter, encodeControl(msg));
  return decodeAccount((await account)[0]);
}

/** Send a message and resolve with the error it earns. */
async function refused(c: HeadlessClient, type: MessageType, payload: unknown): Promise<{ code: number; message: string }> {
  const err = c.waitFor(MessageType.Error, 1);
  c.sendRaw(type, encodeControl(payload));
  return decodeControl<{ code: number; message: string }>((await err)[0]);
}

async function enter(c: HeadlessClient, character: number): Promise<{ welcome: WelcomeMessage; look: string | undefined }> {
  const snapshot = c.waitFor(MessageType.Snapshot, 1);
  c.sendRaw(MessageType.EnterWorld, encodeControl({ character }));
  const snap = decodeSnapshot((await snapshot)[0]);
  const welcome = c.welcome!;
  const me = BigInt(welcome.player_entity);
  return { welcome, look: snap.appearances.find((a) => a.wireId === me)?.look };
}

const HEAD_LOOK = {
  gender: "female",
  parts: { head: "Chr_Head_Female_04", hair: "Chr_Hair_12", eyebrows: "Chr_Eyebrow_Female_02" },
  colours: { skin: "#6E4225", hair: "#0f0d0c" },
};

describe("gateway characters", () => {
  it("account → create → enter: the avatar wears the character's look", async () => {
    const { url } = await startGateway();
    const c = await connect(url);
    const first = await loginChoosing(c, "alice");
    assert.deepEqual(first.characters, []);
    assert.equal(first.max_characters, 8);
    assert.match(first.session_token, /^[0-9a-f]{64}$/);
    assert.equal(c.welcome, null, "not in the world yet");

    const account = await create(c, { name: "Arya", look: HEAD_LOOK });
    assert.equal(account.characters.length, 1);
    const arya = account.characters[0];
    assert.equal(account.created, arya.id);
    assert.equal(arya.name, "Arya");
    assert.deepEqual(arya.look, {
      gender: "female",
      parts: { head: "Chr_Head_Female_04", hair: "Chr_Hair_12", eyebrows: "Chr_Eyebrow_Female_02" },
      colours: { skin: "#6e4225", hair: "#0f0d0c" },
    });

    const { welcome, look } = await enter(c, arya.id);
    assert.deepEqual(welcome.character, { id: arya.id, name: "Arya" });
    assert.deepEqual(JSON.parse(look!), arya.look);

    // In the world: no more creating or entering.
    assert.equal((await refused(c, MessageType.CreateCharacter, { name: "Sansa", look: HEAD_LOOK })).code, 4003);
    assert.equal((await refused(c, MessageType.EnterWorld, { character: arya.id })).code, 4003);
  });

  it("refusals keep the connection open", async () => {
    const { url } = await startGateway({ maxCharacters: 2 });
    const bob = await connect(url);
    await loginChoosing(bob, "user-b");
    await create(bob, { name: "Hodor", look: { gender: "male", parts: {}, colours: {} } });

    const c = await connect(url);
    await loginChoosing(c, "alice");
    const taken = await refused(c, MessageType.CreateCharacter, { name: "HODOR", look: HEAD_LOOK });
    assert.deepEqual(taken, { code: 4005, message: "that name is taken" });
    const armour = await refused(c, MessageType.CreateCharacter, {
      name: "Brienne",
      look: { gender: "female", parts: { torso: "Chr_Torso_Female_09" }, colours: {} },
    });
    assert.equal(armour.code, 4005);
    assert.match(armour.message, /starter armour/);
    assert.equal((await refused(c, MessageType.CreateCharacter, { name: "No Spaces", look: HEAD_LOOK })).code, 4003);
    assert.equal((await refused(c, MessageType.CreateCharacter, { name: "Extra", look: HEAD_LOOK, admin: true })).code, 4003);
    assert.equal((await refused(c, MessageType.EnterWorld, { character: 1 })).message, "no such character", "someone else's");

    await create(c, { name: "Brienne", look: HEAD_LOOK });
    await create(c, { name: "Podrick", look: HEAD_LOOK });
    const full = await refused(c, MessageType.CreateCharacter, { name: "Jaime", look: HEAD_LOOK });
    assert.equal(full.code, 4005);
    assert.match(full.message, /all the characters/);
    assert.equal(c.closed, false);
  });

  it("a login that doesn't choose joins as the first character, or with the default look", async () => {
    const characterStore = new MemoryCharacterStore();
    const { url } = await startGateway({ characterStore });
    const fresh = await connect(url);
    const w = await fresh.hello("editor", { username: "user-c", password: TEST_PASSWORD });
    assert.equal(w.character, undefined);

    const record = await characterStore.create("alice", "Gendry", '{"gender":"male","parts":{"head":"Chr_Head_Male_03"},"colours":{}}', 8);
    const c = await connect(url);
    const snapshot = c.waitFor(MessageType.Snapshot, 1);
    const welcome = await c.hello("editor", { username: "alice", password: TEST_PASSWORD });
    assert.deepEqual(welcome.character, { id: record.id, name: "Gendry" });
    const s = decodeSnapshot((await snapshot)[0]);
    const byId = new Map(s.appearances.map((a) => [a.wireId, a.look]));
    assert.equal(byId.get(BigInt(welcome.player_entity)), record.look);
    assert.equal(byId.get(BigInt(w.player_entity)), DEFAULT_LOOK_JSON, "the character-less player");
  });

  it("a character is in the world once: entering again takes it over", async () => {
    const { url, gw } = await startGateway();
    const a = await connect(url);
    await loginChoosing(a, "alice");
    const acc = await create(a, { name: "Arya", look: HEAD_LOOK });
    const first = await enter(a, acc.characters[0].id);

    const b = await connect(url);
    await loginChoosing(b, "alice");
    const kicked = a.waitFor(MessageType.Error, 1);
    const second = await enter(b, acc.characters[0].id);
    assert.equal(decodeControl<{ code: number }>((await kicked)[0]).code, 4005);
    await a.waitForClose();
    assert.notEqual(second.welcome.player_entity, first.welcome.player_entity);

    // The first avatar is gone from the world; the next delta says so.
    const delta = b.waitFor(MessageType.Delta, 1);
    now += 34;
    gw.frame(now);
    const d = decodeDelta((await delta)[0]);
    assert.deepEqual(d.despawned, [BigInt(first.welcome.player_entity)]);
    assert.equal(gw.world.liveEntityCount, 1);
  });

  it("a reconnect after the grace period re-enters as the same character", async () => {
    const { url, gw } = await startGateway();
    const c = await connect(url);
    await loginChoosing(c, "alice");
    const acc = await create(c, { name: "Arya", look: HEAD_LOOK });
    const { welcome } = await enter(c, acc.characters[0].id);
    await c.close();
    await sleep(50);
    now += 2000; // past the 1 s grace period: the avatar is despawned
    gw.frame(now);
    assert.equal(gw.world.liveEntityCount, 0);

    const again = await connect(url);
    const snapshot = again.waitFor(MessageType.Snapshot, 1);
    again.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "test", want_snapshot: true, characters: true, token: welcome.session_token }),
    );
    const snap = decodeSnapshot((await snapshot)[0]);
    const w = again.welcome!;
    assert.deepEqual(w.character, { id: acc.characters[0].id, name: "Arya" });
    assert.deepEqual(JSON.parse(snap.appearances.find((a) => a.wireId === BigInt(w.player_entity))!.look), acc.characters[0].look);
  });
});
