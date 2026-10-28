/**
 * M5 gateway wiring (protocol 0x1d–0x20): ability triggers, telegraph
 * warnings and resolutions, status changes, and the full duel flow, over
 * a real Gateway + WebSocket clients.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type AbilityMessage,
  type DuelMessage,
  type StatusMessage,
  type TelegraphMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import * as C from "../../src/components.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";
import { AbilitySystem } from "../../src/abilities.js";
import { StatusSystem } from "../../src/status.js";
import { TelegraphSystem } from "../../src/telegraph.js";
import { DuelSystem } from "../../src/duel.js";

let now = 0;
let gw: Gateway | null = null;
let abilities: AbilitySystem;
let status: StatusSystem;
let telegraphs: TelegraphSystem;
let duels: DuelSystem;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  abilities = new AbilitySystem(30);
  abilities.define({ id: "dash", gcdMs: 1000, cooldownMs: 5000, castMs: 0 });
  status = new StatusSystem(30);
  status.define({
    id: "rage",
    kind: "buff",
    durationMs: 60000,
    maxStacks: 1,
    refresh: "refresh",
    dispellable: false,
    mods: [{ stat: "power", mode: "mul", value: 0.2 }],
  });
  telegraphs = new TelegraphSystem(30);
  duels = new DuelSystem(30);
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [abilities, status, telegraphs, duels],
    ...opts,
  });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

async function join(url: string, username: string): Promise<{ client: HeadlessClient; entity: bigint }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(username, creds(username));
  await snapP;
  return { client, entity: BigInt(welcome.player_entity) };
}

/** Entity id behind a wire id; give it Health and a position (test-only). */
function place(entity: bigint, x: number, z: number, hp = 100): number {
  const eid = gw!.world.resolveWireId(entity);
  assert.ok(eid >= 0);
  addComponent(gw!.world.ecs, C.Transform, eid);
  addComponent(gw!.world.ecs, C.Health, eid);
  C.Transform.px[eid] = x;
  C.Transform.pz[eid] = z;
  C.Health.current[eid] = hp;
  C.Health.max[eid] = hp;
  return eid;
}

/** Let a client->server message arrive, then run ~n ticks. */
async function frames(n: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < n; i++) {
    now += 34;
    gw!.frame(now);
  }
  await new Promise((r) => setTimeout(r, 150));
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: M5 combat abilities", () => {
  it("duel challenge -> accept -> yield flows over the wire", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    const aEid = place(a.entity, 0, 0);
    const bEid = place(b.entity, 5, 0);

    // Alice challenges Bob.
    const challengedP = b.client.waitFor(MessageType.Duel, 1);
    a.client.sendRaw(MessageType.Duel, encodeControl({ kind: "duel", action: "challenge", target: b.entity.toString() }));
    await frames(3);
    {
      const [payload] = await challengedP;
      const msg = decodeControl<DuelMessage>(payload);
      assert.equal(msg.state, "challenged");
      assert.equal(msg.a, a.entity.toString());
      assert.equal(msg.b, b.entity.toString());
    }
    assert.equal(duels.canHit(aEid, bEid), false, "not hostile until accepted");

    // Bob accepts: both hear accepted + started.
    const aP = a.client.waitFor(MessageType.Duel, 2);
    const bP = b.client.waitFor(MessageType.Duel, 2);
    b.client.sendRaw(MessageType.Duel, encodeControl({ kind: "duel", action: "accept" }));
    await frames(3);
    {
      const [p1, p2] = await aP;
      const states = [decodeControl<DuelMessage>(p1).state, decodeControl<DuelMessage>(p2).state].sort();
      assert.deepEqual(states, ["accepted", "started"]);
    }
    await bP;
    assert.equal(duels.canHit(aEid, bEid), true, "duel opponents are hostile");

    // Alice yields: Bob wins.
    const endP = a.client.waitFor(MessageType.Duel, 1);
    a.client.sendRaw(MessageType.Duel, encodeControl({ kind: "duel", action: "yield" }));
    await frames(3);
    {
      const [payload] = await endP;
      const msg = decodeControl<DuelMessage>(payload);
      assert.equal(msg.state, "ended");
      assert.equal(msg.reason, "yield");
      assert.equal(msg.winner, b.entity.toString());
    }
    assert.equal(duels.canHit(aEid, bEid), false, "hostility ends with the duel");
  });

  it("a duelist disconnecting ends the duel, and the opponent is told", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    const aEid = place(a.entity, 0, 0);
    const bEid = place(b.entity, 5, 0);
    duels.challenge(aEid, bEid, 0);
    duels.accept(bEid, 0);
    await frames(2);
    assert.ok(duels.inDuel(aEid));

    const endP = a.client.waitFor(MessageType.Duel, 1);
    await b.client.close();
    await frames(3);
    const msg = decodeControl<DuelMessage>((await endP)[0]);
    assert.equal(msg.state, "ended");
    assert.equal(msg.reason, "cancelled");
    assert.equal(duels.inDuel(aEid), false);
    assert.equal(duels.canHit(aEid, bEid), false, "the parked avatar is safe");
  });

  it("a telegraph warns, then resolves against whoever is inside", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    const aEid = place(a.entity, 0, 0);
    const bEid = place(b.entity, 1, 1); // inside the circle
    void aEid;

    const warnP = b.client.waitFor(MessageType.Telegraph, 1);
    const tick = gw!.world.currentTick;
    telegraphs.cast(
      gw!.world,
      { source: aEid, shape: { kind: "circle", x: 0, z: 0, r: 3 }, warnMs: 1000, amount: 25 },
      tick,
    );
    await frames(2);
    {
      const [payload] = await warnP;
      const msg = decodeControl<TelegraphMessage>(payload);
      assert.equal(msg.state, "warned");
      assert.equal(msg.shape.kind, "circle");
      assert.ok((msg.ticksUntilHit ?? 0) > 0);
    }

    const resolveP = b.client.waitFor(MessageType.Telegraph, 1);
    await frames(35); // past the 1 s warning
    {
      const [payload] = await resolveP;
      const msg = decodeControl<TelegraphMessage>(payload);
      assert.equal(msg.state, "resolved");
      assert.deepEqual(
        msg.hits!.map((h) => h.target),
        [b.entity.toString()],
        "only Bob was inside",
      );
      assert.equal(C.Health.current[bEid], 75);
    }
  });

  it("status changes reach the client", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const aEid = place(a.entity, 0, 0);

    const appliedP = a.client.waitFor(MessageType.Status, 1);
    status.apply(aEid, "rage", aEid, gw!.world.currentTick);
    await frames(2);
    {
      const [payload] = await appliedP;
      const msg = decodeControl<StatusMessage>(payload);
      assert.equal(msg.state, "applied");
      assert.equal(msg.id, "rage");
      assert.equal(msg.entity, a.entity.toString());
      assert.equal(msg.stacks, 1);
    }

    const removedP = a.client.waitFor(MessageType.Status, 1);
    status.remove(aEid, gw!.world.currentTick, "rage");
    await frames(2);
    {
      const [payload] = await removedP;
      const msg = decodeControl<StatusMessage>(payload);
      assert.equal(msg.state, "removed");
      assert.equal(msg.id, "rage");
    }
  });

  it("ability triggers fire, and unknown ids are rejected", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    place(a.entity, 0, 0);

    const firedP = a.client.waitFor(MessageType.Ability, 1);
    a.client.sendRaw(MessageType.Ability, encodeControl({ kind: "trigger", id: "dash" }));
    await frames(3);
    {
      const [payload] = await firedP;
      const msg = decodeControl<AbilityMessage>(payload);
      assert.equal(msg.state, "fired");
      assert.equal(msg.id, "dash");
      assert.equal(msg.entity, a.entity.toString());
    }

    const rejectedP = a.client.waitFor(MessageType.Ability, 1);
    a.client.sendRaw(MessageType.Ability, encodeControl({ kind: "trigger", id: "nope" }));
    await frames(3);
    {
      const [payload] = await rejectedP;
      const msg = decodeControl<AbilityMessage>(payload);
      assert.equal(msg.state, "rejected");
      assert.equal(msg.reason, "unknown");
    }
  });
});
