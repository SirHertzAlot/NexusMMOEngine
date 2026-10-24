/**
 * Items on the wire (roadmap M3a, docs/ALPHA-PLAN.md): picking up and
 * dropping (C→S 0x13), the player's own bag (S→C 0x14), and what lies on
 * the ground (S→C 0x15). All JSON control messages, like chat and admin.
 *
 * A ground item is an ordinary entity — a Transform and an AssetRef (the
 * model it shows as) — so it streams like any prop. Its AssetRef carries
 * GROUND_ITEM_VARIANT, which is how clients (and the server, after a
 * restart) tell an item lying on the ground from scenery. What it is (its
 * name and rank) arrives in the drops message before the state that first
 * shows it, like character names (0x12).
 */

/** AssetRef.variant of an item lying on the ground (scenery uses 0). */
export const GROUND_ITEM_VARIANT = 0xffff;

/** The hand an item is held in ("both": two-handed; "none": not held). */
export type ItemHand = "main" | "off" | "both" | "none";

/**
 * C→S (catalog §0x13): act on an item.
 * - pickup: the ground item entity (decimal u64) into the bag;
 * - drop: an item from the bag onto the ground at the player's feet;
 * - equip: an item from the bag into its hand (M3b), swapping what was
 *   there back into the bag (a two-handed item empties both hands);
 *   armour goes to its slot instead (U10);
 * - use: eat or drink a provision from the bag (it restores hunger or
 *   thirst and is used up);
 * - unequip: what a hand holds, or an armour slot wears, back into the bag.
 */
export type ItemAction =
  | { kind: "item"; action: "pickup"; entity: string }
  | { kind: "item"; action: "drop"; item: number }
  | { kind: "item"; action: "equip"; item: number }
  | { kind: "item"; action: "use"; item: number }
  | { kind: "item"; action: "unequip"; hand: "main" | "off" }
  | { kind: "item"; action: "unequip"; slot: "head" | "chest" | "hands" | "legs" | "ring" | "amulet" };

/** One item as its holder sees it. */
export interface ItemView {
  /** Item instance id (stable while it exists). */
  id: number;
  /** Item definition id (the loot pool's composition id). */
  def: string;
  name: string;
  /** Item base: sword, axe, shield, … */
  base: string;
  rank: string;
  /** The rank's colour (#rrggbb), for names and borders. */
  color: string;
  hand: ItemHand;
  /** Armour slot it is worn in (U10); "none" for held items, absent from older servers. */
  slot?: string;
  /** The composed stats (power, armour, crit, …). */
  stats: Record<string, number>;
  /** Uses left before it breaks. */
  durability: number;
  /** The model it shows as (art catalog id), "" for the placeholder. */
  model: string;
}

/**
 * S→C (catalog §0x14): the player's bag, whole, after joining and after
 * every change. `bag[i]` is slot i's item, or null when the slot is empty.
 */
/** Armour slots, in wear order. */
export const ARMOUR_SLOT_NAMES = ["head", "chest", "hands", "legs", "ring", "amulet"] as const;
export type ArmourSlotName = (typeof ARMOUR_SLOT_NAMES)[number];

export interface InventoryMessage {
  kind: "inventory";
  bag: Array<ItemView | null>;
  /** What each hand holds (M3b); null: empty. A two-handed item is in `main`. */
  main?: ItemView | null;
  off?: ItemView | null;
  /** What each armour slot wears (U10); null: empty. Absent from older servers. */
  worn?: { [slot in ArmourSlotName]?: ItemView | null };
}

/**
 * S→C (catalog §0x15): what the ground items a snapshot or delta first
 * shows are. Rows: [entity wire id, name, rank, colour]. Sent before that
 * snapshot or delta, like 0x12 names.
 */
export interface DropsMessage {
  kind: "drops";
  drops: Array<[string, string, string, string]>;
}

/**
 * S->C (catalog 0x16): a blow struck at the hit frame of an attack.
 * `outcome` is "hit" (damage dealt), "blocked" (guard took most of it) or
 * "dodged" (the roll avoided it; amount 0). Entities are wire ids.
 */
export interface HitMessage {
  kind: "hit";
  tick: number;
  source: string;
  target: string;
  outcome: "hit" | "blocked" | "dodged";
  amount: number;
  /** The target's health after the blow, and its maximum. */
  health: number;
  max: number;
  /**
   * Body parts (M2): the part the blow landed on, its state after it, and
   * the parts it cut off (that part and everything below it). Absent on
   * dodges and on bodies without parts.
   */
  part?: string;
  state?: PartStateName;
  lost?: string[];
  /** A parry took the attacker's weapon (M4): it falls at the attacker's feet. */
  disarmed?: boolean;
}

/** A body part's state (docs/MASTERY-AND-COMBAT.md §4.2). */
export type PartStateName = "healthy" | "harmed" | "maimed" | "dismembered";

/**
 * S->C (catalog 0x18, M2): the player's own body, part by part: when it
 * changes (at most a few times a second), and on joining. `hp` is the
 * share of each part's own health left (0..1); `bleeding` an open wound.
 */
export interface BodyMessage {
  kind: "body";
  entity: string;
  parts: { id: string; name: string; hp: number; state: PartStateName; bleeding: boolean }[];
  blood: number;
  bloodMax: number;
}

/**
 * 0x17 life (M2b): an entity died or came back. "dead" carries the killer
 * (a wire id, or "" when nothing struck the last blow) and the tick the
 * entity will respawn at (0: it will not, a creature's corpse). "alive"
 * follows a respawn; the entity's new position and full health ride the
 * ordinary delta.
 */
export interface LifeMessage {
  kind: "life";
  tick: number;
  target: string;
  state: "dead" | "alive";
  killer?: string;
  respawnAt?: number;
  /** What killed it (dead, M2): a vital part (`part` names it), blood loss, or anything else. */
  cause?: "part" | "bleeding" | "other";
  part?: string;
}

/**
 * C->S (catalog 0x19, M3): how the player's next blows are struck. A
 * technique the rules know ("cut", "thrust", "bludgeon": a stick can cut,
 * a sword can bludgeon) and the body part aimed at. A field left out is
 * unchanged; null goes back to the default (the held item's own technique,
 * the body's root part). Refusals are 4005.
 */
export interface StanceMessage {
  kind: "stance";
  technique?: string | null;
  aim?: string | null;
}

/**
 * C->S (catalog 0x1a, M4): treat a body part with Medicine. `target` is the
 * patient's wire entity (absent: yourself); `part` a body part id (absent:
 * the most urgent: a stump, the worst bleeding, then a maimed part).
 * `stop: true` stops the treatment under way. Refusals are 4005.
 */
export interface TreatMessage {
  kind: "treat";
  target?: string;
  part?: string;
  stop?: boolean;
}

/** What a treatment does: stop a wound bleeding, close a stump, set a maimed part. */
export type TreatmentName = "bandage" | "stump" | "set";

/**
 * S->C (catalog 0x1a, M4): a treatment started (with how long it takes),
 * worked, failed, or stopped (the healer moved, fought, went out of reach,
 * or it was no longer needed). Sent to the healer and the patient.
 */
export interface TreatmentMessage {
  kind: "treatment";
  healer: string;
  patient: string;
  part: string;
  treatment: TreatmentName;
  state: "started" | "done" | "failed" | "stopped";
  seconds?: number;
}

/**
 * S->C (catalog 0x1b, M4): the player's own skills (0..max, and the
 * highest each has been), their familiarity with each item family used
 * (0..1), and the disciplines they have earned (`active`: the skills are at
 * its levels now, so what it unlocks can be used). `requires` names each
 * discipline's skill levels, and `toward` lists the ones not yet earned,
 * so the character sheet can show the way to them. Sent on joining and
 * whenever a value (to a tenth) changes.
 */
export interface SkillsMessage {
  kind: "skills";
  max: number;
  skills: { id: string; name: string; value: number; peak: number }[];
  familiarity: { family: string; value: number }[];
  disciplines: { id: string; name: string; active: boolean; unlocks: string[]; requires?: DisciplineRequirement[] }[];
  /** Disciplines not yet earned, in rules order (absent from older servers). */
  toward?: { id: string; name: string; unlocks: string[]; requires: DisciplineRequirement[] }[];
}

/** A skill (`skills` id) a discipline needs, and the level. */
export interface DisciplineRequirement {
  skill: string;
  level: number;
}

/**
 * C->S (catalog 0x1c): cast a spell (`spells.json` id) on `target` (a
 * character's wire id; absent: yourself), or `stop: true` the cast under
 * way. Refusals (unknown spell, too far, cooling down, not enough mana) are 4005.
 */
export interface CastMessage {
  kind: "cast";
  spell?: string;
  target?: string;
  stop?: boolean;
}

/** S->C (catalog 0x1c): the player's own mana pool, on joining and when it changes (to a whole point). */
export interface ManaMessage {
  kind: "mana";
  current: number;
  max: number;
}

/**
 * S->C (catalog 0x1c): a cast started (with how long it takes), completed
 * (`amount`: the health a heal restored), or stopped (the caster moved,
 * fought, the target went out of reach or died). Sent to caster and target.
 */
export interface SpellMessage {
  kind: "spell";
  caster: string;
  target: string;
  spell: string;
  state: "started" | "done" | "stopped";
  seconds?: number;
  amount?: number;
}

/**
 * C->S (catalog 0x1d, M5): ask to trigger an ability now.
 */
export interface AbilityTrigger {
  kind: "trigger";
  /** The ability id (server-defined; unknown ids are rejected). */
  id: string;
}

/**
 * S->C (catalog 0x1d, M5): how an ability trigger went. Broadcast like
 * hits — the client's ability bar and cast bar read it.
 */
export interface AbilityMessage {
  kind: "ability";
  tick: number;
  /** Who triggered, as a wire id. */
  entity: string;
  id: string;
  state: "casting" | "queued" | "fired" | "interrupted" | "rejected";
  /** Rejected: why ("unknown", "cooldown"). */
  reason?: string;
}

/** A telegraph's shape on the ground plane (catalog 0x1e, M5). */
export type TelegraphShapeView =
  | { kind: "circle"; x: number; z: number; r: number }
  | { kind: "cone"; x: number; z: number; yaw: number; range: number; halfAngle: number }
  | { kind: "rect"; x: number; z: number; yaw: number; length: number; width: number };

/**
 * S->C (catalog 0x1e, M5): a telegraph warned, resolved, or cancelled.
 * Broadcast — every client draws the warning; the server decides who the
 * resolution hits. Entities are wire ids.
 */
export interface TelegraphMessage {
  kind: "telegraph";
  tick: number;
  id: number;
  source: string;
  shape: TelegraphShapeView;
  state: "warned" | "resolved" | "cancelled";
  /** Warned: ticks until it lands. */
  ticksUntilHit?: number;
  /** Resolved: who was hit and how hard. */
  hits?: { target: string; amount: number }[];
}

/**
 * S->C (catalog 0x1f, M5): a buff or debuff was applied or removed.
 * Broadcast; the client's status frame filters to the entities it shows.
 */
export interface StatusMessage {
  kind: "status";
  tick: number;
  /** Who carries it, as a wire id. */
  entity: string;
  id: string;
  state: "applied" | "removed";
  stacks?: number;
}

/**
 * C->S (catalog 0x20, M5): duel actions. `challenge` names the target's
 * wire id; the rest act on the sender's own challenge or duel.
 */
export interface DuelAction {
  kind: "duel";
  action: "challenge" | "accept" | "decline" | "yield";
  target?: string;
}

/**
 * S->C (catalog 0x20, M5): duel events. Challenged/accepted/declined go
 * to the pair; started/ended broadcast like hits. Entities are wire ids.
 */
export interface DuelMessage {
  kind: "duel";
  tick: number;
  state: "challenged" | "accepted" | "declined" | "expired" | "started" | "ended";
  a: string;
  b: string;
  reason?: "blood" | "yield" | "timeout" | "declined" | "expired" | "cancelled";
  winner?: string;
}

/**
 * C->S (catalog 0x21, EC1): trade actions. `open` names the target's wire
 * id; the rest carry the trade id. `offer` sets offered gold and/or adds
 * or removes one bag item (any offer change resets both accepts).
 */
export interface TradeAction {
  kind: "trade";
  action: "open" | "offer" | "accept" | "cancel";
  target?: string;
  id?: number;
  gold?: number;
  addItem?: number;
  removeItem?: number;
}

/**
 * S->C (catalog 0x21, EC1): the full trade state, on every change. Sent
 * to the two parties only. The client renders its trade window from the
 * latest event. Character ids are wire ids; item ids are item ids.
 */
export interface TradeMessage {
  kind: "trade";
  tick: number;
  id: number;
  state: "open" | "offer" | "accepted" | "settled" | "cancelled" | "expired";
  a: string;
  b: string;
  aGold: number;
  bGold: number;
  aItems: number[];
  bItems: number[];
  aAccepted: boolean;
  bAccepted: boolean;
}

/**
 * S->C (catalog 0x21, EC1): the owner's gold balance, whenever it
 * changes. To the owner only — gold is private.
 */
export interface WalletMessage {
  kind: "wallet";
  tick: number;
  balance: number;
}

/**
 * C->S (catalog 0x21, EC1): vendor actions. `vendor` is the vendor
 * entity's wire id. `list` reads the price list; `buy` names an item def;
 * `sell` names a bag item instance.
 */
export interface VendorAction {
  kind: "vendor";
  action: "list" | "buy" | "sell";
  vendor?: string;
  def?: number;
  item?: number;
}

/**
 * S->C (catalog 0x21, EC1): vendor results, to the acting player only.
 * `listed` carries the price list; `bought`/`sold` confirm the trade and
 * its price.
 */
export interface VendorMessage {
  kind: "vendor";
  tick: number;
  vendor: string;
  state: "listed" | "bought" | "sold";
  name?: string;
  stock?: Array<{ def: number; name: string; price: number; quantity: number }>;
  buybackRate?: number;
  def?: number;
  item?: number;
  price?: number;
}

/**
 * C->S (catalog 0x21, EC1): auction house actions. `list` puts a bag item
 * up with a starting bid, an optional buyout, and a duration; `bid` and
 * `buyout` name a listing; `cancel` reclaims an unbid listing; `browse`
 * reads the order book.
 */
export interface AuctionAction {
  kind: "auction";
  action: "list" | "bid" | "buyout" | "cancel" | "browse";
  listing?: number;
  item?: number;
  amount?: number;
  startBid?: number;
  buyout?: number;
  durationMs?: number;
}

/**
 * S->C (catalog 0x21, EC1): auction results. `browse` carries the order
 * book; the rest name one listing. `bid`/`sold`/`expired`/`cancelled`
 * go to the parties involved; `listed` goes to the seller.
 */
export interface AuctionMessage {
  kind: "auction";
  tick: number;
  state: "listed" | "bid" | "sold" | "expired" | "cancelled" | "browse";
  listing?: {
    id: number;
    def: number;
    name: string;
    startBid: number;
    buyout: number;
    topBid: number;
    topBidder: number;
    expiresAt: number;
  };
  listings?: Array<{
    id: number;
    def: number;
    name: string;
    startBid: number;
    buyout: number;
    topBid: number;
    topBidder: number;
    expiresAt: number;
  }>;
}
