/**
 * The shared vocabulary: the few types the engine and a game's systems must
 * agree on, with no system behind them (roadmap ES5).
 *
 * A kit owns its systems; what it cannot own alone is the shape of what it
 * hands the rest of the world. `Weapon` is what a striker swings, and every
 * place that produces one — an item's definition, a creature's natural
 * weapon, a dungeon's loadout — has to describe it the same way as the
 * combat system that consumes it. `LifeEvent` is the same for a death: loot,
 * quests and a dungeon's run all react to one, none of them owning it.
 *
 * These lived in `combat.ts` and `death.ts`, which made nine files across
 * items, quests, dungeons and admin import a combat system's module to name
 * a type. Here they depend on the rules package and nothing else, so a kit
 * imports the vocabulary from the engine and the engine never imports the
 * kit — the direction the split needs.
 *
 * The same holds for what a system *announces*. A blow, an ability, a
 * telegraph, a status and a duel each end up on the wire, so the gateway has
 * to name their shapes — and while those shapes lived inside the systems,
 * naming one meant importing the system (`ES4c` left `net/ports.ts` doing
 * exactly that, as type imports). They are events, not behaviour: a game
 * that writes its own combat still raises hits the client can read, and a
 * game with no duels raises none. So they live here, and the systems that
 * raise them import them like everyone else.
 */

import type { DamageInput, DeathInput, DeathOutcome, PartState, TreatmentKind } from "@mmo-engine/rules";

/** What a striker swings: the rules technique, the item's physics and its reach (m). */
export interface Weapon {
  technique: string;
  item: DamageInput["item"];
  reach: number;
  /** The item family familiarity builds with (its base: "sword", "axe"); absent: none. */
  family?: string;
  /** Optional percentage of defender armour mitigation bypassed on hit (clamped 0..100). */
  armourPenetrationPct?: number;
  /** Optional percentage reduction of attack stamina drain (clamped 0..50). */
  staminaReductionPct?: number;
}

/** A death or a return, as the rest of the world hears about it. */
export interface LifeEvent {
  tick: number;
  target: number;
  state: "dead" | "alive";
  killer?: number;
  /** Tick the body respawns (dead events). */
  respawnAt?: number;
  outcome?: DeathOutcome;
  /** Where it fell (dead events). */
  x?: number;
  z?: number;
  /** What killed it (dead events). */
  cause?: DeathInput;
}

/* --- What a system announces (ES5b) --- */

/** A blow's outcome, for the gateway to tell clients. */
export interface HitEvent {
  tick: number;
  source: number;
  target: number;
  outcome: "hit" | "blocked" | "dodged";
  amount: number;
  /** With bodies: the part the blow landed on, its state after it, and the parts it cut off. */
  part?: string;
  state?: PartState;
  lost?: string[];
  /** A parry took the attacker's weapon (M4): what it holds in its main hand falls. */
  disarmed?: boolean;
}

/** How far a trigger got: fired now, queued behind the cast, or refused. */
export type TriggerResult = "fired" | "queued" | "rejected";

/** The states an ability passes through, as the client hears them. */
export type AbilityState = "casting" | "queued" | "fired" | "interrupted" | "rejected";

/** An ability's progress, for the gateway to tell clients. */
export interface AbilityEvent {
  tick: number;
  entity: number;
  id: string;
  state: AbilityState;
  /** Why a trigger was rejected ("cooldown", "unknown"). */
  reason?: string;
}

/** The ground an attack covers while it is telegraphed. */
export type TelegraphShape =
  | { kind: "circle"; x: number; z: number; r: number }
  | { kind: "cone"; x: number; z: number; yaw: number; range: number; halfAngle: number }
  | { kind: "rect"; x: number; z: number; yaw: number; length: number; width: number };

/** A telegraphed attack's warning, landing or cancellation. */
export interface TelegraphEvent {
  tick: number;
  id: number;
  source: number;
  shape: TelegraphShape;
  state: "warned" | "resolved" | "cancelled";
  /** Warned: ticks until it lands. Resolved: targets hit. */
  ticksUntilHit?: number;
  hits?: { target: number; amount: number }[];
}

/** A buff/debuff gained or lost, for the gateway. */
export interface StatusChange {
  tick: number;
  entity: number;
  id: string;
  state: "applied" | "removed";
  stacks?: number;
}

/** Why a duel ended. */
export type DuelEndReason = "blood" | "yield" | "timeout" | "declined" | "expired" | "cancelled";

/** A duel's progress, for the two fighters and anyone watching. */
export interface DuelEvent {
  tick: number;
  state: "challenged" | "accepted" | "declined" | "expired" | "started" | "ended";
  a: number;
  b: number;
  /** Ended: why. */
  reason?: DuelEndReason;
  /** Ended by blood/yield: the winner. */
  winner?: number;
}

/**
 * What the economy and world systems announce and hand out (`ES5d`).
 *
 * The eight economy and world ports were the last in `net/ports.ts` to name
 * a system: each was a `Pick<>` of the class that answers it, because the
 * shapes it returns — a trade's state, an order book row, a vendor's stock,
 * what a gather yielded — were declared beside that class. A `Pick<>` costs
 * no code, but it is still the engine saying "whatever `TradeSystem`
 * happens to be", which is precisely what a kit has to be free to replace.
 *
 * So the shapes come here, beside the combat events, on the same terms: a
 * record of what happened or a read-only view of what is, with no behaviour
 * and no system behind it. Nothing below mentions an entity's storage or
 * SimWorld; a game that writes its own trading still announces a settled
 * trade this way, and the gateway that puts it on the wire never learns
 * whose code raised it.
 */

/** Where a trade stands when it stops moving. */
export type TradeState = "open" | "settled" | "cancelled" | "expired";

/** A trade's progress, for both parties (catalog 0x21). */
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

/** An open trade: what each side has put up, and when it lapses. */
export interface Trade {
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

/** A character's gold after it moved, for the gateway (catalog 0x21). */
export interface WalletChange {
  tick: number;
  charId: number;
  balance: number;
}

/** A live auction listing, as the house keeps it. */
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

/** A listing as the order book shows it: no item instance, a resolved name. */
export interface ListingView {
  id: number;
  def: number;
  /** Human-readable name, resolved at browse time. */
  name: string;
  startBid: number;
  buyout: number;
  topBid: number;
  topBidder: number;
  expiresAt: number;
}

/** What became of a listing. */
export type AuctionEventState = "listed" | "bid" | "sold" | "expired" | "cancelled";

/** A listing's progress, for the parties to it (catalog 0x21). */
export interface AuctionEvent {
  tick: number;
  id: number;
  state: AuctionEventState;
  view: ListingView | null;
  /** Character ids to notify (seller, winner, outbid bidder). */
  parties: number[];
}

/** One line of a vendor's stock. */
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

/** A vendor template: what it sells, and on what terms. */
export interface VendorDef {
  id: string;
  name: string;
  stock: VendorStock[];
  /** Fraction of the listed price paid on buyback (0–1). */
  buybackRate: number;
  /** Closed vendors refuse list/buy/sell until re-enabled. */
  enabled: boolean;
}

/** A vendor's price list as a shopper sees it: no `enabled` to read. */
export interface VendorView {
  id: string;
  name: string;
  stock: VendorStock[];
  buybackRate: number;
}

/** What one gather yielded, or why it yielded nothing (catalog 0x27). */
export type GatherResult =
  | { ok: true; material: string; name: string; count: number }
  | { ok: false; error: string };

/** What opening a chest or door gave, or why it gave nothing (catalog 0x27). */
export type ChestResult = { ok: true; items: number } | { ok: false; error: string };

/** Whether a chest or door may be used now, and how long it takes. */
export type ChestCheck = { ok: true; castSeconds: number; spell: string } | { ok: false; error: string };

/** Whether a mend succeeded (catalog 0x27). */
export type RepairResult = { ok: true } | { ok: false; error: string };

/** Whether a ruin may be mended now, and how long it takes. */
export type RepairCheck = { ok: true; castSeconds: number; spell: string } | { ok: false; error: string };

/** How closely a town's residents are simulated. */
export type ResidentTier = "full" | "coarse" | "none";

/** What a resident is, for the interaction system (R5). */
export interface ResidentInfo {
  npc: string;
  town: string;
  role: string;
  class: string;
  cohort: string;
  mastery?: string;
  grandMaster?: boolean;
}

/**
 * What the host asks of a game's fighting, and what it hears back (`ES5f`).
 *
 * The engine's own wiring held the last five of these. `server.ts` built a
 * `CombatSkills` to hand a game's combat the skills behind a blow;
 * `services.ts` and the region gateway named `BodySystem` to reach the body
 * it was given; a warning cone the host asks for is a `TelegraphSpec`. All
 * five are things the engine and a game's systems must agree on with no
 * system behind them, so they belong here with the rest.
 */

/** The skills behind a blow (M3c): what a character knows, and using it trains it. */
export interface CombatSkills {
  /** The entity's skill `id`, 0..skills.max. */
  get(e: number, id: string): number;
  /** One use of skill `id` at `difficulty` (0..1) against target `key`. */
  train(e: number, id: string, difficulty: number, key: number): void;
  /** The skill a technique runs on ("cut" -> "cutting"), if any. */
  techniqueSkill(technique: string): string | undefined;
  /** Familiarity with an item family, 0..1 (M4); absent: 0. */
  familiarity?(e: number, family: string): number;
  /** One blow with an item of `family` (M4). */
  useFamily?(e: number, family: string): void;
  /** Whether `e` can use a special technique now ("disarm"), from its disciplines (M4). */
  knows?(e: number, technique: string): boolean;
}

/** One part, for the owner's `body` message. */
export interface PartView {
  id: string;
  name: string;
  /** Share of the part's health left, 0..1. */
  hp: number;
  state: PartState;
  bleeding: boolean;
}

/** A body as its owner sees it (the 0x1b `body` message). */
export interface BodyView {
  parts: PartView[];
  blood: number;
  bloodMax: number;
}

/** What a blow did to the part it landed on. */
export interface BlowResult {
  part: string;
  state: PartState;
  /** Parts lost to this blow (the part and everything below it), when it dismembered. */
  lost: string[];
}

/** A treatment's progress, for the healer and the patient (0x1a). */
export interface TreatmentEvent {
  healer: number;
  patient: number;
  part: string;
  treatment: TreatmentKind;
  state: "started" | "done" | "failed" | "stopped";
  /** Seconds it takes (started). */
  seconds?: number;
}

/** A telegraphed attack the host asks for: where it lands, when, and for how much. */
export interface TelegraphSpec {
  source: number;
  shape: TelegraphShape;
  /** ms of warning before it lands. */
  warnMs: number;
  /** Fixed damage; when `damageOf` is set it wins. */
  amount: number;
  /** Per-target damage (the rules' computeDamage, usually). */
  damageOf?: (target: number) => number;
}

/**
 * What a game's magic announces, and what the host tells it (`ES5f`).
 *
 * The same story as the body: `services.ts`, `server.ts` and the gateway all
 * named `MagicSystem` to reach the magic they were handed. A cast's progress
 * reaches the client, and the hooks are the host's own answers — whether two
 * entities are allies, what species something is — so neither belongs to the
 * system that reads them.
 */

/** A cast's progress, for the caster and the target. */
export interface SpellEvent {
  caster: number;
  target: number;
  spell: string;
  state:
    | "started"
    | "done"
    | "stopped"
    | "shield-hit"
    | "shield-expired"
    | "ice-ring-spawn"
    | "ice-ring-break";
  /** Seconds it takes (started). */
  seconds?: number;
  /** Health restored (done, heal), damage dealt (done, damage), ward capacity, or trap radius. */
  amount?: number;
  /** Remaining ward fraction [0..1] on shield-hit. */
  hp01?: number;
  /** Object-space hit offset [x, y, z] on shield-hit. */
  hitPos?: [number, number, number];
  /** Authoritative clamped spline waypoints for spline-drawn spells. */
  path?: Array<[number, number, number]>;
  /** World-space detonation / terminus point [x, y, z] for spline spells. */
  detonateAt?: [number, number, number];
  /** Effective AoE / pillar radius for VFX scaling (e.g. 2x target radius). */
  radiusM?: number;
}

export interface MagicCreatureInfo {
  kind?: string;
  biome?: string;
  coldImmune?: boolean;
  iceVulnerable?: boolean;
}

export interface MagicSystemHooks {
  /** Apply a timed debuff (`ignite`, `frostbite`, etc.) via StatusSystem. */
  applyStatus?: (target: number, statusId: string, source: number, tick: number) => void;
  /** Return whether `e` is a player character (default: `hasComponent(ecs, CharacterRef, e)`). */
  isPlayer?: (e: number) => boolean;
  /** Return true if `a` and `b` are friendly / party / guild mates. */
  areAllies?: (a: number, b: number) => boolean;
  /** Creature species & current biome info for elemental immunity/vulnerability. */
  creatureInfo?: (e: number) => MagicCreatureInfo | undefined;
}
