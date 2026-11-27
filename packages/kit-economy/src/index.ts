/**
 * `@mmo-engine/kit-economy`: the trade, the things worth taking, and the
 * people who live in the world — the second of the engine's kits.
 *
 * Eleven modules and one dungeon factory. They were in
 * `@mmo-engine/engine-core` until the engine stopped being able to reach
 * them: `ES5f` made the gateway ask for `wallet`, `trade`, `vendors`,
 * `auction`, `gathering`, `chests`, `breaks` and `residents` by port rather
 * than by class, `ES5k`–`ES5m` moved the construction out into
 * `modules/gathering/`, `modules/props/`, `modules/economy/` and
 * `modules/residents/`, and what was left here was the location.
 *
 * Nothing in the engine imports this package. A game picks it up, forks it,
 * replaces one system in it, or ignores it and writes its own — see the
 * README for what each of those costs.
 *
 * ## What is in it
 *
 * | Export | What it does |
 * | --- | --- |
 * | `WalletSystem` | Gold: what a character has, and every change to it |
 * | `TradeSystem` | Two players swapping goods, and the escrow between them |
 * | `VendorSystem` | A shopkeeper's stock, prices and restocking |
 * | `AuctionSystem` | Listings, bids, settlement and expiry |
 * | `GatheringSystem` | A node worth mining, the pouch it fills, the regrow |
 * | `ChestSystem` | A container worth opening, and what it holds |
 * | `BreakSystem` | A barrel, crate, urn or building part worth breaking |
 * | `ResidentSystem` | A baked town's people living a day in the world |
 * | `lessonTerms` | What a master teaches a pupil, and what it costs |
 *
 * plus `SqliteWalletStore` and `SqliteGatheringStore` for what persists, and
 * `defaultDungeonWorld`, which fills a run's world slot
 * (`DungeonWorldContext` in the engine) with the chests, breakables and veins
 * this kit dresses a run with.
 */

export { WalletSystem, type WalletStore } from "./wallet.js";
export { SqliteWalletStore } from "./wallet-store.js";
export { TradeSystem, type TradeItems } from "./trade.js";
export { VENDOR_REACH, VendorSystem, type VendorItems } from "./vendor.js";
export { AUCTION_FEE, AuctionSystem, DEFAULT_LISTING_MS, MAX_LISTING_MS, type AuctionItems } from "./auction.js";

export { GatheringSystem, materialName } from "./gathering.js";
export type { GatheringOptions, GatheringStore } from "./gathering.js";
export { materialCountsOf, nodeStocksOf, SqliteGatheringStore, type NodeStock } from "./gathering-store.js";

export { BreakSystem, breakDefsOf, type BreakEvent, type BreakSystemOptions } from "./breaks.js";
export { ChestSystem, type ChestSystemOptions } from "./chests.js";

export { ResidentSystem, type ResidentNpc, type ResidentOptions, type ResidentPlacement, type ResidentTown } from "./resident-system.js";
export { lessonCost, lessonPoints, lessonTerms, loadLessons, type Lessons } from "./lessons.js";

export { defaultDungeonWorld } from "./dungeons/default-world.js";

/**
 * Shared vocabulary, re-exported for a reader who starts here.
 *
 * These are the engine's terms, not this kit's: the gateway speaks them to
 * whichever kit answers a port, so a game that replaces a system here keeps
 * using them. They are re-exported only so that someone reading this package
 * does not have to know which of the two owns a name — the engine is still
 * where they are declared, and `ES5a`/`ES5b`/`ES5d` are why.
 */
export type {
  AuctionEvent,
  AuctionEventState,
  ChestCheck,
  ChestResult,
  ChestSpec,
  GatherResult,
  LessonOffer,
  LessonTerms,
  Listing,
  ListingView,
  RepairCheck,
  RepairResult,
  ResidentInfo,
  ResidentTier,
  ResourceNodeSpec,
  Trade,
  TradeEvent,
  TradeState,
  VendorDef,
  VendorStock,
  VendorView,
  WalletChange,
} from "@mmo-engine/engine-core";
