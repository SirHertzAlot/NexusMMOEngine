/**
 * The ports the region gateway reads, and what it asks of each.
 *
 * The gateway used to find these systems with `instanceof`, which meant a
 * value import of every class it looked for — `CombatSystem`, `DuelSystem`,
 * and so on. Those are the systems a game is most likely to replace, and the
 * ones the engine/game split moves into kits, so the import was the thing
 * standing between them and a package of their own.
 *
 * Here the gateway names what it needs instead. The table is the host's own
 * list — a game with its own entry point writes its own and uses none of
 * this — and each row carries the methods the gateway calls, so a system
 * that offers a port it cannot answer ends the boot rather than the tick.
 *
 * Most event payloads are still declared beside the systems that raise them
 * and imported here as types only, so nothing in this file reaches a system
 * at runtime. `LifeEvent` already moved to `vocabulary.ts` (`ES5a`); the
 * rest follow it, which is the step that lets the systems themselves move
 * out.
 */

import type { PortDecl } from "@mmo-engine/sdk";
import type { AuctionSystem } from "../economy/auction.js";
import type { TradeSystem } from "../economy/trade.js";
import type { VendorSystem } from "../economy/vendor.js";
import type { WalletSystem } from "../economy/wallet.js";
import type { GatheringSystem } from "../gathering/index.js";
import type { BreakSystem, ChestSystem } from "../interact/index.js";
import type { ResidentSystem } from "../residents/index.js";
import type { AbilityEvent, TriggerResult } from "../abilities.js";
import type { HitEvent } from "../combat.js";
import type { DuelEvent } from "../duel.js";
import type { StatusChange } from "../status.js";
import type { TelegraphEvent } from "../telegraph.js";
// LifeEvent is shared vocabulary now (#753), not the death system's own.
import type { LifeEvent } from "../vocabulary.js";

/** The blows struck this tick, and the stance a player fights in. */
export interface CombatPort {
  /** This tick's blows, cleared by the read (catalog 0x16). */
  drainHits(): HitEvent[];
  /** Set a fighter's technique and aim; returns the refusal, or `null`. */
  setStance(
    entity: number,
    technique: string | null | undefined,
    aim: string | null | undefined,
  ): string | null;
}

/** Deaths and respawns (catalog 0x17). */
export interface LifePort {
  drainEvents(): LifeEvent[];
}

/** Abilities a player triggers, and what became of them (catalog 0x1d). */
export interface AbilityPort {
  drainEvents(): AbilityEvent[];
  /** Ask for an ability; the outcome drains as an event next tick. */
  trigger(entity: number, id: string, tick: number): TriggerResult;
}

/** Telegraphed attacks: warning, resolution, cancellation (catalog 0x1e). */
export interface TelegraphPort {
  drainEvents(): TelegraphEvent[];
}

/** Buffs and debuffs applied or removed (catalog 0x1f). */
export interface StatusPort {
  drainChanges(): StatusChange[];
}

/** The duel flow a player drives from their client (catalog 0x20). */
export interface DuelPort {
  drainEvents(): DuelEvent[];
  challenge(a: number, b: number, tick: number): boolean;
  accept(entity: number, tick: number): boolean;
  decline(entity: number, tick: number): boolean;
  yield(entity: number, tick: number): boolean;
  /** Drop a leaver's duel and challenges (disconnect, logout, migration). */
  forget(entity: number, tick: number): void;
}


/**
 * The economy and world ports (`ES4d`).
 *
 * These eight are declared as `Pick<>` of the system that answers them
 * today, rather than retyped by hand: the gateway calls 70-odd methods
 * across them, and a hand-written signature that quietly widens one of
 * those is a bug the compiler would then stop finding. The member list is
 * still the point — it is the gateway's whole demand on each system, in one
 * place, and the `import type` carries no code. Writing them out as plain
 * interfaces is part of the same step that moves the event payloads
 * (`ES5b`), once the systems themselves have somewhere to go.
 */

/** Player-to-player trade (catalog 0x21). */
export type TradePort = Pick<
  TradeSystem,
  "drainEvents" | "open" | "offerGold" | "offerItem" | "removeItem" | "accept" | "cancel" | "pending" | "settleFromWorld" | "failSettlement"
>;

/** A character's gold (catalog 0x21). */
export type WalletPort = Pick<WalletSystem, "drainChanges" | "balanceOf" | "grant" | "spend">;

/** The auction house (catalog 0x21). */
export type AuctionPort = Pick<
  AuctionSystem,
  "drainEvents" | "list" | "browse" | "bid" | "buyout" | "buyoutTerms" | "cancel" | "releaseEscrow" | "settleFromWorld"
>;

/** Vendors: their stock, and what a player buys and sells (catalog 0x26). */
export type VendorPort = Pick<
  VendorSystem,
  "views" | "vendorOf" | "list" | "buy" | "buyTerms" | "commitBuyStock" | "sell" | "sellTerms" | "create" | "remove" | "attach" | "attachedTo" | "detach" | "setEnabled" | "setStock" | "templateIds"
>;

/** Resource nodes and the pouch they fill (catalog 0x27). */
export type GatheringPort = Pick<
  GatheringSystem,
  "views" | "drainChanges" | "has" | "size" | "gather" | "castSeconds" | "pouchMessage"
>;

/** World chests and the doors that open with them (catalog 0x27). */
export type ChestPort = Pick<ChestSystem, "views" | "drainChanges" | "has" | "open" | "check">;

/** Breakable props, and mending them (catalog 0x27). */
export type BreakPort = Pick<BreakSystem, "views" | "drainChanges" | "hasRuin" | "repair" | "checkRepair">;

/** Settlement residents a player talks to (catalog 0x27). */
export type ResidentPort = Pick<ResidentSystem, "isResident" | "entityOf" | "describe" | "summary" | "talk">;

/** Every port the gateway reads, by the name a system offers it under. */
export interface GatewayPorts {
  combat: CombatPort;
  life: LifePort;
  abilities: AbilityPort;
  telegraphs: TelegraphPort;
  statuses: StatusPort;
  duels: DuelPort;
  trade: TradePort;
  wallet: WalletPort;
  auction: AuctionPort;
  vendors: VendorPort;
  gathering: GatheringPort;
  chests: ChestPort;
  breaks: BreakPort;
  residents: ResidentPort;
}

/**
 * One row per port, with the methods the gateway calls on it.
 *
 * Keep the method lists in step with the interfaces above: they are what the
 * boot checks, and a method the gateway starts calling without adding it
 * here is a method a half-finished provider can get away with not having.
 */
export const GATEWAY_PORTS: readonly PortDecl[] = [
  { key: "combat", methods: ["drainHits", "setStance"], what: "the blows struck this tick, and player stance" },
  { key: "life", methods: ["drainEvents"], what: "deaths and respawns" },
  { key: "abilities", methods: ["drainEvents", "trigger"], what: "abilities a player triggers" },
  { key: "telegraphs", methods: ["drainEvents"], what: "telegraphed attack warnings" },
  { key: "statuses", methods: ["drainChanges"], what: "buffs and debuffs" },
  {
    key: "duels",
    methods: ["drainEvents", "challenge", "accept", "decline", "yield", "forget"],
    what: "the duel flow",
  },
  {
    key: "trade",
    methods: ["drainEvents", "open", "offerGold", "offerItem", "removeItem", "accept", "cancel", "pending", "settleFromWorld", "failSettlement"],
    what: "player-to-player trade",
  },
  { key: "wallet", methods: ["drainChanges", "balanceOf", "grant", "spend"], what: "a character's gold" },
  {
    key: "auction",
    methods: ["drainEvents", "list", "browse", "bid", "buyout", "buyoutTerms", "cancel", "releaseEscrow", "settleFromWorld"],
    what: "the auction house",
  },
  {
    key: "vendors",
    methods: ["views", "vendorOf", "list", "buy", "buyTerms", "commitBuyStock", "sell", "sellTerms", "create", "remove", "attach", "attachedTo", "detach", "setEnabled", "setStock", "templateIds"],
    what: "vendors and their stock",
  },
  {
    key: "gathering",
    methods: ["views", "drainChanges", "has", "gather", "pouchMessage"],
    fields: ["size", "castSeconds"],
    what: "resource nodes and the pouch",
  },
  { key: "chests", methods: ["views", "drainChanges", "has", "open", "check"], what: "world chests and doors" },
  { key: "breaks", methods: ["views", "drainChanges", "hasRuin", "repair", "checkRepair"], what: "breakable props" },
  { key: "residents", methods: ["isResident", "entityOf", "describe", "summary", "talk"], what: "settlement residents" },
];
