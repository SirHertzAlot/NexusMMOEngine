/**
 * economy module — server entry.
 *
 * Builds the EC1 economy domain: gold wallets (SQLite-backed), player-to-player
 * trades, NPC vendors, and the auction house. Trade/vendor/auction resolve
 * items lazily via `ctx.config.economy.itemsOf()` because the items service
 * is assembled separately; the wallet is published on `ctx.stores` so the
 * items module (assembled later) can hand it to its LootDropper.
 */
import path from "node:path";
import { WalletSystem } from "../../packages/engine-core/dist/src/economy/wallet.js";
import { SqliteWalletStore } from "../../packages/engine-core/dist/src/economy/wallet-store.js";
import { TradeSystem } from "../../packages/engine-core/dist/src/economy/trade.js";
import { VendorSystem } from "../../packages/engine-core/dist/src/economy/vendor.js";
import { AuctionSystem } from "../../packages/engine-core/dist/src/economy/auction.js";

export function createSystems(ctx) {
  const cfg = ctx.config?.economy ?? {};
  const dataDir = cfg.dataDir ?? ".";
  const itemsOf = cfg.itemsOf ?? (() => { throw new Error("economy: items not yet assembled"); });

  // Gold wallets (SQLite-backed). Built here; the items module reads it from
  // ctx.stores during assembly so creature kills can drop gold.
  const walletStore = new SqliteWalletStore(path.join(dataDir, "economy.db"));
  const wallet = new WalletSystem(walletStore);
  ctx.stores.wallet = wallet;
  ctx.stores.walletStore = walletStore;

  // Items move bag-to-bag through the ItemStore; held/worn gear stays out
  // of trades in v1.
  const bagItems = {
    owns: (c, item) => itemsOf().store.inBagOf(c, item),
    freeSlots: (c) => itemsOf().store.emptySlots(c),
    move: (item, from, to) => {
      if (!itemsOf().store.inBagOf(from, item)) return false;
      return itemsOf().store.putInBag(to, item) >= 0;
    },
    defOf: (item) => {
      const slot = itemsOf().store.slot(item);
      return slot < 0 ? -1 : itemsOf().store.defs[slot];
    },
    nameOf: (def) => itemsOf().defs.names[def] ?? `item ${def}`,
  };
  const trade = new TradeSystem(wallet, bagItems);
  // Vendors: NPC shops. Templates are content work (the `vendor` admin
  // command attaches them); the module only provides the mechanism.
  const vendor = new VendorSystem(wallet, {
    give: (c, def) => itemsOf().give(c, def).ok,
    take: (c, item) => {
      if (!itemsOf().store.inBagOf(c, item)) return false;
      itemsOf().store.destroy(item);
      return true;
    },
    defOf: bagItems.defOf,
    nameOf: bagItems.nameOf,
  });
  // Auction house: listings keep the item in the seller's bag (no escrow
  // limbo on restart); settlement moves it bag-to-bag.
  const auction = new AuctionSystem(wallet, bagItems);

  return { wallet, trade, vendor, auction };
}

export function dispose(ctx) {
  ctx.stores.walletStore?.close?.();
  delete ctx.stores.wallet;
  delete ctx.stores.walletStore;
}
