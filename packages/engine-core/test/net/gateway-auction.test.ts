/**
 * EC1 gateway wiring for the auction house (protocol 0x21, kind "auction"):
 * listing, bidding, buyouts, and browsing, over a real Gateway + WebSocket
 * clients. Item movement uses a stub hook (the ItemStore wiring lives in
 * server.ts).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type AuctionMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";
import { WalletSystem } from "../../src/economy/wallet.js";
import { AuctionSystem } from "../../src/economy/auction.js";

let now = 0;
let gw: Gateway | null = null;
let wallet: WalletSystem;
let auction: AuctionSystem;
/** charId -> item ids, for the stub hook. */
const bags = new Map<number, number[]>();
const defOf = new Map<number, number>();

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  bags.clear();
  defOf.clear();
  wallet = new WalletSystem();
  auction = new AuctionSystem(wallet, {
    owns: (c, item) => bags.get(c)?.includes(item) ?? false,
    freeSlots: () => 20,
    defOf: (item) => defOf.get(item) ?? -1,
    move: (item, from, to) => {
      const a = bags.get(from);
      const i = a?.indexOf(item) ?? -1;
      if (!a || i < 0) return false;
      a.splice(i, 1);
      bags.set(to, [...(bags.get(to) ?? []), item]);
      return true;
    },
  });
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [wallet, auction],
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

// No character store in tests: holderOf assigns -1, -2 by join order.
const ALICE = -1;
const BOB = -2;

describe("gateway: EC1 auction house", () => {
  it("list -> browse -> bid -> buyout flows over the wire", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    // Alice owns item 801 (def 7).
    bags.set(ALICE, [801]);
    defOf.set(801, 7);
    wallet.grant(BOB, 1000, gw!.world.currentTick);
    await frames(1); // flush the grant's wallet message

    // Alice lists the item.
    const listP = a.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(
      MessageType.Trade,
      encodeControl({ kind: "auction", action: "list", item: 801, startBid: 100, buyout: 500 }),
    );
    await frames(3);
    const listed = decodeControl<AuctionMessage>((await listP)[0]);
    assert.equal(listed.kind, "auction");
    assert.equal(listed.state, "listed");
    const listingId = listed.listing!.id;
    assert.equal(listed.listing!.startBid, 100);
    assert.equal(listed.listing!.buyout, 500);

    // Bob browses and sees it.
    const browseP = b.client.waitFor(MessageType.Trade, 1);
    b.client.sendRaw(MessageType.Trade, encodeControl({ kind: "auction", action: "browse" }));
    await frames(3);
    const browse = decodeControl<AuctionMessage>((await browseP)[0]);
    assert.equal(browse.state, "browse");
    assert.equal(browse.listings!.length, 1);
    assert.equal(browse.listings![0].id, listingId);

    // Bob bids 150.
    const bidP = b.client.waitFor(MessageType.Trade, 1);
    b.client.sendRaw(MessageType.Trade, encodeControl({ kind: "auction", action: "bid", listing: listingId, amount: 150 }));
    await frames(3);
    const bid = decodeControl<AuctionMessage>((await bidP)[0]);
    assert.equal(bid.state, "bid");
    assert.equal(bid.listing!.topBid, 150);

    // Bob buys it out: the item moves, gold moves minus the 5% cut.
    const soldP = b.client.waitFor(MessageType.Trade, 2); // sold + wallet
    b.client.sendRaw(MessageType.Trade, encodeControl({ kind: "auction", action: "buyout", listing: listingId }));
    await frames(3);
    const soldMsgs = (await soldP).map((p) => decodeControl<AuctionMessage | { kind: string; balance: number }>(p));
    const sold = soldMsgs.find((m) => m.kind === "auction") as AuctionMessage;
    assert.equal(sold.state, "sold");
    const w = soldMsgs.find((m) => m.kind === "wallet") as { balance: number };
    // Bob escrowed 150, then paid 500 - 150 = 350 more: 1000 - 500 = 500.
    assert.equal(w.balance, 500);
    assert.deepEqual(bags.get(BOB), [801]);
    void a;
  });

  it("bidding below the minimum is refused", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    bags.set(ALICE, [801]);
    defOf.set(801, 7);
    wallet.grant(BOB, 1000, gw!.world.currentTick);
    await frames(1);

    const listP = a.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(
      MessageType.Trade,
      encodeControl({ kind: "auction", action: "list", item: 801, startBid: 100 }),
    );
    await frames(3);
    const listingId = decodeControl<AuctionMessage>((await listP)[0]).listing!.id;

    const errP = b.client.waitFor(MessageType.Error, 1);
    b.client.sendRaw(MessageType.Trade, encodeControl({ kind: "auction", action: "bid", listing: listingId, amount: 50 }));
    await frames(3);
    assert.match(decodeControl<{ message: string }>((await errP)[0]).message, /bid at least 100/);
  });

  it("a stranger cannot cancel someone else's listing", async () => {
    const url = await startGateway();
    const a = await join(url, "alice");
    const b = await join(url, "user-b");
    bags.set(ALICE, [801]);
    defOf.set(801, 7);
    await frames(1);

    const listP = a.client.waitFor(MessageType.Trade, 1);
    a.client.sendRaw(
      MessageType.Trade,
      encodeControl({ kind: "auction", action: "list", item: 801, startBid: 100 }),
    );
    await frames(3);
    const listingId = decodeControl<AuctionMessage>((await listP)[0]).listing!.id;

    const errP = b.client.waitFor(MessageType.Error, 1);
    b.client.sendRaw(MessageType.Trade, encodeControl({ kind: "auction", action: "cancel", listing: listingId }));
    await frames(3);
    assert.match(decodeControl<{ message: string }>((await errP)[0]).message, /not your listing/);
  });
});
