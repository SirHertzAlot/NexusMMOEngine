/**
 * EC1 gateway wiring for vendors (protocol 0x21, kind "vendor"): listing
 * a vendor's stock, buying, and selling, over a real Gateway + WebSocket
 * clients. The vendor is a world entity with a Transform; item movement
 * uses a stub hook (the ItemService wiring lives in server.ts).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type VendorMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import * as C from "../../src/components.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";
import { WalletSystem } from "../../src/economy/wallet.js";
import { VendorSystem } from "../../src/economy/vendor.js";

let now = 0;
let gw: Gateway | null = null;
let wallet: WalletSystem;
let vendor: VendorSystem;
/** charId -> item ids, for the stub hook. */
const bags = new Map<number, number[]>();
const defOf = new Map<number, number>();
let nextItem = 5000;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  bags.clear();
  defOf.clear();
  wallet = new WalletSystem();
  vendor = new VendorSystem(wallet, {
    give: (c, def) => {
      const bag = bags.get(c) ?? [];
      if (bag.length >= 20) return false;
      const id = nextItem++;
      bag.push(id);
      bags.set(c, bag);
      defOf.set(id, def);
      return true;
    },
    take: (c, item) => {
      const bag = bags.get(c);
      const i = bag?.indexOf(item) ?? -1;
      if (!bag || i < 0) return false;
      bag.splice(i, 1);
      defOf.delete(item);
      return true;
    },
    defOf: (item) => defOf.get(item) ?? -1,
    nameOf: (def) => `Test Item ${def}`,
  });
  vendor.define({
    id: "general",
    name: "General Goods",
    buybackRate: 0.5,
    stock: [{ def: 7, price: 100, quantity: -1 }],
  });
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [wallet, vendor],
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

/** Spawn a vendor entity at (x, z) and attach the "general" template. */
function spawnVendor(x: number, z: number): bigint {
  const eid = gw!.world.spawn();
  addComponent(gw!.world.ecs, C.Transform, eid);
  C.Transform.px[eid] = x;
  C.Transform.pz[eid] = z;
  assert.equal(vendor.attach(eid, "general"), true);
  return gw!.world.wireId(eid);
}

/** Move a player's avatar next to (x, z). */
function placePlayer(entity: bigint, x: number, z: number): void {
  const eid = gw!.world.resolveWireId(entity);
  assert.ok(eid >= 0);
  C.Transform.px[eid] = x;
  C.Transform.pz[eid] = z;
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

describe("gateway: EC1 vendors", () => {
  it("list shows the vendor's stock", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const vWire = spawnVendor(10, 10);
    placePlayer(a.entity, 10, 11); // within 4 m

    const listP = a.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "vendor", action: "list", vendor: vWire.toString() }));
    await frames(3);
    const msg = decodeControl<VendorMessage>((await listP)[0]);
    assert.equal(msg.kind, "vendor");
    assert.equal(msg.state, "listed");
    assert.equal(msg.name, "General Goods");
    assert.deepEqual(msg.stock, [{ def: 7, name: "Test Item 7", price: 100, quantity: -1 }]);
    assert.equal(msg.buybackRate, 0.5);
  });

  it("buying moves gold and delivers the item", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const vWire = spawnVendor(10, 10);
    placePlayer(a.entity, 10, 11);
    // Alice is holder -1 (first to join, no character store in tests).
    wallet.grant(-1, 250, gw!.world.currentTick);
    await frames(1); // flush the grant's wallet message

    const buyP = a.client.waitFor(MessageType.Trade, 2); // bought + wallet
    a.client.sendRaw(
      MessageType.Trade,
      encodeControl({ kind: "vendor", action: "buy", vendor: vWire.toString(), def: 7 }),
    );
    await frames(3);
    const msgs = (await buyP).map((p) => decodeControl<VendorMessage | { kind: string; balance: number }>(p));
    const bought = msgs.find((m) => m.kind === "vendor") as VendorMessage;
    assert.equal(bought.state, "bought");
    assert.equal(bought.def, 7);
    assert.equal(bought.price, 100);
    const w = msgs.find((m) => m.kind === "wallet") as { balance: number };
    assert.equal(w.balance, 150);
    assert.equal(bags.get(-1)?.length, 1);
    assert.equal(defOf.get(bags.get(-1)![0]), 7);
  });

  it("buying fails when broke or too far", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const vWire = spawnVendor(10, 10);

    // Too far: no gold granted yet either, but reach is checked first.
    placePlayer(a.entity, 50, 50);
    const farP = a.client.waitFor(MessageType.Error, 1);
    a.client.sendRaw(
      MessageType.Trade,
      encodeControl({ kind: "vendor", action: "buy", vendor: vWire.toString(), def: 7 }),
    );
    await frames(3);
    assert.match(decodeControl<{ message: string }>((await farP)[0]).message, /too far/);

    // Close enough but broke.
    placePlayer(a.entity, 10, 11);
    const brokeP = a.client.waitFor(MessageType.Error, 1);
    a.client.sendRaw(
      MessageType.Trade,
      encodeControl({ kind: "vendor", action: "buy", vendor: vWire.toString(), def: 7 }),
    );
    await frames(3);
    assert.match(decodeControl<{ message: string }>((await brokeP)[0]).message, /not enough gold/);
  });

  it("selling pays the buyback price", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const vWire = spawnVendor(10, 10);
    placePlayer(a.entity, 10, 11);
    // Alice holds an item of def 7 (price 100, buyback 50%).
    bags.set(-1, [6001]);
    defOf.set(6001, 7);

    const sellP = a.client.waitFor(MessageType.Trade, 2); // sold + wallet
    a.client.sendRaw(
      MessageType.Trade,
      encodeControl({ kind: "vendor", action: "sell", vendor: vWire.toString(), item: 6001 }),
    );
    await frames(3);
    const msgs = (await sellP).map((p) => decodeControl<VendorMessage | { kind: string; balance: number }>(p));
    const sold = msgs.find((m) => m.kind === "vendor") as VendorMessage;
    assert.equal(sold.state, "sold");
    assert.equal(sold.item, 6001);
    const w = msgs.find((m) => m.kind === "wallet") as { balance: number };
    assert.equal(w.balance, 50);
    assert.equal(bags.get(-1)?.length, 0, "item taken");
  });

  it("listing a non-vendor entity is refused", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const errP = a.client.waitFor(MessageType.Error, 1);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "vendor", action: "list", vendor: a.entity.toString() }));
    await frames(3);
    assert.match(decodeControl<{ message: string }>((await errP)[0]).message, /not a vendor/);
  });
});
