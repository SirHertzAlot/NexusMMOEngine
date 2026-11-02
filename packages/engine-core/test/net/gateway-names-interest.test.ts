/**
 * Names with interest management (IM5): a name (0x12) goes to a session only when the named entity
 * is in its view, and a name a session missed (the entity was out of view when it spawned) arrives
 * when the entity's sector comes into view, so a player never sees an entity with no name.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, decodeDeltaSet, DeltaSetKind, MessageType, type NamesMessage } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { applyTeleport } from "../../src/admin/player.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  await gw?.close();
  gw = null;
});

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

async function join(url: string, name: string): Promise<{ client: HeadlessClient; entity: string }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const welcome = await client.hello(name, { username: name, password: TEST_PASSWORD });
  return { client, entity: String(welcome.player_entity) };
}

/** Every entity id named to this client so far. */
function namedIds(client: HeadlessClient): Set<string> {
  const out = new Set<string>();
  for (const p of client.payloads(MessageType.Names)) {
    for (const [id] of decodeControl<NamesMessage>(p).names) out.add(id);
  }
  return out;
}

/** Run n frames and wait until the client has received each one's DeltaSet. */
async function run(n: number, client: HeadlessClient): Promise<void> {
  const waited = client.waitFor(MessageType.DeltaSet, n);
  frames(n);
  await waited;
}

it("a far player's name is not sent; it arrives when that player comes into view", async () => {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128 } });
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);

  // Alice is in the world first. Bob logs in and is moved 1.4 km away before the frame that spawns him,
  // so his spawn tick is one that Alice cannot see. (Alice's welcome carries the whole roster, by design.)
  const alice = await join(url, "alice");
  await run(3, alice.client);
  assert.ok(namedIds(alice.client).has(alice.entity), "alice is named to herself");

  const bob = await join(url, "user-a");
  assert.equal(applyTeleport(gw.world, BigInt(bob.entity), 1000, 1000, null).ok, true);
  await run(3, alice.client);
  assert.ok(!namedIds(alice.client).has(bob.entity), "bob's spawn, 1.4 km away, is not named to alice");

  // Bob walks up to Alice: his sector enters her interest, and his name follows.
  assert.equal(applyTeleport(gw.world, BigInt(bob.entity), 20, 20, null).ok, true);
  await run(3, alice.client);
  assert.ok(namedIds(alice.client).has(bob.entity), "bob's name arrives when he comes into view");

  alice.client.close();
  bob.client.close();
});
