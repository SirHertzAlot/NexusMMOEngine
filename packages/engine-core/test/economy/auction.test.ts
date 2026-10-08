/**
 * AuctionSystem: listing, bidding, buyouts, expiry, and the house cut.
 * Item movement is a stub; the ItemStore wiring lives in server.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WalletSystem } from "../../src/economy/wallet.js";
import { AuctionSystem, type AuctionItems } from "../../src/economy/auction.js";
import type { SimWorld } from "../../src/world.js";

const DT = 1 / 30;
const simAt = (tick: number): SimWorld => ({ currentTick: tick }) as SimWorld;
const ticks = (ms: number): number => Math.round((ms / 1000) * 30);

function setup() {
  const wallet = new WalletSystem();
  const bags = new Map<number, number[]>();
  const defOf = new Map<number, number>();
  const items: AuctionItems = {
    owns: (c, item) => bags.get(c)?.includes(item) ?? false,
    freeSlots: (c) => 20 - (bags.get(c)?.length ?? 0),
    defOf: (item) => defOf.get(item) ?? -1,
    move: (item, from, to) => {
      const a = bags.get(from);
      const i = a?.indexOf(item) ?? -1;
      if (!a || i < 0) return false;
      a.splice(i, 1);
      bags.set(to, [...(bags.get(to) ?? []), item]);
      return true;
    },
    nameOf: (def) => `Test Item ${def}`,
  };
  const auction = new AuctionSystem(wallet, items);
  return { wallet, auction, bags, defOf };
}

const SELLER = 1;
const BUYER = 2;
const OTHER = 3;

describe("AuctionSystem", () => {
  it("lists, bids, and settles on expiry with the house cut", () => {
    const { wallet, auction, bags, defOf } = setup();
    bags.set(SELLER, [101]);
    defOf.set(101, 7);
    wallet.grant(BUYER, 1000, 1);

    const id = auction.list(SELLER, 101, 100, 500, 3600000, 10);
    assert.ok(id !== null);
    assert.equal(auction.isListed(101), true);
    assert.equal(auction.list(SELLER, 101, 100, 500, 3600000, 11), null, "can't list twice");

    assert.equal(auction.bid(BUYER, id!, 50, 12), "bid at least 100 gold");
    assert.equal(auction.bid(BUYER, id!, 100, 13), null);
    assert.equal(wallet.balanceOf(BUYER), 900, "bid escrowed");

    // Outbid: the first bidder is refunded at once.
    wallet.grant(OTHER, 1000, 14);
    assert.equal(auction.bid(OTHER, id!, 150, 15), null);
    assert.equal(wallet.balanceOf(BUYER), 1000, "refunded");
    assert.equal(wallet.balanceOf(OTHER), 850);

    // Expire: the top bidder wins at their bid minus the 5% cut.
    auction.step(simAt(10 + ticks(3600000) + 1), DT);
    assert.deepEqual(bags.get(OTHER), [101]);
    assert.equal(wallet.balanceOf(SELLER), 143, "150 - 5% fee (7.5 floored)");
    assert.equal(auction.isListed(101), false);
    const ev = auction.drainEvents();
    assert.equal(ev[ev.length - 1].state, "sold");
  });

  it("buyout settles immediately and refunds the top bidder", () => {
    const { wallet, auction, bags, defOf } = setup();
    bags.set(SELLER, [101]);
    defOf.set(101, 7);
    wallet.grant(BUYER, 1000, 1);
    wallet.grant(OTHER, 1000, 1);

    const id = auction.list(SELLER, 101, 100, 500, 3600000, 10)!;
    assert.equal(auction.bid(BUYER, id, 120, 11), null);
    assert.equal(auction.buyout(OTHER, id, 12), null);
    assert.deepEqual(bags.get(OTHER), [101]);
    assert.equal(wallet.balanceOf(OTHER), 500, "paid the buyout");
    assert.equal(wallet.balanceOf(BUYER), 1000, "bid refunded");
    assert.equal(wallet.balanceOf(SELLER), 475, "500 - 5%");
  });

  it("the top bidder can buy out by paying the difference", () => {
    const { wallet, auction, bags, defOf } = setup();
    bags.set(SELLER, [101]);
    defOf.set(101, 7);
    wallet.grant(BUYER, 1000, 1);

    const id = auction.list(SELLER, 101, 100, 500, 3600000, 10)!;
    assert.equal(auction.bid(BUYER, id, 200, 11), null);
    assert.equal(wallet.balanceOf(BUYER), 800);
    assert.equal(auction.buyout(BUYER, id, 12), null);
    assert.equal(wallet.balanceOf(BUYER), 500, "800 - (500 - 200)");
    assert.equal(wallet.balanceOf(SELLER), 475);
  });

  it("cancel works only with no bids", () => {
    const { auction, bags, defOf } = setup();
    bags.set(SELLER, [101]);
    defOf.set(101, 7);
    const id = auction.list(SELLER, 101, 100, 0, 3600000, 10)!;
    assert.equal(auction.cancel(OTHER, id, 11), "that's not your listing");
    assert.equal(auction.cancel(SELLER, id, 11), null);
    assert.equal(auction.isListed(101), false);
    assert.deepEqual(bags.get(SELLER), [101], "item never left");
  });

  it("expiry with no bids returns the item", () => {
    const { auction, bags, defOf } = setup();
    bags.set(SELLER, [101]);
    defOf.set(101, 7);
    const id = auction.list(SELLER, 101, 100, 0, 60000, 10)!;
    auction.step(simAt(10 + ticks(60000) + 1), DT);
    const ev = auction.drainEvents();
    assert.equal(ev[ev.length - 1].state, "expired");
    assert.deepEqual(bags.get(SELLER), [101]);
    void id;
  });

  it("a vanished item aborts the sale and refunds", () => {
    const { wallet, auction, bags, defOf } = setup();
    bags.set(SELLER, [101]);
    defOf.set(101, 7);
    wallet.grant(BUYER, 1000, 1);
    wallet.grant(OTHER, 1000, 1);
    const id = auction.list(SELLER, 101, 100, 500, 3600000, 10)!;
    assert.equal(auction.bid(BUYER, id, 100, 11), null);
    assert.equal(wallet.balanceOf(BUYER), 900, "bid escrowed");
    bags.get(SELLER)!.splice(0, 1); // item gone somehow
    assert.equal(auction.buyout(OTHER, id, 12), "the item is gone");
    assert.equal(wallet.balanceOf(BUYER), 1000, "bidder refunded");
    assert.equal(wallet.balanceOf(OTHER), 1000, "buyer untouched");
    assert.equal(wallet.balanceOf(SELLER), 0, "seller got nothing");
    assert.equal(auction.isListed(101), false, "listing dropped");
  });

  it("browse lists active listings soonest-expiring first", () => {
    const { auction, bags, defOf } = setup();
    bags.set(SELLER, [101, 102]);
    defOf.set(101, 7);
    defOf.set(102, 8);
    const a = auction.list(SELLER, 101, 100, 0, 3600000, 10)!;
    const b = auction.list(SELLER, 102, 50, 0, 60000, 10)!;
    const listings = auction.browse();
    assert.deepEqual(listings.map((l) => l.id), [b, a]);
    assert.equal(listings[0].def, 8);
  });

  it("rejects bad listings", () => {
    const { auction, bags, defOf } = setup();
    bags.set(SELLER, [101]);
    defOf.set(101, 7);
    assert.equal(auction.list(SELLER, 101, 0, 0, 60000, 1), null, "no zero start bid");
    assert.equal(auction.list(SELLER, 101, 100, 50, 60000, 1), null, "buyout below start");
    assert.equal(auction.list(SELLER, 999, 100, 0, 60000, 1), null, "not owned");
    assert.equal(auction.list(OTHER, 101, 100, 0, 60000, 1), null, "not the owner's");
  });
});
