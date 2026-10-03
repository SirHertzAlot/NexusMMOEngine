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
 * - unequip: what a hand holds back into the bag.
 */
export type ItemAction =
  | { kind: "item"; action: "pickup"; entity: string }
  | { kind: "item"; action: "drop"; item: number }
  | { kind: "item"; action: "equip"; item: number }
  | { kind: "item"; action: "unequip"; hand: "main" | "off" };

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
export interface InventoryMessage {
  kind: "inventory";
  bag: Array<ItemView | null>;
  /** What each hand holds (M3b); null: empty. A two-handed item is in `main`. */
  main?: ItemView | null;
  off?: ItemView | null;
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
