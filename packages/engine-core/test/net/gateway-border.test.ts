/**
 * Cross-region view (IM8): the home region gives a player near a neighbour's
 * ground a signed ticket; the neighbour lets that ticket in as a read-only
 * observer and sends what is near the reported position, clamped to its
 * border strip. A forged ticket is refused.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, decodeDelta, decodeDeltaSet, DeltaSetKind, encodeControl, encodeEnvelope, MessageType, PROTOCOL_VERSION, type BorderMessage } from "@mmo-engine/protocol";
import { MirrorState } from "@mmo-engine/mirror";
import { Gateway } from "../../src/net/gateway.js";
import { applyTeleport } from "../../src/admin/player.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
const KEY = "fleet-key";
const A = { regionId: "region-a", endpoint: "ws://a", rect: { x0: 0, z0: 0, x1: 1000, z1: 1000 } };
const B = { regionId: "region-b", endpoint: "ws://b", rect: { x0: 1000, z0: 0, x1: 2000, z1: 1000 } };
let gws: Gateway[] = [];
let now = 1_000_000;

afterEach(async () => {
  for (const g of gws) await g.close();
  gws = [];
});

async function region(self: typeof A, other: typeof A): Promise<{ gw: Gateway; url: string }> {
  const gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128 } });
  gws.push(gw);
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.setBorders({ regionId: self.regionId, key: KEY, rect: self.rect }, [self, other]);
  gw.frame(now);
  return { gw, url };
}
function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    for (const g of gws) g.frame(now);
  }
}

it("a player at the border observes the neighbour's entities near it, read-only", async () => {
  const a = await region(A, B);
  const b = await region(B, A);
  const alice = new HeadlessClient();
  await alice.connect(a.url);
  const aliceEntity = BigInt((await alice.hello("alice", { username: "alice", password: TEST_PASSWORD })).player_entity);
  const bob = new HeadlessClient();
  await bob.connect(b.url);
  const bobEntity = BigInt((await bob.hello("user-a", { username: "user-a", password: TEST_PASSWORD })).player_entity);
  assert.ok(applyTeleport(a.gw.world, aliceEntity, 950, 500, null).ok);
  assert.ok(applyTeleport(b.gw.world, bobEntity, 1030, 500, null).ok);

  // Within a second the home region sends alice a border ticket for region B.
  const border = alice.waitFor(MessageType.Border, 1);
  frames(31);
  const msg = decodeControl<BorderMessage>((await border)[0]);
  assert.ok(msg.kind === "border" && !msg.leave && msg.region === "region-b" && msg.endpoint === "ws://b");

  // A forged ticket is refused.
  const forger = new HeadlessClient();
  await forger.connect(b.url);
  const refused = forger.waitFor(MessageType.Error, 1);
  forger.sendRaw(MessageType.Hello, encodeControl({ protocol: PROTOCOL_VERSION, client: "t", want_snapshot: true, observe: { region: "region-b", from: "region-a", account: "alice", exp: msg.exp, ticket: "0".repeat(64) } }));
  await refused;

  // The ticket gets alice's client in as an observer of B.
  const observer = new HeadlessClient();
  await observer.connect(b.url);
  const welcomed = observer.waitFor(MessageType.Welcome, 1);
  observer.sendRaw(MessageType.Hello, encodeControl({ protocol: PROTOCOL_VERSION, client: "t", want_snapshot: true, observe: { region: msg.region, from: msg.from, account: msg.account, exp: msg.exp, ticket: msg.ticket } }));
  await welcomed;
  observer.sendRaw(MessageType.Border, encodeControl({ kind: "observe", x: 950, z: 500 }));
  // Intents from an observer do nothing (it has no player).
  observer.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "say", text: "hi" }));
  await new Promise((r) => setTimeout(r, 50));
  const sets = observer.waitFor(MessageType.DeltaSet, 2);
  frames(2);
  const mirror = new MirrorState();
  for (const p of await sets) {
    const s = decodeDeltaSet(p);
    mirror.applyDeltaSet(s.tick, s.replace, s.entries.map((e) => ({ sector: e.sector, leave: e.kind === DeltaSetKind.Leave, delta: e.kind === DeltaSetKind.Leave ? null : decodeDelta(e.bytes) })));
  }
  assert.ok(mirror.entities.get(bobEntity)?.transform, "bob, 80 m away across the border, is observed");

  // Far inside B is out of reach: the observer anchor is clamped to the border strip.
  assert.ok(applyTeleport(b.gw.world, bobEntity, 1900, 500, null).ok);
  observer.sendRaw(MessageType.Border, encodeControl({ kind: "observe", x: 1900, z: 500 }));
  await new Promise((r) => setTimeout(r, 50));
  const later = observer.waitFor(MessageType.DeltaSet, 2);
  frames(2);
  for (const p of await later) {
    const s = decodeDeltaSet(p);
    mirror.applyDeltaSet(s.tick, s.replace, s.entries.map((e) => ({ sector: e.sector, leave: e.kind === DeltaSetKind.Leave, delta: e.kind === DeltaSetKind.Leave ? null : decodeDelta(e.bytes) })));
  }
  assert.ok(!mirror.entities.has(bobEntity), "the observer can't look deep into the neighbour");

  // Alice walks away from the border: told to stop observing.
  assert.ok(applyTeleport(a.gw.world, aliceEntity, 500, 500, null).ok);
  const leave = alice.waitFor(MessageType.Border, 1);
  frames(31);
  const bye = decodeControl<BorderMessage>((await leave)[0]);
  assert.ok(bye.kind === "border" && bye.leave === true);
  void encodeEnvelope;
});
