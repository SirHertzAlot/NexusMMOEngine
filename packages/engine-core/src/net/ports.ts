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
 * No port here names a system. Every payload is in `vocabulary.ts` (`ES5a`,
 * `ES5b`, `ES5d`), where neither the engine nor a kit owns it, and the only
 * other things these signatures mention are the protocol's wire views and
 * the engine's own `SimWorld`. So this file is the whole of the gateway's
 * demand, written out, and a kit can satisfy it without the engine ever
 * importing the kit.
 */

import type { PortDecl } from "@mmo-engine/sdk";
import type { AppearanceRules, BodyRules, DamageKind, Spell, SpellsRules } from "@mmo-engine/rules";
import type { ChestView, PouchMessage, ResourceNodeView } from "@mmo-engine/protocol";
import type { SimWorld } from "../world.js";
// Every payload below is shared vocabulary, not a system's own: a port names
// what a system announces, and naming it must not mean importing it.
import type {
  AbilityEvent,
  AuctionEvent,
  BlowResult,
  BodyView,
  ChestCheck,
  ChestResult,
  DuelEvent,
  GatherResult,
  HitEvent,
  LifeEvent,
  Listing,
  ListingView,
  RepairCheck,
  RepairResult,
  ResidentInfo,
  ResidentTier,
  StatusChange,
  TelegraphEvent,
  Trade,
  MagicSystemHooks,
  SpellEvent,
  TreatmentEvent,
  TradeEvent,
  TriggerResult,
  VendorDef,
  VendorView,
  WalletChange,
} from "../vocabulary.js";

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
 * Body parts, wounds and treatment (`ES5f`).
 *
 * The one port the gateway is *handed* rather than finds: `body` arrives as
 * an option, because `server.ts` resolves it from the service registry and
 * passes it down, and the dungeon runs without one. It is written out here
 * with the rest all the same, so that naming it is not naming `BodySystem` —
 * which was the last system class the gateway's own file mentioned.
 *
 * Making it a fifteenth table port, offered through `PORTS` like the others,
 * is a change to how the boot wires it rather than to what it is, and it can
 * follow on its own.
 */
export interface BodyPort {
  /** Whether `e` has a body at all (many entities do not). */
  has(sim: SimWorld, e: number): boolean;
  /** The owner's view of its body (the 0x1b `body` message). */
  view(e: number): BodyView;
  /** The body part ids, in rules order. */
  readonly parts: readonly string[];
  /** A blow of `amount` health points of `kind` lands on `part`. */
  applyBlow(sim: SimWorld, e: number, part: string, kind: DamageKind, amount: number): BlowResult;
  /**
   * How well `e`'s arm works, 0..1: a maimed arm hits softer, a lost one
   * not at all. The gateway asks before it lets a hand hold anything.
   */
  armFactor(sim: SimWorld, e: number, hand?: "main" | "off"): number;
  /** The hands that became useless (maimed, gone) since the last call. */
  drainDropped(): { e: number; hand: "main" | "off" }[];
  /** Entities whose lost parts changed since the last call, so their look is redrawn. */
  drainLooks(): number[];
  /** The appearance slots `e` no longer draws: those of its lost parts. */
  lostSlots(e: number): string[];
  /** Treatments started, finished and stopped since the last call (0x1a). */
  drainTreatments(): TreatmentEvent[];
  /** `healer` starts treating `patient` (its own part, or the most urgent). */
  treat(sim: SimWorld, healer: number, patient: number, part?: string): string | null;
  /** Stop `healer`'s treatment, if any. */
  stop(healer: number): void;
  /** New body rules (hot reload): every body starts over, whole. */
  setRules(sim: SimWorld, rules: BodyRules, appearance?: AppearanceRules): void;
}

/** Spells: casting, the mana pool, and what a cast announces (`ES5f`). */
export interface MagicPort {
  /** Give `e` a full pool now (otherwise it gets one on the next step). */
  ensure(sim: SimWorld, e: number): void;
  /** Casts started, completed and stopped since the last call (catalog 0x1c). */
  drainEvents(): SpellEvent[];
  /** Look up a spell definition by id. */
  spellOf(id: string): Spell | undefined;
  /** Fill `e`'s pool (the admin heal). */
  refill(sim: SimWorld, e: number): void;
  /** Stop `caster`'s cast, if any; nothing is spent. */
  stop(caster: number): void;
  /** `caster` starts casting on `target`; returns the refusal, or `null`. */
  cast(
    sim: SimWorld,
    caster: number,
    spellId: string,
    target?: number,
    path?: ReadonlyArray<readonly [number, number, number]>,
  ): string | null;
  /** New spells (rules hot reload); casts under way stop. */
  setRules(rules: SpellsRules): void;
  /** Attach or update the host's answers: status, alliances, creature info. */
  setHooks(hooks: MagicSystemHooks): void;
}

/**
 * The economy and world ports (`ES4d`, written out by `ES5d`).
 *
 * These eight were declared as `Pick<>` of the system that answers them
 * today, because the shapes they return lived beside that system and a
 * hand-written signature would have had to import it. `ES5d` moved the
 * shapes into the vocabulary, so each is now what it always meant: the
 * gateway's own demand, in its own words, satisfiable by anyone.
 *
 * Several take the engine's `SimWorld`, because what they answer depends on
 * where things are standing: a chest you are too far from does not open.
 * That is the engine handing a kit the world to read, which is the
 * direction the split allows.
 */

/** Player-to-player trade (catalog 0x21). */
export interface TradePort {
  /** This tick's trade movements, cleared by the read. */
  drainEvents(): TradeEvent[];
  /** Open a trade between `a` and `b`; null when either is already trading. */
  open(a: number, b: number, tick: number): number | null;
  /** Offer `amount` gold (0 clears); resets both accepts. */
  offerGold(id: number, char: number, amount: number, tick: number): boolean;
  /** Offer a bag item; resets both accepts. */
  offerItem(id: number, char: number, itemId: number, tick: number): boolean;
  /** Take an offered item back; resets both accepts. */
  removeItem(id: number, char: number, itemId: number, tick: number): boolean;
  /** Accept the current deal; settles once both sides have. */
  accept(id: number, char: number, tick: number): boolean;
  /** Cancel the trade, from either side, any time before settlement. */
  cancel(id: number, char: number, tick: number): boolean;
  /** A read-only snapshot of an open trade, for the world tier to settle. */
  pending(id: number): (Trade & { id: number }) | null;
  /** Finalise a trade the world tier has committed. */
  settleFromWorld(id: number, tick: number): boolean;
  /** Abort a trade whose world-tier commit was refused or never arrived. */
  failSettlement(id: number, tick: number): boolean;
}

/** A character's gold (catalog 0x21). */
export interface WalletPort {
  drainChanges(): WalletChange[];
  /** Gold `charId` holds (0 for strangers). */
  balanceOf(charId: number): number;
  grant(charId: number, amount: number, tick: number): boolean;
  spend(charId: number, amount: number, tick: number): boolean;
}

/** The auction house (catalog 0x21). */
export interface AuctionPort {
  drainEvents(): AuctionEvent[];
  /** List a bag item; null when the item cannot be listed. */
  list(
    seller: number,
    itemId: number,
    startBid: number,
    buyout: number,
    durationMs: number,
    tick: number,
  ): number | null;
  /** The current order book (a copy), soonest-expiring first. */
  browse(): ListingView[];
  /** Bid on a listing; returns an error string, or null on success. */
  bid(bidder: number, listingId: number, amount: number, tick: number): string | null;
  /** Buy a listing out; returns an error string, or null on success. */
  buyout(buyer: number, listingId: number, tick: number): string | null;
  /** The region-side terms of a buyout, for the world tier to commit. */
  buyoutTerms(buyer: number, listingId: number, tick: number): { error: string } | { listing: Listing };
  /** Cancel a listing and keep the item; only while nobody has bid. */
  cancel(seller: number, listingId: number, tick: number): string | null;
  /** Return the top bidder's escrow; the gold released. */
  releaseEscrow(listingId: number, tick: number): number;
  /** Finalise a listing the world tier has committed. */
  settleFromWorld(listingId: number, buyer: number, tick: number): boolean;
}

/** Vendors: their stock, and what a player buys and sells (catalog 0x26). */
export interface VendorPort {
  /** Every vendor entity, as an interaction target for the client. */
  views(sim: SimWorld, skip?: (entity: number) => boolean): ChestView[];
  /** The template behind an entity, if any. */
  vendorOf(entity: number): VendorDef | undefined;
  /** A vendor's price list with names resolved; null when closed or unknown. */
  list(entity: number): VendorView | null;
  buy(
    sim: SimWorld,
    buyerChar: number,
    buyerEntity: number,
    vendorEntity: number,
    def: number,
    tick: number,
  ): string | null;
  /** The region-side terms of a buy, for the world tier to commit. */
  buyTerms(
    sim: SimWorld,
    buyerEntity: number,
    vendorEntity: number,
    def: number,
  ): { error: string } | { vendorId: string; price: number };
  /** Record a settled buy against the vendor's stock. */
  commitBuyStock(vendorId: string, def: number): void;
  sell(
    sim: SimWorld,
    sellerChar: number,
    sellerEntity: number,
    vendorEntity: number,
    itemId: number,
    tick: number,
  ): string | null;
  /** The region-side terms of a sell, for the world tier to commit. */
  sellTerms(
    sim: SimWorld,
    sellerEntity: number,
    vendorEntity: number,
    itemId: number,
  ): { error: string } | { vendorId: string; def: number; price: number };
  create(id: string, name: string, buybackRate?: number): boolean;
  remove(id: string): boolean;
  /** Mark a world entity as a vendor of a defined template. */
  attach(entity: number, vendorId: string): boolean;
  /** Entity ids currently bound to a template. */
  attachedTo(id: string): number[];
  detach(entity: number): boolean;
  /** Close or reopen a template; closed shops refuse trade. */
  setEnabled(id: string, on: boolean): boolean;
  setStock(id: string, def: number, price: number, quantity: number): boolean;
  /** Template ids, for the admin console. */
  templateIds(): string[];
}

/** Resource nodes and the pouch they fill (catalog 0x27). */
export interface GatheringPort {
  /** Every node, as the client sees it. */
  views(sim: SimWorld): ResourceNodeView[];
  /** The nodes that changed since the last drain. */
  drainChanges(sim: SimWorld): ResourceNodeView[];
  /** Whether entity `eid` is a resource node. */
  has(eid: number): boolean;
  /** How many nodes there are, for the join snapshot's budget. */
  readonly size: number;
  /** Gather once from node `eid`; `dryRun` checks without taking. */
  gather(sim: SimWorld, holder: number, avatar: number, eid: number, dryRun?: boolean): GatherResult;
  /** How long one gather takes, seconds (the cast bar). */
  readonly castSeconds: number;
  /** A character's pouch, highest tier first, then by name. */
  pouchMessage(holder: number, gathered?: PouchMessage["gathered"]): PouchMessage;
}

/** World chests and the doors that open with them (catalog 0x27). */
export interface ChestPort {
  views(sim: SimWorld): ChestView[];
  /** The chests and doors that changed since the last drain. */
  drainChanges(sim: SimWorld): ChestView[];
  has(eid: number): boolean;
  /** Use chest or door `eid`: the checks again, then the effect. */
  open(sim: SimWorld, holder: number, avatar: number, eid: number): ChestResult;
  /** Whether `eid` may be used now, and how long it takes. Changes nothing. */
  check(sim: SimWorld, holder: number, avatar: number, eid: number): ChestCheck;
}

/** Breakable props, and mending them (catalog 0x27). */
export interface BreakPort {
  /** Every ruin, for a player joining. */
  views(sim: SimWorld): ChestView[];
  /** The ruins that appeared or were mended since the last drain. */
  drainChanges(sim: SimWorld): ChestView[];
  hasRuin(eid: number): boolean;
  /** Mend ruin `eid`: the checks again, then the materials go. */
  repair(sim: SimWorld, holder: number, avatar: number, eid: number): RepairResult;
  /** Whether a ruin may be mended now, and how long it takes. Changes nothing. */
  checkRepair(holder: number, avatar: number, eid: number): RepairCheck;
}

/** Settlement residents a player talks to (catalog 0x27). */
export interface ResidentPort {
  /** Whether `eid` is a resident, so a death leaves its body lying. */
  isResident(eid: number): boolean;
  /** The entity a resident has now (undefined: indoors, or over budget). */
  entityOf(npc: string): number | undefined;
  /** The resident an entity is (undefined: not one). */
  describe(eid: number): ResidentInfo | undefined;
  /** What the debugger shows: each town's tier, people and crowd slots. */
  summary(): {
    towns: Array<{ id: string; tier: ResidentTier; people: number; live: number; raid: boolean }>;
    live: number;
    walking: number;
  };
  /** What resident `eid` says now; undefined when it is not a resident. */
  talk(eid: number, tick: number): { npc: string; name: string; text: string } | undefined;
}

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
