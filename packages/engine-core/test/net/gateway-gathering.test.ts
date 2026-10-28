/**
 * Gathering over the wire (catalog 0x24): joining sends the resource nodes
 * and the (empty) pouch; a gather answers with the pouch naming what was
 * added and tells every player the node's new stock; refusals are 4005 and
 * a bad shape 4003.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { decodeControl, encodeControl, MessageType, type ErrorMessage, type PouchMessage, type ResourcesMessage } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { GatheringSystem } from "../../src/gathering/index.js";
import { Transform } from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

function tick(): void {
  now += 1000 / 30;
  gw!.frame(now);
}

async function start(): Promise<{ url: string; sim: SimWorld; node: number; gathering: GatheringSystem }> {
  now = 1_000_000;
  const sim = new SimWorld();
  const gathering = new GatheringSystem({ now: () => now, cooldownMs: 0 });
  const node = sim.spawn();
  addComponent(sim.ecs, Transform, node);
  Transform.px[node] = 0;
  Transform.pz[node] = 0;
  gathering.register(node, "town/trees-0", { kind: "tree_stand", material: "yew-log", tier: 2, skill: "Woodcutting", stock: 2, regrowHours: 72, halfX: 3, halfZ: 3 });
  gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore(), world: sim, systems: [gathering], spawnPoint: { x: 0, z: 0 } });
  const port = await gw.listen();
  gw.frame(now);
  return { url: `ws://127.0.0.1:${port}`, sim, node, gathering };
}

/** Stand the node where `client`'s avatar spawned. */
function besides(sim: SimWorld, node: number, client: HeadlessClient): void {
  const avatar = sim.resolveWireId(BigInt(client.welcome!.player_entity));
  Transform.px[node] = Transform.px[avatar]! + 4;
  Transform.pz[node] = Transform.pz[avatar]!;
}

async function join(url: string, name: string): Promise<{ client: HeadlessClient; resources: ResourcesMessage; pouch: PouchMessage }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const gatherP = client.waitFor(MessageType.Gather, 2);
  await client.hello(name, { username: name, password: TEST_PASSWORD });
  const msgs = (await gatherP).map((p) => decodeControl<ResourcesMessage | PouchMessage>(p));
  return { client, resources: msgs.find((m): m is ResourcesMessage => m.kind === "resources")!, pouch: msgs.find((m): m is PouchMessage => m.kind === "pouch")! };
}

describe("gateway: gathering", () => {
  it("sends the nodes and the pouch on joining; a gather fills the pouch and every player sees the stock", async () => {
    const { url, sim, node } = await start();
    const alice = await join(url, "alice");
    const bob = await join(url, "user-a");
    assert.equal(alice.resources.nodes.length, 1);
    const view = alice.resources.nodes[0]!;
    assert.deepEqual({ ...view, entity: undefined }, { entity: undefined, kind: "tree_stand", material: "yew-log", name: "Yew log", tier: 2, skill: "Woodcutting", stock: 2, max: 2, size: [6, 6], regrowAt: null });
    assert.equal(view.entity, sim.wireId(node).toString());
    assert.deepEqual(alice.pouch.materials, []);
    besides(sim, node, alice.client);

    const pouchP = alice.client.waitFor(MessageType.Gather, 1);
    alice.client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: view.entity }));
    const pouch = decodeControl<PouchMessage>((await pouchP)[0]!);
    assert.deepEqual(pouch, { kind: "pouch", materials: [{ material: "yew-log", name: "Yew log", tier: 2, count: 1 }], gathered: { material: "yew-log", name: "Yew log", count: 1 } });

    const seenP = bob.client.waitFor(MessageType.Gather, 1);
    tick();
    const seen = decodeControl<ResourcesMessage>((await seenP)[0]!);
    assert.equal(seen.nodes[0]!.stock, 1);
    await alice.client.close();
    await bob.client.close();
  });

  it("a gather with a cast time starts the bar, then fills the pouch when it ends, and gathers once", async () => {
    const { url, sim, node, gathering } = await start();
    gathering.castSeconds = 0.15;
    const { client } = await join(url, "user-c");
    const entity = sim.wireId(node).toString();
    besides(sim, node, client);
    const startedP = client.waitFor(MessageType.Magic, 1);
    const pouchP = client.waitFor(MessageType.Gather, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity }));
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity })); // already casting: ignored
    const started = decodeControl<{ kind: string; spell: string; state: string; seconds?: number }>((await startedP)[0]!);
    assert.deepEqual([started.spell, started.state, started.seconds], ["gather", "started", 0.15]);
    const pouch = decodeControl<PouchMessage>((await pouchP)[0]!);
    assert.equal(pouch.gathered?.count, 1);
    assert.equal(pouch.materials[0]!.count, 1, "one gather, not two");
    await client.close();
  });

  it("refuses a node worked out (4005) and a bad shape (4003)", async () => {
    const { url, sim, node } = await start();
    const { client } = await join(url, "user-b");
    const entity = sim.wireId(node).toString();
    besides(sim, node, client);
    for (let i = 0; i < 2; i++) {
      const p = client.waitFor(MessageType.Gather, 1);
      client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity }));
      await p;
    }
    let errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity }));
    let err = decodeControl<ErrorMessage>((await errP)[0]!);
    assert.equal(err.code, 4005);
    assert.match(err.message, /worked out/);
    errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", entity: "not a number" }));
    err = decodeControl<ErrorMessage>((await errP)[0]!);
    assert.equal(err.code, 4003);
    await client.close();
  });
});
