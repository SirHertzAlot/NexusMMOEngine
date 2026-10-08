/**
 * WalletSystem: grants, spends, transfers, and the change drain. SQLite
 * persistence is covered by wallet-store.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WalletSystem } from "../../src/economy/wallet.js";

describe("WalletSystem", () => {
  it("a stranger starts at zero; grants add up", () => {
    const w = new WalletSystem();
    assert.equal(w.balanceOf(7), 0);
    assert.equal(w.grant(7, 100, 1), true);
    assert.equal(w.grant(7, 50, 2), true);
    assert.equal(w.balanceOf(7), 150);
  });

  it("refuses non-positive and fractional amounts", () => {
    const w = new WalletSystem();
    assert.equal(w.grant(1, 0, 1), false);
    assert.equal(w.grant(1, -5, 1), false);
    assert.equal(w.grant(1, 1.5, 1), false);
    assert.equal(w.balanceOf(1), 0);
  });

  it("spend fails when short and never goes negative", () => {
    const w = new WalletSystem();
    w.grant(1, 100, 1);
    assert.equal(w.spend(1, 150, 2), false);
    assert.equal(w.balanceOf(1), 100);
    assert.equal(w.spend(1, 100, 3), true);
    assert.equal(w.balanceOf(1), 0);
  });

  it("transfer is atomic", () => {
    const w = new WalletSystem();
    w.grant(1, 100, 1);
    assert.equal(w.transfer(1, 2, 40, 2), true);
    assert.equal(w.balanceOf(1), 60);
    assert.equal(w.balanceOf(2), 40);
    assert.equal(w.transfer(1, 2, 1000, 3), false, "short: nothing moves");
    assert.equal(w.balanceOf(1), 60);
    assert.equal(w.balanceOf(2), 40);
    assert.equal(w.transfer(1, 1, 10, 4), false, "no self-transfers");
  });

  it("changes drain for the gateway", () => {
    const w = new WalletSystem();
    w.grant(1, 100, 10);
    w.spend(1, 30, 11);
    const changes = w.drainChanges();
    assert.deepEqual(changes, [
      { tick: 10, charId: 1, balance: 100 },
      { tick: 11, charId: 1, balance: 70 },
    ]);
    assert.deepEqual(w.drainChanges(), [], "drained");
  });

  it("loads persisted balances through the store", () => {
    const saved = new Map<number, number>([[9, 250]]);
    const w = new WalletSystem({
      load: (c: number) => saved.get(c) ?? 0,
      save: (c: number, g: number) => saved.set(c, g),
    });
    assert.equal(w.balanceOf(9), 250, "lazy load from the store");
    w.spend(9, 50, 1);
    assert.equal(saved.get(9), 200, "write-through");
  });
});
