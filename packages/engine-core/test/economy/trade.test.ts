/**
 * TradeSystem: the full offer/accept/settle flow, atomic settlement, and
 * expiry. Item movement is a stub hook here; the ItemStore wiring is
 * covered by the gateway integration test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WalletSystem } from "../../src/economy/wallet.js";
import { TradeSystem, type TradeItems } from "../../src/economy/trade.js";
import type { SimWorld } from "../../src/world.js";

const DT = 1 / 30;
const simAt = (tick: number): SimWorld => ({ currentTick: tick }) as SimWorld;
const ticks = (ms: number): number => Math.round((ms / 1000) * 30);

/** In-memory bags: charId -> item ids. */
function bags(): { items: TradeItems; bags: Map<number, number[]> } {
  const bags = new Map<number, number[]>();
  const items: TradeItems = {
    owns: (c, item) => bags.get(c)?.includes(item) ?? false,
    freeSlots: (c) => 20 - (bags.get(c)?.length ?? 0),
    move: (item, from, to) => {
      const a = bags.get(from);
      const i = a?.indexOf(item) ?? -1;
      if (!a || i < 0) return false;
      a.splice(i, 1);
      let b = bags.get(to);
      if (!b) {
        b = [];
        bags.set(to, b);
      }
      b.push(item);
      return true;
    },
  };
  return { items, bags };
}

function setup() {
  const wallet = new WalletSystem();
  const { items, bags: b } = bags();
  const trade = new TradeSystem(wallet, items);
  return { wallet, trade, bags: b };
}

describe("TradeSystem", () => {
  it("gold for gold settles on double accept", () => {
    const { wallet, trade } = setup();
    wallet.grant(1, 100, 1);
    wallet.grant(2, 100, 1);
    const id = trade.open(1, 2, 10);
    assert.ok(id !== null);
    assert.equal(trade.offerGold(id!, 1, 30, 11), true);
    assert.equal(trade.offerGold(id!, 2, 50, 12), true);
    assert.equal(trade.accept(id!, 1, 13), true);
    assert.equal(trade.accept(id!, 2, 14), true);
    assert.equal(wallet.balanceOf(1), 120, "100 - 30 + 50");
    assert.equal(wallet.balanceOf(2), 80, "100 - 50 + 30");
    const ev = trade.drainEvents();
    assert.equal(ev[ev.length - 1].state, "settled");
  });

  it("an offer change resets both accepts", () => {
    const { wallet, trade } = setup();
    wallet.grant(1, 100, 1);
    wallet.grant(2, 100, 1);
    const id = trade.open(1, 2, 10)!;
    trade.offerGold(id, 1, 30, 11);
    trade.accept(id, 1, 12);
    trade.accept(id, 2, 13);
    // Settled already — open a new one to test the reset path.
    const id2 = trade.open(1, 2, 20)!;
    trade.offerGold(id2, 1, 10, 21);
    trade.accept(id2, 1, 22);
    trade.offerGold(id2, 1, 20, 23); // changed the deal
    const ev = trade.drainEvents();
    const last = ev[ev.length - 1];
    assert.equal(last.aAccepted, false, "accept reset by the new offer");
    assert.equal(last.state, "offer");
    assert.equal(wallet.balanceOf(1), 70, "first trade settled (1 gave 30); second untouched");
    assert.equal(wallet.balanceOf(2), 130, "first trade settled (2 got 30); second untouched");
  });

  it("cannot offer more gold than held", () => {
    const { wallet, trade } = setup();
    wallet.grant(1, 10, 1);
    const id = trade.open(1, 2, 10)!;
    assert.equal(trade.offerGold(id, 1, 50, 11), false);
    assert.equal(trade.offerGold(id, 1, 10, 11), true);
  });

  it("items move on settle; missing items abort it", () => {
    const { wallet, trade, bags } = setup();
    bags.set(1, [101, 102]);
    bags.set(2, [201]);
    const id = trade.open(1, 2, 10)!;
    assert.equal(trade.offerItem(id, 1, 101, 11), true);
    assert.equal(trade.offerItem(id, 2, 201, 12), true);
    assert.equal(trade.offerItem(id, 1, 999, 13), false, "not owned");
    trade.accept(id, 1, 14);
    trade.accept(id, 2, 15);
    assert.deepEqual(bags.get(1), [102, 201]);
    assert.deepEqual(bags.get(2), [101]);

    // The item vanishes mid-trade: settlement aborts, nothing moves.
    const id2 = trade.open(1, 2, 20)!;
    trade.offerItem(id2, 1, 102, 21);
    bags.get(1)!.splice(bags.get(1)!.indexOf(102), 1); // lost somehow
    trade.accept(id2, 1, 22);
    trade.accept(id2, 2, 23);
    const ev = trade.drainEvents();
    assert.equal(ev[ev.length - 1].state, "cancelled", "failed settlement cancels");
    assert.deepEqual(bags.get(2), [101], "nothing moved");
  });

  it("one trade per character; cancel frees them", () => {
    const { trade } = setup();
    const id = trade.open(1, 2, 10)!;
    assert.equal(trade.open(1, 3, 11), null, "1 is busy");
    assert.equal(trade.open(3, 2, 11), null, "2 is busy");
    assert.equal(trade.cancel(id, 2, 12), true);
    assert.ok(trade.open(1, 3, 13) !== null, "free again");
  });

  it("open trades expire", () => {
    const { trade } = setup();
    const id = trade.open(1, 2, 10)!;
    trade.step(simAt(10 + ticks(120000) + 1), DT);
    const ev = trade.drainEvents();
    assert.equal(ev[ev.length - 1].state, "expired");
    assert.equal(trade.tradeOf(1), undefined);
    void id;
  });

  it("a stranger cannot touch someone else's trade", () => {
    const { trade } = setup();
    const id = trade.open(1, 2, 10)!;
    assert.equal(trade.accept(id, 3, 11), false);
    assert.equal(trade.cancel(id, 3, 11), false);
    assert.equal(trade.offerGold(id, 3, 10, 11), false);
  });
});
