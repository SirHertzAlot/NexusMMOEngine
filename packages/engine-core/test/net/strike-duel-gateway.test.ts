/**
 * Live-shaped duel strike: two clients over a real Gateway, with the
 * combat module's systems (strike, duels, body) built by modules/combat.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { encodeControl, MessageType } from "@mmo-engine/protocol";
import { engineDefaults } from "@mmo-engine/rules";
import { Gateway } from "../../src/net/gateway.js";
import { SimWorld } from "../../src/world.js";
import * as C from "../../src/components.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";
// @ts-expect-error: the combat module is plain JS, outside the TS build
import { createSystems } from "../../../../../modules/combat/server.js";

let now = 0;
let gw: Gateway | null = null;
let sim: SimWorld;
let sys: Record<string, { step(s: SimWorld, dt: number): void; [k: string]: unknown }>;

async function start(): Promise<string> {
  now = 1_000_000;
  sim = new SimWorld();
  const rules = engineDefaults();
  const config = {
    combat: {
      rules,
      hooks: {},
      combatSkills: { get: () => 0, train() {}, techniqueSkill: () => undefined, familiarity: () => 0, useFamily() {}, knows: () => false },
      getWeaponOf: () => null,
      getWornFactor: () => 1,
      getCreaturesPlace: () => false,
      getGateway: () => gw,
      getRespawnSeconds: () => 10,
      getDropper: () => null,
      getQuests: () => null,
      getKindOf: () => undefined,
      getCombatTuning: () => ({ resolution: rules.combat.resolution, unarmed: rules.items.unarmed }),
    },
  };
  sys = createSystems({ sim, config, log() {} });
  gw = new Gateway({
    clock: () => now,
    world: sim,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [sys.stamina, sys.body, sys.magic, sys.abilities, sys.status, sys.telegraphs, sys.duels, sys.combat, sys.death] as never,
  });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

async function join(url: string, username: string) {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(username, { username, password: TEST_PASSWORD });
  await snapP;
  return { client, entity: BigInt(welcome.player_entity) };
}

async function frames(n: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < n; i++) {
    now += 34;
    gw!.frame(now);
  }
  await new Promise((r) => setTimeout(r, 150));
}

function place(entity: bigint, x: number, z: number): number {
  const eid = gw!.world.resolveWireId(entity);
  addComponent(gw!.world.ecs, C.Transform, eid);
  C.Transform.px[eid] = x;
  C.Transform.pz[eid] = z;
  return eid;
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("strike between duelling clients (gateway + combat module)", () => {
  it("a strike from A lands on B, who stands in reach", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    const aEid = place(a.entity, 0, 0);
    const bEid = place(b.entity, 1, 0);
    const hpB = () => C.Health.current[gw!.world.resolveWireId(b.entity)];
    const before = hpB();

    a.client.sendRaw(MessageType.Duel, encodeControl({ kind: "duel", action: "challenge", target: b.entity.toString() }));
    await frames(3);
    b.client.sendRaw(MessageType.Duel, encodeControl({ kind: "duel", action: "accept" }));
    await frames(3);
    assert.equal((sys.duels as unknown as { opponent(e: number): number }).opponent(aEid), bEid, "duel started");

    a.client.sendRaw(MessageType.Ability, encodeControl({ kind: "trigger", id: "strike" }));
    await frames(3);
    
    assert.equal(hpB(), before - 10);
  });

  it("a duelist's strike goes to the partner even when a creature stands nearer", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    place(a.entity, 0, 0);
    place(b.entity, 2, 0);
    const creature = sim.spawn();
    addComponent(sim.ecs, C.Transform, creature);
    addComponent(sim.ecs, C.Health, creature);
    C.Transform.px[creature] = 0.5;
    C.Transform.pz[creature] = 0;
    C.Health.current[creature] = C.Health.max[creature] = 60;
    const bEid = gw!.world.resolveWireId(b.entity);
    await startDuel(a, b);
    a.client.sendRaw(MessageType.Ability, encodeControl({ kind: "trigger", id: "strike" }));
    await frames(3);
    assert.equal(C.Health.current[bEid], 90, "the partner takes the blow");
    assert.equal(C.Health.current[creature], 60, "the bystander is untouched");
  });

  it("guard halves the strike it faces (armour mul -0.5)", async () => {
    const url = await start();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    place(a.entity, 0, 0);
    place(b.entity, 1, 0);
    const bEid = gw!.world.resolveWireId(b.entity);
    await startDuel(a, b);
    b.client.sendRaw(MessageType.Ability, encodeControl({ kind: "trigger", id: "guard" }));
    await frames(3);
    a.client.sendRaw(MessageType.Ability, encodeControl({ kind: "trigger", id: "strike" }));
    await frames(3);
    assert.equal(C.Health.current[bEid], 95, "a guarded strike does 0.5 of 10");
  });
});

async function startDuel(a: { client: HeadlessClient; entity: bigint }, b: { client: HeadlessClient; entity: bigint }): Promise<void> {
  a.client.sendRaw(MessageType.Duel, encodeControl({ kind: "duel", action: "challenge", target: b.entity.toString() }));
  await frames(3);
  b.client.sendRaw(MessageType.Duel, encodeControl({ kind: "duel", action: "accept" }));
  await frames(3);
}
