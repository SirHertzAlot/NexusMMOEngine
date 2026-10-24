/**
 * VendorSystem — NPC shops. A vendor is a world entity with a price list:
 * players buy item defs for gold and sell bag items back for gold.
 *
 * - `define` registers a vendor template (id, name, stock with prices).
 * - `attach` marks a world entity as a vendor of that template.
 * - `buy`: the buyer pays the listed price; a fresh item of the def goes
 *   into their bag. Stock is infinite (-1) or decrements per sale.
 * - `sell`: the vendor buys back defs it stocks, at
 *   `floor(price * buybackRate)`; the item instance is destroyed. Defs the
 *   vendor doesn't stock are refused ("doesn't want that").
 *
 * Both directions check reach (4 m) against the vendor entity, the
 * buyer's gold, and bag room. Every failure returns an error string;
 * success returns null. Gold moves through the WalletSystem; items through
 * the VendorItems hook (wired to the ItemService in server.ts).
 *
 * Vendors never run out of gold. There is no restock timer in v1 — an
 * emptied finite stock stays empty until the template is redefined.
 */

import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import * as C from "../components.js";
import type { WalletSystem } from "./wallet.js";
import type { ChestView } from "@mmo-engine/protocol";

/** How the vendor moves item instances (wired to the ItemService). */
export interface VendorItems {
  /** Create `def` straight into `charId`'s bag; false when the bag is full. */
  give(charId: number, def: number): boolean;
  /** Take `itemId` out of `charId`'s bag and destroy it; false when not owned. */
  take(charId: number, itemId: number): boolean;
  /** The def id behind an item instance; -1 when unknown. */
  defOf(itemId: number): number;
  /** Human-readable name for a def, for the shop list. */
  nameOf(def: number): string;
}

export interface VendorStock {
  /** Item def id. */
  def: number;
  /** Human-readable name; resolved at list time, absent on stored lines. */
  name?: string;
  /** Gold the vendor charges. */
  price: number;
  /** Units for sale; -1 means infinite. */
  quantity: number;
}

export interface VendorDef {
  id: string;
  name: string;
  stock: VendorStock[];
  /** Fraction of the listed price paid on buyback (0–1). */
  buybackRate: number;
  /** Closed vendors refuse list/buy/sell until re-enabled. */
  enabled: boolean;
}

export interface VendorView {
  id: string;
  name: string;
  stock: VendorStock[];
  buybackRate: number;
}

/** How close a buyer must stand to the vendor (meters). */
export const VENDOR_REACH = 4;

export class VendorSystem implements SimSystem {
  readonly name = "vendor";
  private readonly defs = new Map<string, VendorDef>();
  /** Entity id -> vendor template id. */
  private readonly vendors = new Map<number, string>();

  constructor(
    private readonly wallet: WalletSystem,
    private readonly items: VendorItems,
  ) {}

  /** Register (or replace) a vendor template. */
  define(def: Omit<VendorDef, "enabled"> & { enabled?: boolean }): void {
    if (!def.id || def.buybackRate < 0 || def.buybackRate > 1) return;
    const stock = def.stock.filter((s) => s.price > 0 && s.quantity !== 0 && Number.isInteger(s.price));
    this.defs.set(def.id, { enabled: true, ...def, stock: stock.map((s) => ({ ...s })) });
  }

  /** Create an empty template (stocked later via setStock). */
  create(id: string, name: string, buybackRate = 0.3): boolean {
    if (!id || this.defs.has(id) || buybackRate < 0 || buybackRate > 1) return false;
    this.defs.set(id, { id, name, stock: [], buybackRate, enabled: true });
    return true;
  }

  /** Add or update one stock line; false when the template is unknown. */
  setStock(id: string, def: number, price: number, quantity: number): boolean {
    const v = this.defs.get(id);
    if (!v || price <= 0 || !Number.isInteger(price) || quantity === 0) return false;
    const line = v.stock.find((s) => s.def === def);
    if (line) {
      line.price = price;
      line.quantity = quantity;
    } else {
      v.stock.push({ def, price, quantity });
    }
    return true;
  }

  /** Template ids, for the admin console. */
  templateIds(): string[] {
    return [...this.defs.keys()];
  }

  /** Mark a world entity as a vendor of a defined template. */
  attach(entity: number, vendorId: string): boolean {
    if (!this.defs.has(vendorId)) return false;
    this.vendors.set(entity, vendorId);
    return true;
  }

  /** Unbind a vendor from an entity; the template itself survives. */
  detach(entity: number): boolean {
    return this.vendors.delete(entity);
  }

  /** Close (`on=false`) or reopen a template; closed shops refuse trade. */
  setEnabled(id: string, on: boolean): boolean {
    const v = this.defs.get(id);
    if (!v) return false;
    v.enabled = on;
    return true;
  }

  /** Delete a template and unbind it from every entity. */
  remove(id: string): boolean {
    if (!this.defs.delete(id)) return false;
    for (const [entity, vid] of [...this.vendors]) {
      if (vid === id) this.vendors.delete(entity);
    }
    return true;
  }

  /** Entity ids currently bound to a template. */
  attachedTo(id: string): number[] {
    const out: number[] = [];
    for (const [entity, vid] of this.vendors) {
      if (vid === id) out.push(entity);
    }
    return out;
  }

  /** The vendor template behind an entity, if any. */
  vendorOf(entity: number): VendorDef | undefined {
    const id = this.vendors.get(entity);
    return id === undefined ? undefined : this.defs.get(id);
  }

  /** Every entity that is a vendor, as interaction targets for the client (E opens the shop). */
  views(sim: SimWorld): ChestView[] {
    return [...this.vendors.keys()].map((e) => ({ entity: String(sim.wireId(e)), x: C.Transform.px[e]!, z: C.Transform.pz[e]!, open: false, kind: "vendor" as const }));
  }

  /** The vendor's current price list (a copy), with names resolved. Null when unknown or closed. */
  list(entity: number): VendorView | null {
    const def = this.vendorOf(entity);
    if (!def || !def.enabled) return null;
    return {
      id: def.id,
      name: def.name,
      buybackRate: def.buybackRate,
      stock: def.stock.map((s) => ({ ...s, name: this.items.nameOf(s.def) })),
    };
  }

  /**
   * The region-side terms of a buy (slice A2): every check that does
   * not move value — the vendor exists and is open, the buyer is in
   * reach, the def is stocked and not sold out. The fleet-mode commit
   * path validates with this, then routes the value movement itself
   * through the world tier; `buy` (standalone) settles locally.
   */
  buyTerms(
    sim: SimWorld,
    buyerEntity: number,
    vendorEntity: number,
    def: number,
  ): { error: string } | { vendorId: string; price: number } {
    const v = this.vendorOf(vendorEntity);
    if (!v) return { error: "not a vendor" };
    if (!v.enabled) return { error: "that shop is closed" };
    if (!this.inReach(sim, buyerEntity, vendorEntity)) return { error: "too far from the vendor" };
    const line = v.stock.find((s) => s.def === def);
    if (!line) return { error: "the vendor doesn't sell that" };
    if (line.quantity === 0) return { error: "out of stock" };
    return { vendorId: v.id, price: line.price };
  }

  /**
   * Record a settled buy against the vendor's stock (slice A2): a
   * finite line decrements. Called only after the transaction has
   * committed — locally in `buy`, at the world tier in fleet mode.
   */
  commitBuyStock(vendorId: string, def: number): void {
    const line = this.defs.get(vendorId)?.stock.find((s) => s.def === def);
    if (line && line.quantity > 0) line.quantity -= 1;
  }

  /**
   * Buy one unit of `def` from the vendor at `vendorEntity`. Returns an
   * error string, or null on success.
   */
  buy(sim: SimWorld, buyerChar: number, buyerEntity: number, vendorEntity: number, def: number, tick: number): string | null {
    const terms = this.buyTerms(sim, buyerEntity, vendorEntity, def);
    if ("error" in terms) return terms.error;
    if (!this.wallet.spend(buyerChar, terms.price, tick)) return "not enough gold";
    if (!this.items.give(buyerChar, def)) {
      // Refund: the bag was full.
      this.wallet.grant(buyerChar, terms.price, tick);
      return "your bag is full";
    }
    this.commitBuyStock(terms.vendorId, def);
    return null;
  }

  /**
   * The region-side terms of a sell (slice A2): like `buyTerms`, every
   * check that does not move value, ending with the buyback price.
   */
  sellTerms(
    sim: SimWorld,
    sellerEntity: number,
    vendorEntity: number,
    itemId: number,
  ): { error: string } | { vendorId: string; def: number; price: number } {
    const v = this.vendorOf(vendorEntity);
    if (!v) return { error: "not a vendor" };
    if (!v.enabled) return { error: "that shop is closed" };
    if (!this.inReach(sim, sellerEntity, vendorEntity)) return { error: "too far from the vendor" };
    const def = this.items.defOf(itemId);
    if (def < 0) return { error: "no such item" };
    const line = v.stock.find((s) => s.def === def);
    if (!line) return { error: "the vendor doesn't want that" };
    const price = Math.floor(line.price * v.buybackRate);
    if (price <= 0) return { error: "the vendor doesn't want that" };
    return { vendorId: v.id, def, price };
  }

  /**
   * Sell the bag item `itemId` to the vendor at `vendorEntity`. Returns an
   * error string, or null on success.
   */
  sell(sim: SimWorld, sellerChar: number, sellerEntity: number, vendorEntity: number, itemId: number, tick: number): string | null {
    const terms = this.sellTerms(sim, sellerEntity, vendorEntity, itemId);
    if ("error" in terms) return terms.error;
    if (!this.items.take(sellerChar, itemId)) return "you don't have that";
    this.wallet.grant(sellerChar, terms.price, tick);
    return null;
  }

  step(_sim: SimWorld, _dt: number): void {}

  private inReach(sim: SimWorld, a: number, b: number): boolean {
    const T = C.Transform;
    const dx = T.px[a] - T.px[b];
    const dz = T.pz[a] - T.pz[b];
    return dx * dx + dz * dz <= VENDOR_REACH * VENDOR_REACH;
  }
}
