/**
 * Character save (roadmap P2b): position and vitals are saved on the save
 * timer, on leaving and on shutdown, and restored when the character
 * enters the world again. A character saved dead gets the ordinary spawn.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, PROTOCOL_VERSION, type AccountMessage } from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { MemoryCharacterStore } from "../../src/index.js";
import * as C from "../../src/components.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let now = 0;
const gateways: Gateway[] = [];
const clients: HeadlessClient[] = [];

async function startGateway(opts: GatewayOptions = {}): Promise<{ url: string; gw: Gateway; store: MemoryCharacterStore }> {
  now = 1_000_000;
  const store = new MemoryCharacterStore();
  const gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    characterStore: store,
    ...opts,
  });
  gateways.push(gw);
  const port = await gw.listen();
  gw.frame(now);
  return { url: `ws://127.0.0.1:${port}`, gw, store };
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

const LOOK = { gender: "female", parts: {}, colours: {} };

/** Log in, create a character, enter the world; resolve with the client and the avatar's entity. */
async function join(url: string, gw: Gateway, name: string): Promise<{ c: HeadlessClient; id: number; eid: number }> {
  const c = await connect(url);
  const acct = c.waitFor(MessageType.Account, 1);
  c.sendRaw(
    MessageType.Hello,
    encodeControl({ protocol: PROTOCOL_VERSION, client: "test", want_snapshot: true, characters: true, username: "alice", password: TEST_PASSWORD }),
  );
  await acct;
  const made = c.waitFor(MessageType.Account, 1);
  c.sendRaw(MessageType.CreateCharacter, encodeControl({ name, look: LOOK }));
  const id = decodeControl<AccountMessage>((await made)[0]).characters[0].id;
  return { c, id, eid: await enterAs(c, gw, id) };
}

async function enterAs(c: HeadlessClient, gw: Gateway, id: number): Promise<number> {
  const snapshot = c.waitFor(MessageType.Snapshot, 1);
  c.sendRaw(MessageType.EnterWorld, encodeControl({ character: id }));
  await snapshot;
  return gw.world.resolveWireId(BigInt(c.welcome!.player_entity));
}

/** Leave and let the grace period expire, so the avatar is despawned. */
async function leave(c: HeadlessClient, gw: Gateway): Promise<void> {
  await c.close();
  await sleep(50);
  now += 2000;
  gw.frame(now);
  assert.equal(gw.world.liveEntityCount, 0);
}

describe("character save", () => {
  it("restores where the character was and how it was", async () => {
    const { url, gw, store } = await startGateway();
    const { c, id, eid } = await join(url, gw, "Arya");
    C.Transform.px[eid] = 12;
    C.Transform.pz[eid] = -7;
    C.Health.current[eid] = 31;
    C.Stamina.current[eid] = 17;
    assert.equal(gw.saveCharacters(), 1);
    const saved = store.loadState(id)!;
    assert.equal(saved.x, 12);
    assert.equal(saved.z, -7);
    assert.equal(saved.health, 31);
    assert.equal(saved.stamina, 17);

    await leave(c, gw);
    const again = await connect(url);
    const acct = again.waitFor(MessageType.Account, 1);
    again.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "test", want_snapshot: true, characters: true, username: "alice", password: TEST_PASSWORD }),
    );
    await acct;
    const eid2 = await enterAs(again, gw, id);
    assert.equal(C.Transform.px[eid2], 12);
    assert.equal(C.Transform.pz[eid2], -7);
    assert.equal(C.Health.current[eid2], 31);
    assert.equal(C.Stamina.current[eid2], 17);
  });

  it("saves on leaving even without a timer save", async () => {
    const { url, gw, store } = await startGateway();
    const { c, id, eid } = await join(url, gw, "Arya");
    C.Transform.px[eid] = 5;
    await leave(c, gw);
    assert.equal(store.loadState(id)?.x, 5);
  });

  it("a character saved dead spawns normally", async () => {
    const { url, gw, store } = await startGateway();
    const { c, id } = await join(url, gw, "Arya");
    await leave(c, gw);
    store.saveState(id, { x: 99, y: 0, z: 99, health: 0, stamina: 0 });
    const again = await connect(url);
    const acct = again.waitFor(MessageType.Account, 1);
    again.sendRaw(
      MessageType.Hello,
      encodeControl({ protocol: PROTOCOL_VERSION, client: "test", want_snapshot: true, characters: true, username: "alice", password: TEST_PASSWORD }),
    );
    await acct;
    const eid = await enterAs(again, gw, id);
    assert.notEqual(C.Transform.px[eid], 99);
    assert.ok(C.Health.current[eid] > 0);
  });

  it("never saves anyone without a character", async () => {
    const { url, gw } = await startGateway();
    const c = await connect(url);
    await c.hello("editor", { username: "user-c", password: TEST_PASSWORD });
    assert.equal(gw.saveCharacters(), 0);
  });
});
