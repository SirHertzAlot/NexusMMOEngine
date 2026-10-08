/**
 * AuctionSystem — the auction house. Sellers list bag items with a
 * starting bid and an optional buyout; buyers bid or buy out; listings
 * expire on the tick.
 *
 * - `list`: the item stays in the seller's bag while listed (no escrow
 *   limbo on restart — listings are in-memory and simply vanish, the
 *   items never left). A listed item can't be listed twice.
 * - `bid`: must top the current bid; the gold leaves the bidder's wallet
 *   at once and the previous top bidder is refunded immediately.
 * - `buyout`: instant sale at the buyout price; the top bidder (if any)
 *   is refunded.
 * - `cancel`: the seller reclaims the listing, but only when nobody has bid.
 * - Expiry (`step`): the top bidder wins at their bid, or the seller keeps
 *   the item when there were no bids.
 *
 * Every sale takes a 5% transaction fee (rounded down) — a gold sink.
 * Settlement re-validates ownership: if the seller no longer holds the
 * item (traded it away mid-listing — the trade/vendor paths don't know
 * about listings in v1), the sale aborts and every escrowed bid is
 * refunded. Nothing is ever partially moved.
 *
 * Durations are capped at 48 h. Listings drain as events for the gateway;
 * `browse` returns the current order book for the client.
 */

import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import type { WalletSystem } from "./wallet.js";

/** How the auction moves bag items (wired to the ItemStore in server.ts). */
export interface AuctionItems {
  /** Whether `itemId` is in `charId`'s bag right now. */
  owns(charId: number, itemId: number): boolean;
  /** Free bag slots for `charId`. */
  freeSlots(charId: number): number;
  /** The def id behind an item instance; -1 when unknown. */
  defOf(itemId: number): number;
  /** Move `itemId` from one bag to another; false when it didn't move. */
  move(itemId: number, from: number, to: number): boolean;
}

export interface Listing {
  id: number;
  seller: number;
  item: number;
  def: number;
  startBid: number;
  buyout: number;
  topBid: number;
  topBidder: number;
  expiresAt: number;
}

export interface ListingView {
  id: number;
  def: number;
  startBid: number;
  buyout: number;
  topBid: number;
  topBidder: number;
  expiresAt: number;
}

export type AuctionEventState = "listed" | "bid" | "sold" | "expired" | "cancelled";

export interface AuctionEvent {
  tick: number;
  id: number;
  state: AuctionEventState;
  view: ListingView | null;
  /** Character ids to notify (seller, winner, outbid bidder). */
  parties: number[];
}

/** Longest a listing may run, ms. */
export const MAX_LISTING_MS = 48 * 3600 * 1000;
/** Default listing duration, ms. */
export const DEFAULT_LISTING_MS = 24 * 3600 * 1000;
/** The house's cut of every sale (a gold sink). */
export const AUCTION_FEE = 0.05;

const msToTicks = (ms: number, tickHz: number): number => Math.max(0, Math.round((ms / 1000) * tickHz));

export class AuctionSystem implements SimSystem {
  readonly name = "auction";
  private readonly listings = new Map<number, Listing>();
  /** Item instance -> listing id (one listing per item). */
  private readonly byItem = new Map<number, number>();
  private nextId = 1;
  private events: AuctionEvent[] = [];

  constructor(
    private readonly wallet: WalletSystem,
    private readonly items: AuctionItems,
    private readonly tickHz = 30,
  ) {}

  /**
   * List a bag item. Returns the listing id, or null when the item isn't
   * in the seller's bag or is already listed. `buyout` 0 means no buyout.
   */
  list(seller: number, itemId: number, startBid: number, buyout: number, durationMs: number, tick: number): number | null {
    if (!Number.isInteger(startBid) || startBid <= 0) return null;
    if (!Number.isInteger(buyout) || buyout < 0) return null;
    if (buyout > 0 && buyout < startBid) return null;
    if (!this.items.owns(seller, itemId)) return null;
    if (this.byItem.has(itemId)) return null;
    const def = this.items.defOf(itemId);
    if (def < 0) return null;
    const id = this.nextId++;
    const l: Listing = {
      id,
      seller,
      item: itemId,
      def,
      startBid,
      buyout,
      topBid: 0,
      topBidder: 0,
      expiresAt: tick + msToTicks(Math.min(Math.max(durationMs, 60000), MAX_LISTING_MS), this.tickHz),
    };
    this.listings.set(id, l);
    this.byItem.set(itemId, id);
    this.emit(tick, id, "listed", l, [l.seller]);
    return id;
  }

  /**
   * Bid on a listing. The gold leaves the wallet at once; the previous
   * top bidder is refunded. Returns an error string, or null on success.
   */
  bid(bidder: number, listingId: number, amount: number, tick: number): string | null {
    const l = this.listings.get(listingId);
    if (!l) return "no such listing";
    if (bidder === l.seller) return "you can't bid on your own listing";
    if (tick >= l.expiresAt) return "that listing expired";
    const min = l.topBid > 0 ? l.topBid + 1 : l.startBid;
    if (!Number.isInteger(amount) || amount < min) return `bid at least ${min} gold`;
    if (!this.wallet.spend(bidder, amount, tick)) return "not enough gold";
    // Refund the outbid party before recording the new top bid.
    if (l.topBidder !== 0) this.wallet.grant(l.topBidder, l.topBid, tick);
    l.topBid = amount;
    l.topBidder = bidder;
    this.emit(tick, listingId, "bid", l, [l.seller]);
    return null;
  }

  /**
   * Buy a listing out at its buyout price. Returns an error string, or
   * null on success.
   */
  buyout(buyer: number, listingId: number, tick: number): string | null {
    const l = this.listings.get(listingId);
    if (!l) return "no such listing";
    if (l.buyout <= 0) return "no buyout on that listing";
    if (buyer === l.seller) return "that's your listing";
    if (tick >= l.expiresAt) return "that listing expired";
    return this.settle(l, buyer, l.buyout, tick);
  }

  /**
   * Cancel a listing and keep the item. Only when nobody has bid;
   * otherwise the bidders' gold is already committed.
   */
  cancel(seller: number, listingId: number, tick: number): string | null {
    const l = this.listings.get(listingId);
    if (!l) return "no such listing";
    if (l.seller !== seller) return "that's not your listing";
    if (l.topBidder !== 0) return "there are bids on that listing";
    this.drop(listingId, l, tick, "cancelled", [l.seller]);
    return null;
  }

  /** Whether an item instance is currently listed. */
  isListed(itemId: number): boolean {
    return this.byItem.has(itemId);
  }

  /** The current order book (a copy), soonest-expiring first. */
  browse(): ListingView[] {
    return [...this.listings.values()]
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .map((l) => this.view(l));
  }

  step(sim: SimWorld, _dt: number): void {
    const tick = sim.currentTick;
    for (const [id, l] of [...this.listings]) {
      if (tick < l.expiresAt) continue;
      if (l.topBidder !== 0) {
        // The top bidder wins at their bid. If the item is gone or the
        // math fails, refund and drop the listing instead of half-moving.
        if (this.settle(l, l.topBidder, l.topBid, tick) !== null) {
          this.refund(l, tick);
          this.drop(id, l, tick, "expired", [l.seller, l.topBidder]);
        }
      } else {
        this.drop(id, l, tick, "expired", [l.seller]);
      }
    }
  }

  /** Events since the last call, for the gateway. */
  drainEvents(): AuctionEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }

  private view(l: Listing): ListingView {
    return {
      id: l.id,
      def: l.def,
      startBid: l.startBid,
      buyout: l.buyout,
      topBid: l.topBid,
      topBidder: l.topBidder,
      expiresAt: l.expiresAt,
    };
  }

  private emit(tick: number, id: number, state: AuctionEventState, l: Listing | null, parties: number[] = []): void {
    this.events.push({ tick, id, state, view: l ? this.view(l) : null, parties });
  }

  private drop(id: number, l: Listing, tick: number, state: AuctionEventState, parties: number[] = []): void {
    this.listings.delete(id);
    this.byItem.delete(l.item);
    this.emit(tick, id, state, null, parties);
  }

  /** Refund the top bidder's escrowed gold. */
  private refund(l: Listing, tick: number): void {
    if (l.topBidder !== 0 && l.topBid > 0) this.wallet.grant(l.topBidder, l.topBid, tick);
  }

  /**
   * Move the item seller -> buyer and the price (minus the house cut)
   * buyer -> seller. A top bidder's escrowed bid counts toward the price.
   * Returns an error string when anything fails, having moved nothing.
   */
  private settle(l: Listing, buyer: number, price: number, tick: number): string | null {
    // The winner's escrowed bid is already out of their wallet.
    const alreadyPaid = l.topBidder === buyer ? l.topBid : 0;
    const extra = price - alreadyPaid;
    // Validate everything before moving anything.
    if (!this.items.owns(l.seller, l.item)) {
      this.refund(l, tick);
      this.drop(l.id, l, tick, "expired", [l.seller, l.topBidder].filter((c) => c !== 0));
      return "the item is gone";
    }
    if (this.items.freeSlots(buyer) < 1) return "your bag is full";
    if (extra > 0 && !this.wallet.spend(buyer, extra, tick)) return "not enough gold";
    if (!this.items.move(l.item, l.seller, buyer)) {
      if (extra > 0) this.wallet.grant(buyer, extra, tick);
      return "the item couldn't move";
    }
    // The outbid party gets their escrow back; the winner's escrow was the payment.
    if (l.topBidder !== buyer) this.refund(l, tick);
    const fee = Math.floor(price * AUCTION_FEE);
    this.wallet.grant(l.seller, price - fee, tick);
    this.drop(l.id, l, tick, "sold", [l.seller, buyer]);
    return null;
  }
}
