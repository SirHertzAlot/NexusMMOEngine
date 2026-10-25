/**
 * EC1 gateway wiring (protocol 0x21): wallet balance pushes and the full
 * trade flow (open -> offer -> accept -> settle), over a real Gateway +
 * WebSocket clients. Item movement uses a stub hook; the ItemStore wiring
 * lives in server.ts and is covered by the trade unit tests.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type TradeMessage,
  type WalletMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";
import { WalletSystem } from "../../src/economy/wallet.js";
import { TradeSystem } from "../../src/economy/trade.js";

let now = 0;
let gw: Gateway | null = null;
let wallet: WalletSystem;
let trade: TradeSystem;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  wallet = new WalletSystem();
  // No character store in tests: holderOf assigns -1, -2, -3 by join
  // order (alice, user-b, user-c). Alice owns item 101; bags have room.
  const owned = new Map<number, number[]>([[-1, [101]]]);
  trade = new TradeSystem(wallet, {
    owns: (c, item) => owned.get(c)?.includes(item) ?? false,
    freeSlots: () => 20,
    move: (item, from, to) => {
      const a = owned.get(from);
      const i = a?.indexOf(item) ?? -1;
      if (!a || i < 0) return false;
      a.splice(i, 1);
      owned.set(to, [...(owned.get(to) ?? []), item]);
      return true;
    },
  });
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [wallet, trade],
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

describe("gateway: EC1 economy", () => {
  it("gold grants reach the owner's client as wallet messages", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");

    const aP = a.client.waitFor(MessageType.Trade, 1);
    const bP = b.client.waitFor(MessageType.Trade, 1);
    // Alice is holder -1 (first to join); Bob hears nothing: gold is private.
    wallet.grant(-1, 250, gw!.world.currentTick);
    await frames(2);

    const [aPayload] = await aP;
    const msg = decodeControl<WalletMessage>(aPayload);
    assert.equal(msg.kind, "wallet");
    assert.equal(msg.balance, 250);

    // Bob hears nothing: gold is private.
    const raced = await Promise.race([bP.then(() => "got"), new Promise((r) => setTimeout(() => r("timeout"), 400))]);
    assert.equal(raced, "timeout");
    void b;
  });

  it("a joining player hears their balance with the snapshot", async () => {
    const url = await startGateway();
    wallet.grant(-1, 40, gw!.world.currentTick); // alice will be holder -1
    const a = await join(url, "alice");
    const wallets = a.client.payloads(MessageType.Trade).map((p) => decodeControl<WalletMessage>(p)).filter((m) => m.kind === "wallet");
    assert.equal(wallets.length, 1);
    assert.equal(wallets[0]!.balance, 40);
  });

  it("open -> offer gold -> double accept settles over the wire", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    wallet.grant(-1, 100, gw!.world.currentTick);
    wallet.grant(-2, 100, gw!.world.currentTick);
    await frames(1); // flush the grant wallet messages

    // Alice opens a trade with Bob.
    const openA = a.client.waitFor(MessageType.Trade, 1);
    const openB = b.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "open", target: b.entity.toString() }));
    await frames(3);
    const openMsg = decodeControl<TradeMessage>((await openA)[0]);
    assert.equal(openMsg.kind, "trade");
    assert.equal(openMsg.state, "open");
    assert.equal(openMsg.a, a.entity.toString());
    assert.equal(openMsg.b, b.entity.toString());
    const tradeId = openMsg.id;
    await openB;

    // Alice offers 30 gold; both see the offer.
    const offerB = b.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "offer", id: tradeId, gold: 30 }));
    await frames(3);
    const offerMsg = decodeControl<TradeMessage>((await offerB)[0]);
    assert.equal(offerMsg.state, "offer");
    assert.equal(offerMsg.aGold, 30);
    assert.equal(offerMsg.aAccepted, false);

    // Both accept: the trade settles, gold moves, wallets update.
    const settleA = a.client.waitFor(MessageType.Trade, 3); // accepted, settled, wallet
    const settleB = b.client.waitFor(MessageType.Trade, 3);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
    b.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
    await frames(3);
    const aMsgs = (await settleA).map((p) => decodeControl<TradeMessage | WalletMessage>(p));
    const bMsgs = (await settleB).map((p) => decodeControl<TradeMessage | WalletMessage>(p));
    assert.ok(aMsgs.some((m) => m.kind === "trade" && m.state === "settled"), "alice saw settled");
    assert.ok(bMsgs.some((m) => m.kind === "trade" && m.state === "settled"), "bob saw settled");
    const aWallet = aMsgs.find((m) => m.kind === "wallet") as WalletMessage;
    const bWallet = bMsgs.find((m) => m.kind === "wallet") as WalletMessage;
    assert.equal(aWallet.balance, 70);
    assert.equal(bWallet.balance, 130);
  });

  it("offering more gold than held is refused", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    wallet.grant(-1, 10, gw!.world.currentTick);
    await frames(1);

    const openA = a.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "open", target: b.entity.toString() }));
    await frames(3);
    const tradeId = decodeControl<TradeMessage>((await openA)[0]).id;

    const errP = a.client.waitFor(MessageType.Error, 1);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "offer", id: tradeId, gold: 999 }));
    await frames(3);
    const [errPayload] = await errP;
    const err = decodeControl<{ message: string }>(errPayload);
    assert.match(err.message, /refused/);
  });

  it("a stranger cannot accept someone else's trade", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    const c = await join(url, "user-c");
    await frames(1);

    const openA = a.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "open", target: b.entity.toString() }));
    await frames(3);
    const tradeId = decodeControl<TradeMessage>((await openA)[0]).id;

    const errP = c.client.waitFor(MessageType.Error, 1);
    c.client.sendRaw(MessageType.Trade, encodeControl({ kind: "trade", action: "accept", id: tradeId }));
    await frames(3);
    const [errPayload] = await errP;
    const err = decodeControl<{ message: string }>(errPayload);
    assert.match(err.message, /nothing to accept/);
  });
});
