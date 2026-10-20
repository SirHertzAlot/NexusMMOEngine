/**
 * WalletSystem — gold. Integer coins per character; no fractions, no
 * debt. The economy's unit of account: loot, quest rewards, vendors and
 * trades all move through here.
 *
 * Balances live in memory and write through to a WalletStore (SQLite);
 * a fresh character starts at 0. Every change drains as a WalletChange
 * for the gateway, which tells the owner (gold is private).
 *
 * Character ids are the ItemStore-style holder ids (holderOf), not
 * entity ids — wallets survive the avatar despawning.
 */

import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";

export interface WalletStore {
  /** Gold for `charId`; 0 when never seen. */
  load(charId: number): number;
  /** Persist `charId`'s balance (write-through). */
  save(charId: number, gold: number): void;
}

export interface WalletChange {
  tick: number;
  charId: number;
  balance: number;
}

export class WalletSystem implements SimSystem {
  readonly name = "wallet";
  private readonly balances = new Map<number, number>();
  private changes: WalletChange[] = [];

  constructor(private readonly store?: WalletStore) {}

  /** No per-tick work: balances change on actions, not on ticks. */
  step(_sim: SimWorld, _dt: number): void {}

  /** Gold `charId` holds (0 for strangers). */
  balanceOf(charId: number): number {
    let b = this.balances.get(charId);
    if (b === undefined) {
      b = this.store?.load(charId) ?? 0;
      this.balances.set(charId, Math.max(0, Math.floor(b)));
    }
    return b;
  }

  /**
   * Give `charId` `amount` gold (quest reward, loot, admin). Amount must
   * be a positive integer; returns false otherwise.
   */
  grant(charId: number, amount: number, tick: number): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    this.set(charId, this.balanceOf(charId) + amount, tick);
    return true;
  }

  /**
   * Take `amount` gold from `charId` (vendor price, trade offer). Fails
   * when the balance is short; never goes negative.
   */
  spend(charId: number, amount: number, tick: number): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const b = this.balanceOf(charId);
    if (b < amount) return false;
    this.set(charId, b - amount, tick);
    return true;
  }

  /**
   * Reconcile `charId`'s balance to `balance` (slice A2): the world
   * tier settled an operation and its record is truth, so the local
   * cache adopts it exactly. A no-op when the balance already matches.
   * Only the fleet-mode settled-outcome path calls this; local gold
   * movement stays grant/spend/transfer.
   */
  reconcile(charId: number, balance: number, tick: number): void {
    if (!Number.isInteger(balance) || balance < 0) return;
    if (this.balanceOf(charId) === balance) return;
    this.set(charId, balance, tick);
  }

  /** Move `amount` gold from one character to another, atomically. */
  transfer(from: number, to: number, amount: number, tick: number): boolean {
    if (from === to) return false;
    if (!this.spend(from, amount, tick)) return false;
    // spend() validated; grant() of a positive integer cannot fail.
    this.grant(to, amount, tick);
    return true;
  }

  private set(charId: number, balance: number, tick: number): void {
    this.balances.set(charId, balance);
    this.store?.save(charId, balance);
    this.changes.push({ tick, charId, balance });
  }

  /** Balance changes since the last call, for the gateway. */
  drainChanges(): WalletChange[] {
    const out = this.changes;
    if (out.length > 0) this.changes = [];
    return out;
  }
}
