/**
 * Interest management (IM3): with `interest` on, each client's DeltaSet
 * carries only the sectors near its avatar; an entity walking into view
 * arrives in full, walking out of it leaves, and the mirror ends up with
 * exactly what is near.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeDelta, decodeDeltaSet, DeltaSetKind, encodeControl, encodeEnvelope, MessageType, PROTOCOL_VERSION } from "@mmo-engine/protocol";
import { ChannelTransport } from "../../src/net/channel-transport.js";
import { MirrorState } from "@mmo-engine/mirror";
import { Gateway } from "../../src/net/gateway.js";
import { interestSectors } from "../../src/net/interest.js";
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

/** A client whose DeltaSets fold into a MirrorState. */
async function join(url: string, name: string) {
  const client = new HeadlessClient();
  await client.connect(url);
  const welcome = await client.hello(name, { username: name, password: TEST_PASSWORD });
  return { client, entity: BigInt(welcome.player_entity), mirror: new MirrorState() };
}

async function step(n: number, ...cs: Array<Awaited<ReturnType<typeof join>>>) {
  const waits = cs.map((c) => c.client.waitFor(MessageType.DeltaSet, n));
  frames(n);
  const got = await Promise.all(waits);
  cs.forEach((c, i) => {
    for (const p of got[i]) {
      const set = decodeDeltaSet(p);
      c.mirror.applyDeltaSet(set.tick, set.replace, set.entries.map((e) => ({
        sector: e.sector,
        leave: e.kind === DeltaSetKind.Leave,
        delta: e.kind === DeltaSetKind.Leave ? null : decodeDelta(e.bytes),
      })));
    }
  });
}

it("interest sets: enter radius, hysteresis, and the global sector", () => {
  const r = { enterM: 96, leaveM: 128 };
  const a = interestSectors(32, 32, r, null);
  assert.ok(a.has("g") && a.has("0,0") && a.has("1,1") && a.has("-1,-1"));
  assert.ok(!a.has("3,0"), "a sector 160 m away is out");
  // Standing at x=150: sector -1 (x<0) is 150 m away, beyond leaveM; sector 0 stays within.
  const b = interestSectors(150, 32, r, a);
  assert.ok(b.has("0,0") && !b.has("-1,0"));
});

it("a client sees only what is near; walking into view and out of it", async () => {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128 } });
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);
  const alice = await join(url, "alice");
  const bob = await join(url, "user-a");
  assert.equal(applyTeleport(gw.world, bob.entity, 1000, 1000, null).ok, true);
  await step(3, alice, bob);
  assert.ok(alice.mirror.entities.has(alice.entity), "own avatar in view");
  assert.ok(!alice.mirror.entities.has(bob.entity), "bob 1.4 km away is not");
  assert.ok(bob.mirror.entities.has(bob.entity) && !bob.mirror.entities.has(alice.entity));

  // Bob walks up to Alice: he arrives in full.
  const at = gw.world.resolveWireId(alice.entity);
  assert.equal(applyTeleport(gw.world, bob.entity, 20, 20, null).ok, true);
  await step(2, alice, bob);
  assert.ok(alice.mirror.entities.get(bob.entity)?.transform, "bob is in view with his rows");
  assert.ok(bob.mirror.entities.has(alice.entity));
  assert.ok(at >= 0);

  // And leaves again.
  assert.equal(applyTeleport(gw.world, bob.entity, -900, 900, null).ok, true);
  await step(2, alice, bob);
  assert.ok(!alice.mirror.entities.has(bob.entity), "bob left alice's view");
  assert.ok(!bob.mirror.entities.has(alice.entity));
  alice.client.close();
  bob.client.close();
});

it("through the edge: one wire.sectors push per tick carries the shared bytes and each session's plan", async () => {
  now = 1_000_000;
  const pushes: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const transport = new ChannelTransport((type, payload) => pushes.push({ type, payload: payload as Record<string, unknown> }), 4000);
  gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128 }, transport });
  await gw.listen();
  gw.frame(now);
  await transport.handle({ type: "wire.open", id: "p", payload: { sid: "e-1", ip: "127.0.0.1" } });
  const hello = encodeEnvelope(MessageType.Hello, encodeControl({ protocol: PROTOCOL_VERSION, client: "t", want_snapshot: true, username: "alice", password: TEST_PASSWORD }));
  await transport.handle({ type: "wire.msg", id: "p", payload: { sid: "e-1", data: Buffer.from(hello).toString("base64") } });
  for (let i = 0; i < 300 && !pushes.some((p) => p.type === "wire.send"); i++) await new Promise((r) => setTimeout(r, 10));
  pushes.length = 0;
  frames(2);
  const sectors = pushes.filter((p) => p.type === "wire.sectors");
  assert.equal(sectors.length, 2, "one push per tick");
  const plans = sectors[0].payload.plans as Array<{ sid: string; replace: boolean; entries: Array<[number, string, string]> }>;
  assert.equal(plans[0].sid, "e-1");
  assert.equal(plans[0].replace, true, "the first tick after welcome is a full replace");
  const bytes = sectors[0].payload.bytes as Record<string, string>;
  for (const [, , key] of plans[0].entries) assert.ok(key in bytes || key.startsWith("2:"));
  assert.ok(!pushes.some((p) => p.type === "wire.send" && Buffer.from(p.payload.data as string, "base64")[0] === MessageType.DeltaSet), "no per-session DeltaSet from the core");
});
