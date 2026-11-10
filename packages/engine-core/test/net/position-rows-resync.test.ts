/**
 * Position-only rows end to end: a receiver that lacks an entity's baseline discards the row and asks for a resync
 * (Ping with resync: true, what MirrorClient sends), the server answers with a replace baseline, and the receiver
 * ends equal to the server. A row with no baseline must never show up as an identity rotation or scale.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeDelta, decodeDeltaSet, DeltaSetKind, encodeControl, MessageType } from "@mmo-engine/protocol";
import { MirrorState } from "@mmo-engine/mirror";
import { Gateway } from "../../src/net/gateway.js";
import { applyTeleport } from "../../src/admin/player.js";
import { Transform } from "../../src/index.js";
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

/** Run n ticks and fold each client's DeltaSets into its mirror; returns, per client, whether any set was a replace. */
async function step(n: number, ...cs: Array<Awaited<ReturnType<typeof join>>>): Promise<boolean[]> {
  const waits = cs.map((c) => c.client.waitFor(MessageType.DeltaSet, n));
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
  const got = await Promise.all(waits);
  return cs.map((c, i) => {
    let replaced = false;
    for (const p of got[i]) {
      const set = decodeDeltaSet(p);
      replaced = replaced || set.replace;
      c.mirror.applyDeltaSet(set.tick, set.replace, set.entries.map((e) => ({
        sector: e.sector,
        leave: e.kind === DeltaSetKind.Leave,
        delta: e.kind === DeltaSetKind.Leave ? null : decodeDelta(e.bytes),
      })));
    }
    return replaced;
  });
}

it("an orphan position-only row is discarded, flags a resync, and the replace baseline repairs the receiver", async () => {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128 } });
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);
  const alice = await join(url, "alice");
  const bob = await join(url, "user-a");
  assert.equal(applyTeleport(gw.world, bob.entity, 20, 20, null).ok, true);
  await step(3, alice, bob);
  const bobEid = gw.world.resolveWireId(bob.entity);
  assert.ok(bobEid >= 0);
  // Give bob a non-default rotation and scale, then move him by small steps: position-only rows from here on.
  Transform.qy[bobEid] = 0.5;
  Transform.qw[bobEid] = 0.866;
  Transform.sx[bobEid] = Transform.sy[bobEid] = Transform.sz[bobEid] = 2;
  await step(2, alice, bob);
  assert.equal(alice.mirror.entities.get(bob.entity)?.transform?.sx, 2, "alice holds bob's scale");

  // Alice loses bob's baseline (as if a frame had been missed), then bob keeps moving.
  alice.mirror.entities.get(bob.entity)!.transform = undefined;
  assert.equal(alice.mirror.orphanPositionRows, 0);
  assert.equal(applyTeleport(gw.world, bob.entity, 21, 20, null).ok, true);
  await step(1, alice, bob);
  assert.ok(alice.mirror.orphanPositionRows >= 1, "the row without a baseline was counted");
  assert.equal(alice.mirror.needsResync, true, "and a resync is flagged");
  assert.equal(alice.mirror.entities.get(bob.entity)?.transform, undefined, "no identity rotation or scale was invented");

  // What MirrorClient does: ask for a resync. The next DeltaSet for alice is a replace baseline.
  alice.client.sendRaw(MessageType.Ping, encodeControl({ t: Date.now(), resync: true }));
  await new Promise((r) => setTimeout(r, 50));
  const replaced = await step(2, alice, bob);
  assert.equal(replaced[0], true, "the server answered with a replace baseline");
  const t = alice.mirror.entities.get(bob.entity)?.transform;
  assert.ok(t, "bob's transform is back");
  assert.equal(Math.fround(t.qy), Math.fround(Transform.qy[bobEid]), "rotation is bob's real rotation");
  assert.equal(t.sx, 2, "scale is bob's real scale");
  assert.equal(Math.fround(t.px), Math.fround(Transform.px[bobEid]));
  alice.client.close();
  bob.client.close();
});
