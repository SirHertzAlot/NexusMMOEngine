/**
 * TradeSystem — player-to-player trading: gold and bag items, settled
 * atomically. The classic two-sided flow:
 *
 * `open(a, b)` → both place offers (gold, bag items) → both `accept` →
 * the trade settles. Changing any offer after accepting resets both
 * accepts (no bait-and-switch). Either side may `cancel` any time before
 * settlement; open trades expire.
 *
 * Settlement is all-or-nothing: it first validates *everything* (both
 * gold balances, every item still owned, both bags have room), then
 * moves gold through the WalletSystem and items through the TradeItems
 * hook. A failed validation settles nothing.
 *
 * Gold moves are integers; items are bag items only (held/worn gear
 * stays out of trades in v1). Character ids are the ItemStore-style
 * holder ids. Every state change drains as a TradeEvent carrying the
 * full trade — the client renders its trade window from the latest one.
 */

import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import type { WalletSystem } from "./wallet.js";

/** How the trade moves bag items (wired to the ItemStore in server.ts). */
export interface TradeItems {
  /** Whether `itemId` is in `charId`'s bag right now. */
  owns(charId: number, itemId: number): boolean;
  /** Free bag slots for `charId`. */
  freeSlots(charId: number): number;
  /** Move `itemId` from one bag to another; false when it didn't move. */
  move(itemId: number, from: number, to: number): boolean;
}

export type TradeState = "open" | "settled" | "cancelled" | "expired";

export interface TradeEvent {
  tick: number;
  id: number;
  state: TradeState | "offer" | "accepted";
  a: number;
  b: number;
  aGold: number;
  bGold: number;
  aItems: number[];
  bItems: number[];
  aAccepted: boolean;
  bAccepted: boolean;
}

interface Trade {
  a: number;
  b: number;
  aGold: number;
  bGold: number;
  aItems: number[];
  bItems: number[];
  aAccepted: boolean;
  bAccepted: boolean;
  expiresAt: number;
}

const msToTicks = (ms: number, tickHz: number): number => Math.max(0, Math.round((ms / 1000) * tickHz));

export class TradeSystem implements SimSystem {
  readonly name = "trade";
  private readonly trades = new Map<number, Trade>();
  /** Character -> trade id (one trade at a time). */
  private readonly byChar = new Map<number, number>();
  private nextId = 1;
  private events: TradeEvent[] = [];

  constructor(
    private readonly wallet: WalletSystem,
    private readonly items: TradeItems,
    private readonly tickHz = 30,
    /** ms an open trade waits before it expires. */
    private readonly ttlMs = 120000,
  ) {}

  /** Open a trade between `a` and `b`; null when either is already trading. */
  open(a: number, b: number, tick: number): number | null {
    if (a === b || this.byChar.has(a) || this.byChar.has(b)) return null;
    const id = this.nextId++;
    const t: Trade = {
      a,
      b,
      aGold: 0,
      bGold: 0,
      aItems: [],
      bItems: [],
      aAccepted: false,
      bAccepted: false,
      expiresAt: tick + msToTicks(this.ttlMs, this.tickHz),
    };
    this.trades.set(id, t);
    this.byChar.set(a, id);
    this.byChar.set(b, id);
    this.emit(tick, id, t, "open");
    return id;
  }

  /** Offer `amount` gold (0 clears). Resets both accepts. */
  offerGold(id: number, char: number, amount: number, tick: number): boolean {
    const t = this.trades.get(id);
    if (!t || !this.party(t, char)) return false;
    if (!Number.isInteger(amount) || amount < 0) return false;
    if (amount > this.wallet.balanceOf(char)) return false;
    if (char === t.a) t.aGold = amount;
    else t.bGold = amount;
    this.unaccept(t);
    this.emit(tick, id, t, "offer");
    return true;
  }

  /** Offer a bag item. Resets both accepts. */
  offerItem(id: number, char: number, itemId: number, tick: number): boolean {
    const t = this.trades.get(id);
    if (!t || !this.party(t, char)) return false;
    if (!this.items.owns(char, itemId)) return false;
    const list = char === t.a ? t.aItems : t.bItems;
    if (list.includes(itemId)) return false;
    // An item is offered by one side only.
    const other = char === t.a ? t.bItems : t.aItems;
    if (other.includes(itemId)) return false;
    list.push(itemId);
    this.unaccept(t);
    this.emit(tick, id, t, "offer");
    return true;
  }

  /** Take an offered item back. Resets both accepts. */
  removeItem(id: number, char: number, itemId: number, tick: number): boolean {
    const t = this.trades.get(id);
    if (!t || !this.party(t, char)) return false;
    const list = char === t.a ? t.aItems : t.bItems;
    const i = list.indexOf(itemId);
    if (i < 0) return false;
    list.splice(i, 1);
    this.unaccept(t);
    this.emit(tick, id, t, "offer");
    return true;
  }

  /**
   * Accept the current deal. When both sides have accepted, the trade
   * settles atomically; a failed settlement cancels the trade instead.
   */
  accept(id: number, char: number, tick: number): boolean {
    const t = this.trades.get(id);
    if (!t || !this.party(t, char)) return false;
    if (char === t.a) t.aAccepted = true;
    else t.bAccepted = true;
    if (t.aAccepted && t.bAccepted) {
      if (!this.settle(id, t, tick)) this.drop(id, t, tick, "cancelled");
      return true;
    }
    this.emit(tick, id, t, "accepted");
    return true;
  }

  /**
   * A read-only snapshot of an open trade (slice A2): the fleet-mode
   * commit path inspects the deal before routing its settlement
   * through the world tier. Null when the trade is not open.
   */
  pending(id: number): (Trade & { id: number }) | null {
    const t = this.trades.get(id);
    return t ? { id, ...t, aItems: [...t.aItems], bItems: [...t.bItems] } : null;
  }

  /**
   * Finalise a trade whose settlement the world tier has committed
   * (slice A2, fleet mode): both sides are marked accepted, the trade
   * closes as settled, and the settled event drains as usual — but NO
   * gold or items move here; the world record is the commit point and
   * the local caches have already reconciled to its settled outcome.
   * False when the trade is no longer open (expired mid-commit: the
   * world outcome still stands, the local trade is simply gone).
   */
  settleFromWorld(id: number, tick: number): boolean {
    const t = this.trades.get(id);
    if (!t) return false;
    t.aAccepted = true;
    t.bAccepted = true;
    this.trades.delete(id);
    this.byChar.delete(t.a);
    this.byChar.delete(t.b);
    this.emit(tick, id, t, "settled");
    return true;
  }

  /**
   * Abort a trade whose world-tier commit was refused or never
   * landed (slice A2, fleet mode): the same end state as a failed
   * local settlement — the trade cancels and nothing has moved.
   */
  failSettlement(id: number, tick: number): boolean {
    const t = this.trades.get(id);
    if (!t) return false;
    this.drop(id, t, tick, "cancelled");
    return true;
  }

  /** Cancel the trade (either party, any time before settlement). */
  cancel(id: number, char: number, tick: number): boolean {
    const t = this.trades.get(id);
    if (!t || !this.party(t, char)) return false;
    this.drop(id, t, tick, "cancelled");
    return true;
  }

  /** The trade `char` is in, if any. */
  tradeOf(char: number): number | undefined {
    return this.byChar.get(char);
  }

  step(sim: SimWorld, _dt: number): void {
    const tick = sim.currentTick;
    for (const [id, t] of this.trades) {
      if (tick > t.expiresAt) this.drop(id, t, tick, "expired");
    }
  }

  /** Events since the last call, for the gateway. */
  drainEvents(): TradeEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }

  private party(t: Trade, char: number): boolean {
    return char === t.a || char === t.b;
  }

  private unaccept(t: Trade): void {
    t.aAccepted = false;
    t.bAccepted = false;
  }

  private emit(tick: number, id: number, t: Trade, state: TradeEvent["state"]): void {
    this.events.push({
      tick,
      id,
      state,
      a: t.a,
      b: t.b,
      aGold: t.aGold,
      bGold: t.bGold,
      aItems: [...t.aItems],
      bItems: [...t.bItems],
      aAccepted: t.aAccepted,
      bAccepted: t.bAccepted,
    });
  }

  private drop(id: number, t: Trade, tick: number, state: "cancelled" | "expired"): void {
    this.trades.delete(id);
    this.byChar.delete(t.a);
    this.byChar.delete(t.b);
    this.emit(tick, id, t, state);
  }

  /**
   * Validate everything, then move everything. Returns false (and moves
   * nothing) when any part fails.
   */
  private settle(id: number, t: Trade, tick: number): boolean {
    // Validate: gold balances cover the offers...
    if (this.wallet.balanceOf(t.a) < t.aGold || this.wallet.balanceOf(t.b) < t.bGold) return false;
    // ...every offered item is still in its offerer's bag...
    for (const item of t.aItems) if (!this.items.owns(t.a, item)) return false;
    for (const item of t.bItems) if (!this.items.owns(t.b, item)) return false;
    // ...and both bags have room for what's coming. Outgoing items free
    // their slots during settlement, so v1 conservatively requires a
    // strictly free slot per incoming item.
    if (this.items.freeSlots(t.b) < t.aItems.length) return false;
    if (this.items.freeSlots(t.a) < t.bItems.length) return false;
    // Apply: gold, then items. All validations passed, so these succeed.
    if (t.aGold > 0) this.wallet.transfer(t.a, t.b, t.aGold, tick);
    if (t.bGold > 0) this.wallet.transfer(t.b, t.a, t.bGold, tick);
    for (const item of t.aItems) this.items.move(item, t.a, t.b);
    for (const item of t.bItems) this.items.move(item, t.b, t.a);
    this.trades.delete(id);
    this.byChar.delete(t.a);
    this.byChar.delete(t.b);
    this.emit(tick, id, t, "settled");
    return true;
  }
}
