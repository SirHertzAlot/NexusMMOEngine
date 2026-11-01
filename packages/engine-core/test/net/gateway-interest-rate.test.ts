/**
 * Interest rate LOD (IM7): with `outerEvery` set, a sector kept only by hysteresis (beyond enterM)
 * sends a delta every N ticks, carrying the union of the rows that changed since. The viewer sees
 * the fewer deltas and still ends with the mover's latest position.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeDelta, decodeDeltaSet, DeltaSetKind, MessageType } from "@mmo-engine/protocol";
import { MirrorState } from "@mmo-engine/mirror";
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

async function join(url: string, name: string) {
  const client = new HeadlessClient();
  await client.connect(url);
  const welcome = await client.hello(name, { username: name, password: TEST_PASSWORD });
  return { client, entity: BigInt(welcome.player_entity), mirror: new MirrorState() };
}

type Joined = Awaited<ReturnType<typeof join>>;

/** One tick: the watcher's set arrives, and is applied to its mirror. Returns the entries it carried. */
async function tick(c: Joined) {
  const wait = c.client.waitFor(MessageType.DeltaSet, 1);
  now += STEP_MS;
  gw!.frame(now);
  const [payload] = await wait;
  const set = decodeDeltaSet(payload);
  c.mirror.applyDeltaSet(set.tick, set.replace, set.entries.map((e) => ({
    sector: e.sector,
    leave: e.kind === DeltaSetKind.Leave,
    delta: e.kind === DeltaSetKind.Leave ? null : decodeDelta(e.bytes),
  })));
  return set.entries;
}

it("outer-ring sectors send one delta every N ticks, and the mirror still converges", async () => {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128, outerEvery: 3 } });
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);
  const alice = await join(url, "alice");
  const bob = await join(url, "user-a");

  // Bob stands in the sector x 128..192 with Alice inside 96 m of it: he is near and comes into view.
  assert.equal(applyTeleport(gw.world, alice.entity, 100, 0, null).ok, true);
  assert.equal(applyTeleport(gw.world, bob.entity, 150, 0, null).ok, true);
  for (let i = 0; i < 3; i++) await tick(alice);
  assert.ok(alice.mirror.entities.get(bob.entity)?.transform, "bob is in view");

  // Alice steps back so bob's sector is 108 m away: kept by hysteresis only (outer ring).
  assert.equal(applyTeleport(gw.world, alice.entity, 20, 0, null).ok, true);
  await tick(alice);
  let sent = 0;
  for (let i = 0; i < 9; i++) {
    assert.equal(applyTeleport(gw.world, bob.entity, 150 + i * 0.5, 0, null).ok, true);
    const entries = await tick(alice);
    sent += entries.filter((e) => e.sector === "2,0" && e.kind === DeltaSetKind.Delta).length;
  }
  assert.equal(sent, 3, "9 ticks of movement in the outer ring: 3 deltas at a period of 3");

  // Bob stops; one more window lands and the mirror has his last position.
  for (let i = 0; i < 3; i++) await tick(alice);
  assert.ok(Math.abs((alice.mirror.entities.get(bob.entity)?.transform?.px ?? NaN) - 154) < 1e-3, "mirror holds bob's latest x");
  alice.client.close();
  bob.client.close();
});
