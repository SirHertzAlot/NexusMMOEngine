/**
 * ItemService (roadmap M3a): items in the world — dropping them on the
 * ground, picking them up, putting them in bags, and clearing the ground.
 *
 * A ground item is an entity with a Transform (lying flat, at the ground
 * height), an AssetRef (its model, variant GROUND_ITEM_VARIANT) and a
 * server-only WorldItem row. The rules (content/rules/loot.json) set who
 * may take a drop and when (decision D2: the one who earned it for 30 s,
 * then anyone), when it disappears (5 min), the pickup range, and the bag
 * size. Every request is validated here, server-side: a client can only
 * ask (decision D3: a key press near the item).
 *
 * As a SimSystem it expires ground items whose time is up; it allocates
 * nothing per tick (a query, and a despawn only when one is due).
 */

import { addComponent, defineQuery, entityExists, hasComponent } from "bitecs";
import { GROUND_ITEM_VARIANT, type DropsMessage, type InventoryMessage, type ItemView } from "@mmo-engine/protocol";
import type { LootRules } from "@mmo-engine/rules";
import { AssetRef, Transform, WorldItem } from "../components.js";
import { parseWireEntityId } from "../entity-id.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import type { Held } from "@mmo-engine/art/character";
import { HAND_CODE, HAND_NAME, type ItemDefs } from "./item-defs.js";
import { ItemLedger, LedgerKind, type ItemRow } from "../persist/item-ledger.js";
import { ARMOUR_SLOTS, ArmourSlot, HandSlot, ItemStore, ItemWhere, type ArmourSlotName } from "./item-store.js";

/** Height above the ground a lying item rests at, metres. */
const REST_HEIGHT = 0.06;

/**
 * The fleet-mode grant executor (slice A2): routes one grant's commit
 * through the world-tier `lootGrant` operation. Supplied by the
 * server's fleet wiring (a WorldAtomicOps over the region's
 * WorldClient); absent in standalone mode, when grants are local.
 * Returns the settled outcome: a rejection is a value, an outage
 * throws — the grant path fails closed on both.
 */
export interface AtomicGrantExecutor {
  loot(
    character: number,
    sourceId: string,
    instanceId: string,
    def: number,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface ItemServiceOptions {
  defs: ItemDefs;
  loot: LootRules;
  tickHz: number;
  /** Ground height at (x, z), for placing drops; absent: y = 0. */
  groundHeightAt?: (x: number, z: number) => number;
  /** Rank ids lowest first (the loot ladder), for the starter weapon. Default: none (any rank). */
  rankOrder?: readonly string[];
  /** The item base a new character starts holding (M3b). Default null (none); the game pack opts in by naming a base. */
  starterBase?: string | null;
  /**
   * Slice A2 (fleet mode): the world-tier grant executor used by
   * `giveGranted`. Absent: `giveGranted` is exactly `give`.
   */
  atomicGrant?: AtomicGrantExecutor;
}

export type ItemResult = { ok: true; message: string } | { ok: false; error: string };

const worldItems = defineQuery([WorldItem]);

export class ItemService implements SimSystem {
  readonly name = "items";
  readonly defs: ItemDefs;
  readonly store: ItemStore;
  private loot: LootRules;
  private readonly tickHz: number;
  private readonly groundHeightAt: (x: number, z: number) => number;
  /** Ground item id -> its entity slot. */
  private readonly entityOf = new Map<number, number>();
  /** Ground item ids in drop order (oldest first), for the ground cap. */
  private readonly groundOrder: number[] = [];
  private readonly rankOrder: readonly string[];
  private readonly starterBase: string | null;
  private readonly atomicGrant: AtomicGrantExecutor | null;
  /** Characters already given their starter weapon this run. */
  private readonly outfitted = new Set<number>();

  constructor(o: ItemServiceOptions) {
    this.defs = o.defs;
    this.loot = o.loot;
    this.tickHz = o.tickHz;
    this.groundHeightAt = o.groundHeightAt ?? (() => 0);
    this.store = new ItemStore(o.loot.bagSlots);
    this.rankOrder = o.rankOrder ?? [];
    this.starterBase = o.starterBase ?? null;
    this.atomicGrant = o.atomicGrant ?? null;
  }

  /**
   * Swap in reloaded loot rules (ED1): ownership, despawn, pickup range and
   * the ground cap apply from the next tick. The bag size is restart-only.
   */
  setLoot(loot: LootRules): void {
    this.loot = loot;
  }

  /** Items lying on the ground. */
  get groundCount(): number {
    return this.entityOf.size;
  }

  /**
   * Drop a new item of definition `def` at (x, z): it belongs to `owner`
   * (a character id; 0: anyone) for the rules' ownership time. Returns the
   * item id and its entity slot.
   */
  spawnDrop(sim: SimWorld, def: number, x: number, z: number, owner: number): { item: number; eid: number } {
    if (def < 0 || def >= this.defs.count) throw new RangeError(`items: no definition ${def}`);
    const item = this.store.create(def, this.defs.durability[def]);
    const eid = this.placeOnGround(sim, item, x, z, owner);
    return { item, eid };
  }

  /**
   * A scene-placed item (data-driven entities): lies at (x, z) for anyone and
   * never despawns on the timer. Placed again each boot, so the scene spawner
   * discards the old one first (`discardGround`).
   */
  placeFixture(sim: SimWorld, def: number, x: number, z: number): { item: number; eid: number } {
    const r = this.spawnDrop(sim, def, x, z, 0);
    WorldItem.despawnAt[r.eid] = 0xffffffff;
    return r;
  }

  /** Remove `item` if it is still lying on the ground (not one picked up since); true when it was. */
  discardGround(sim: SimWorld, item: number): boolean {
    const eid = this.entityOf.get(item);
    if (eid === undefined) return false;
    this.removeGroundEntity(sim, item, eid);
    this.store.destroy(item);
    return true;
  }

  /**
   * Pick a ground item up into `character`'s bag. `avatar` is the
   * character's entity slot (for the range check); `entity` the ground
   * item's wire id.
   */
  pickup(sim: SimWorld, character: number, avatar: number, entity: bigint): ItemResult {
    const eid = sim.resolveWireId(entity);
    if (eid < 0 || !hasComponent(sim.ecs, WorldItem, eid)) return { ok: false, error: "nothing to pick up there" };
    const dx = Transform.px[eid] - Transform.px[avatar];
    const dz = Transform.pz[eid] - Transform.pz[avatar];
    const dy = Transform.py[eid] - Transform.py[avatar];
    const r = this.loot.pickupRange;
    if (dx * dx + dz * dz > r * r || Math.abs(dy) > 3) return { ok: false, error: "too far away" };
    const owner = WorldItem.owner[eid];
    if (owner !== 0 && owner !== character && sim.currentTick < WorldItem.ownedUntil[eid]) {
      return { ok: false, error: "that belongs to someone else for now" };
    }
    if (!this.store.hasRoom(character)) return { ok: false, error: "your bag is full" };
    const item = WorldItem.item[eid];
    this.removeGroundEntity(sim, item, eid);
    this.store.putInBag(character, item);
    return { ok: true, message: `picked up ${this.defs.names[this.store.defs[this.store.slot(item)]]}` };
  }

  /** Drop an item from `character`'s bag at its avatar's feet (anyone may take it). */
  dropFromBag(sim: SimWorld, character: number, avatar: number, item: number): ItemResult {
    if (!this.store.inBagOf(character, item)) return { ok: false, error: "you don't have that" };
    const a = 0.6;
    const yaw = Transform.qy[avatar] !== 0 || Transform.qw[avatar] !== 0 ? 2 * Math.atan2(Transform.qy[avatar], Transform.qw[avatar]) : 0;
    this.placeOnGround(sim, item, Transform.px[avatar] + Math.sin(yaw) * a, Transform.pz[avatar] + Math.cos(yaw) * a, 0);
    return { ok: true, message: `dropped ${this.defs.names[this.store.defs[this.store.slot(item)]]}` };
  }

  /**
   * What a hand holds falls at the avatar's feet (a hand maimed or lost,
   * M3): anyone may take it. Returns whether the hand held anything.
   */
  dropHeld(sim: SimWorld, character: number, avatar: number, hand: "main" | "off"): boolean {
    const item = this.store.hands(character)[hand === "main" ? HandSlot.Main : HandSlot.Off];
    if (!item) return false;
    this.placeOnGround(sim, item, Transform.px[avatar] + 0.4, Transform.pz[avatar], 0);
    return true;
  }

  /**
   * Wear armour from the bag (U10): it goes to its slot, and what that
   * slot wore goes back to the bag. Refused when the item isn't wearable,
   * isn't in the bag, or the bag has no room for what comes out.
   */
  wear(character: number, item: number): ItemResult {
    if (!this.store.inBagOf(character, item)) return { ok: false, error: "you don't have that" };
    const def = this.store.defs[this.store.slot(item)];
    const slot = this.defs.slot[def];
    const at = (ARMOUR_SLOTS as readonly string[]).indexOf(slot);
    if (at < 0) return { ok: false, error: "you can't wear that" };
    const out = this.store.worn(character)[at];
    if (out !== 0 && this.store.emptySlots(character) < 1) return { ok: false, error: "your bag is too full to swap" };
    this.store.wear(character, item, at);
    if (out !== 0) this.store.putInBag(character, out);
    return { ok: true, message: `wearing ${this.defs.names[def]}` };
  }

  /**
   * Hold an item from the bag (M3b): it goes to its hand, and what that
   * hand held goes back to the bag. A two-handed item empties both hands;
   * an off-hand item displaces a two-handed one. Armour goes to its slot
   * instead (U10). Refused when the item can't be held or worn, isn't in
   * the bag, or the bag has no room for what comes out.
   */
  equip(character: number, item: number): ItemResult {
    if (!this.store.inBagOf(character, item)) return { ok: false, error: "you don't have that" };
    const def = this.store.defs[this.store.slot(item)];
    const hand = this.defs.hand[def];
    if (hand === HAND_CODE.none && this.defs.slot[def] === "none") return { ok: false, error: "you can't hold that" };
    if (hand === HAND_CODE.none) return this.wear(character, item);
    const hands = this.store.hands(character);
    const main = hands[HandSlot.Main];
    const off = hands[HandSlot.Off];
    const mainTwoHanded = main !== 0 && this.defs.hand[this.store.defs[this.store.slot(main)]] === HAND_CODE.both;
    const out: number[] = [];
    if (hand === HAND_CODE.main) {
      if (main) out.push(main);
    } else if (hand === HAND_CODE.off) {
      if (off) out.push(off);
      if (mainTwoHanded) out.push(main);
    } else {
      if (main) out.push(main);
      if (off) out.push(off);
    }
    // The item leaves the bag, so its slot is free for one of them.
    if (out.length > this.store.emptySlots(character) + 1) return { ok: false, error: "your bag is too full to swap" };
    this.store.hold(character, item, hand === HAND_CODE.off ? HandSlot.Off : HandSlot.Main);
    for (const o of out) this.store.putInBag(character, o);
    return { ok: true, message: `holding ${this.defs.names[def]}` };
  }

  /** The hands holding `item` would take (null: it can't be held, or isn't in the bag). */
  handsFor(character: number, item: number): ("main" | "off")[] | null {
    if (!this.store.inBagOf(character, item)) return null;
    const hand = this.defs.hand[this.store.defs[this.store.slot(item)]];
    return hand === HAND_CODE.main ? ["main"] : hand === HAND_CODE.off ? ["off"] : hand === HAND_CODE.both ? ["main", "off"] : null;
  }

  /** Put what a hand holds, or an armour slot wears, back in the bag. */
  unequip(character: number, slot: "main" | "off" | ArmourSlotName): ItemResult {
    if (slot === "main" || slot === "off") {
      const item = this.store.hands(character)[slot === "main" ? HandSlot.Main : HandSlot.Off];
      if (!item) return { ok: false, error: "that hand is empty" };
      if (!this.store.hasRoom(character)) return { ok: false, error: "your bag is full" };
      this.store.putInBag(character, item);
      return { ok: true, message: `put away ${this.defs.names[this.store.defs[this.store.slot(item)]]}` };
    }
    const at = (ARMOUR_SLOTS as readonly string[]).indexOf(slot);
    const item = this.store.worn(character)[at];
    if (!item) return { ok: false, error: "that slot is empty" };
    if (!this.store.hasRoom(character)) return { ok: false, error: "your bag is full" };
    this.store.putInBag(character, item);
    return { ok: true, message: `took off ${this.defs.names[this.store.defs[this.store.slot(item)]]}` };
  }

  /** The worn armour stats added up (U10 mitigation feeds on the `armour` total). */
  armourTotal(character: number): number {
    let total = 0;
    for (const id of this.store.worn(character)) {
      if (id !== 0) total += this.defs.stats[this.store.defs[this.store.slot(id)]]?.armour ?? 0;
    }
    return total;
  }

  /** The models a character holds (for its appearance; empty hands are left out). */
  heldModels(character: number): Held {
    const hands = this.store.hands(character);
    const model = (id: number): string | undefined => {
      if (!id) return undefined;
      const m = this.defs.models[this.store.defs[this.store.slot(id)]];
      return m || undefined;
    };
    const out: Held = {};
    const main = model(hands[HandSlot.Main]);
    const off = model(hands[HandSlot.Off]);
    if (main) out.main = main;
    if (off) out.off = off;
    return out;
  }

  /** Definition of the item in a character's main hand, or -1 (empty-handed). */
  mainHandDef(character: number): number {
    const id = this.store.hands(character)[HandSlot.Main];
    return id ? this.store.defs[this.store.slot(id)] : -1;
  }

  /**
   * A new character's starter weapon (M3b): the first time a character is
   * seen this run with empty hands, it is given the lowest-ranked item of
   * the starter base and holds it. Returns whether anything was given.
   * Characters with restored items count as outfitted (see `restore`).
   */
  outfit(character: number): boolean {
    if (this.outfitted.has(character) || this.starterBase === null) return false;
    this.outfitted.add(character);
    const hands = this.store.hands(character);
    if (hands[HandSlot.Main] || hands[HandSlot.Off]) return false;
    const def = this.defs.starter(this.starterBase, this.rankOrder);
    if (def < 0) return false;
    const item = this.store.create(def, this.defs.durability[def]);
    this.store.hold(character, item, HandSlot.Main);
    return true;
  }

  /** Give a new item straight into a bag (admin `give`). */
  give(character: number, def: number): ItemResult {
    if (def < 0 || def >= this.defs.count) return { ok: false, error: "no such item" };
    if (!this.store.hasRoom(character)) return { ok: false, error: "the bag is full" };
    const item = this.store.create(def, this.defs.durability[def]);
    this.store.putInBag(character, item);
    return { ok: true, message: `gave ${this.defs.names[def]} (item ${item})` };
  }

  /**
   * The grant path (slice A2): like `give`, but in fleet mode the
   * grant's commit routes through the world-tier `lootGrant`
   * operation and the settled outcome is applied to the local bag
   * (the coordinator's reconciliation materialises the item under
   * its world identity). Standalone (no executor wired) this is
   * exactly `give`. Fail closed: a world rejection or an outage
   * grants nothing — the pre-allocated local item is destroyed and
   * the refusal surfaces as the result's error.
   */
  async giveGranted(character: number, def: number): Promise<ItemResult> {
    if (!this.atomicGrant) return this.give(character, def);
    if (def < 0 || def >= this.defs.count) return { ok: false, error: "no such item" };
    if (!this.store.hasRoom(character)) return { ok: false, error: "the bag is full" };
    // Allocate the item's identity locally first (it exists nowhere
    // yet: created in the Free state, in no bag) so the world grant
    // and the local item share one instance id.
    const item = this.store.create(def, this.defs.durability[def]);
    try {
      const settled = await this.atomicGrant.loot(
        character,
        "system:grant",
        `item-${item}`,
        def,
      );
      if (!settled.ok) {
        this.store.destroy(item);
        return { ok: false, error: settled.message };
      }
    } catch (err) {
      this.store.destroy(item);
      return {
        ok: false,
        error: `grant refused: the world tier is unreachable (${(err as Error).message})`,
      };
    }
    // The settled outcome reconciled the item into the bag; confirm
    // it landed before reporting success.
    if (!this.store.inBagOf(character, item)) {
      return { ok: false, error: "grant refused: the settled outcome did not land" };
    }
    return { ok: true, message: `gave ${this.defs.names[def]} (item ${item})` };
  }

  /**
   * Give a new item straight into a bag (quest rewards, dungeon loot,
   * admin `give`): one grant shape everywhere. False for an unknown
   * definition or a full bag.
   */
  grantItem(character: number, def: number): boolean {
    return this.give(character, def).ok;
  }

  /** Definition of an item wherever it lives, or -1 when it is not a live item. */
  defOf(item: number): number {
    const slot = this.store.slot(item);
    return slot < 0 ? -1 : this.store.defs[slot];
  }

  /**
   * Move an item from one character's bag to another's (trade and auction
   * settlement). False when the item is not in `from`'s bag or `to`'s
   * bag is full (the item is left where it was).
   */
  moveItem(item: number, from: number, to: number): boolean {
    if (!this.store.inBagOf(from, item)) return false;
    return this.store.putInBag(to, item) >= 0;
  }

  /**
   * Take an item out of a character's bag and destroy it (vendor sales,
   * quest hand-ins). False when the item is not in the character's bag.
   */
  take(character: number, item: number): boolean {
    if (!this.store.inBagOf(character, item)) return false;
    this.store.destroy(item);
    return true;
  }

  /** How many items of an item base a character carries in their bag (quest checks). */
  countBase(character: number, base: string): number {
    let n = 0;
    for (const item of this.store.bag(character)) {
      if (item !== 0 && this.defs.bases[this.store.defs[this.store.slot(item)]] === base) n++;
    }
    return n;
  }

  /** The lowest-ranked definition of an item base (quest rewards grant the starter). */
  resolveBase(base: string): number {
    return this.defs.starter(base, this.rankOrder);
  }

  /** Expire ground items whose time is up. */
  step(sim: SimWorld): void {
    const tick = sim.currentTick;
    if (this.store.ledger) this.store.ledger.tick = tick;
    const eids = worldItems(sim.ecs);
    for (let i = eids.length - 1; i >= 0; i--) {
      const eid = eids[i];
      if (tick >= WorldItem.despawnAt[eid]) {
        const item = WorldItem.item[eid];
        this.removeGroundEntity(sim, item, eid);
        this.store.destroy(item);
      }
    }
  }

  /**
   * Bring items back from the ledger after a restart (roadmap P2a): bag and
   * hand items return to their slots, ground items are placed again at
   * their spot with fresh despawn timers and no owner claim. Owners of
   * restored items are not given a new starter weapon. Call before
   * `attachLedger`, so restoring records nothing. Returns items restored.
   */
  restore(sim: SimWorld, rows: readonly ItemRow[]): number {
    let n = 0;
    for (const row of rows) {
      if (row.def < 0 || row.def >= this.defs.count) continue;
      this.store.restore(row);
      n++;
      if (row.kind === LedgerKind.Bag || row.kind === LedgerKind.Hold || row.kind === LedgerKind.Wear) this.outfitted.add(row.owner);
      else if (row.kind === LedgerKind.Ground) this.placeOnGround(sim, row.id, row.x, row.z, 0);
    }
    return n;
  }

  /** Record every item change to `ledger` from now on; later ids start above its highest. */
  attachLedger(ledger: ItemLedger): void {
    this.store.reserveIds(ledger.maxItemId());
    this.store.ledger = ledger;
  }

  /**
   * Ground item entities left by a world snapshot restore: despawn every
   * ground-item-variant entity that has no live item behind it (ground items
   * are re-placed from the ledger afterwards). Returns how many went.
   */
  clearStrayGroundItems(sim: SimWorld): number {
    const strays: number[] = [];
    for (let eid = 0; eid <= sim.maxSlotSeen; eid++) {
      if (!entityExists(sim.ecs, eid) || !hasComponent(sim.ecs, AssetRef, eid)) continue;
      if (AssetRef.variant[eid] !== GROUND_ITEM_VARIANT) continue;
      if (hasComponent(sim.ecs, WorldItem, eid) && this.entityOf.get(WorldItem.item[eid]) === eid) continue;
      strays.push(eid);
    }
    for (const eid of strays) sim.despawn(eid);
    return strays.length;
  }

  /** The drops message for these ground item entities (null: every one), or null when none apply. */
  dropsFor(sim: SimWorld, only: readonly bigint[] | null): DropsMessage | null {
    const rows: DropsMessage["drops"] = [];
    const add = (eid: number): void => {
      const slot = this.store.slot(WorldItem.item[eid]);
      if (slot < 0) return;
      const def = this.store.defs[slot];
      rows.push([sim.wireId(eid).toString(), this.defs.names[def], this.defs.ranks[def], this.defs.colors[def]]);
    };
    if (only === null) {
      for (const eid of this.entityOf.values()) add(eid);
    } else {
      for (const wid of only) {
        const eid = sim.resolveWireId(wid);
        if (eid >= 0 && hasComponent(sim.ecs, WorldItem, eid)) add(eid);
      }
    }
    return rows.length > 0 ? { kind: "drops", drops: rows } : null;
  }

  /** What a character's bag holds, for the inventory message. */
  inventoryOf(character: number): InventoryMessage {
    const bag = this.store.bag(character);
    const out: InventoryMessage["bag"] = [];
    for (let i = 0; i < bag.length; i++) out.push(bag[i] === 0 ? null : this.view(bag[i]));
    const hands = this.store.hands(character);
    const wornItems = this.store.worn(character);
    const worn: NonNullable<InventoryMessage["worn"]> = {};
    ARMOUR_SLOTS.forEach((name, i) => {
      worn[name] = wornItems[i] ? this.view(wornItems[i]) : null;
    });
    return {
      kind: "inventory",
      bag: out,
      main: hands[HandSlot.Main] ? this.view(hands[HandSlot.Main]) : null,
      off: hands[HandSlot.Off] ? this.view(hands[HandSlot.Off]) : null,
      worn,
    };
  }

  /** One item as its holder sees it. */
  view(item: number): ItemView {
    const slot = this.store.slot(item);
    if (slot < 0) throw new Error(`items: no item ${item}`);
    const d = this.store.defs[slot];
    const defs = this.defs;
    return {
      id: item,
      def: defs.ids[d],
      name: defs.names[d],
      base: defs.bases[d],
      rank: defs.ranks[d],
      color: defs.colors[d],
      hand: HAND_NAME[defs.hand[d]],
      slot: defs.slot[d],
      stats: { ...defs.stats[d] },
      durability: Math.round(this.store.durability[slot]),
      model: defs.models[d],
    };
  }

  /** Ground entity slot of a ground item, or -1. */
  groundEntity(item: number): number {
    return this.entityOf.get(item) ?? -1;
  }

  private placeOnGround(sim: SimWorld, item: number, x: number, z: number, owner: number): number {
    const slot = this.store.slot(item);
    const def = this.store.defs[slot];
    this.store.placeOnGround(item, owner, x, z);
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid);
    Transform.px[eid] = x;
    Transform.py[eid] = this.groundHeightAt(x, z) + REST_HEIGHT;
    Transform.pz[eid] = z;
    // Lying flat: rolled a quarter turn about Z (models stand along +Y),
    // then turned about Y by a yaw from the item id: q = yaw ⊗ roll.
    const half = (((item * 2654435761) >>> 0) / 4294967296) * Math.PI;
    const a = Math.SQRT1_2;
    const sy = Math.sin(half);
    const cy = Math.cos(half);
    Transform.qx[eid] = sy * a;
    Transform.qy[eid] = sy * a;
    Transform.qz[eid] = cy * a;
    Transform.qw[eid] = cy * a;
    Transform.sx[eid] = 1;
    Transform.sy[eid] = 1;
    Transform.sz[eid] = 1;
    addComponent(sim.ecs, AssetRef, eid);
    AssetRef.assetHash[eid] = this.defs.assetHash[def];
    AssetRef.variant[eid] = GROUND_ITEM_VARIANT;
    addComponent(sim.ecs, WorldItem, eid);
    const tick = sim.currentTick;
    WorldItem.item[eid] = item;
    WorldItem.owner[eid] = owner;
    WorldItem.ownedUntil[eid] = tick + Math.round(this.loot.ownershipSeconds * this.tickHz);
    WorldItem.despawnAt[eid] = tick + Math.round(this.loot.despawnSeconds * this.tickHz);
    this.entityOf.set(item, eid);
    this.groundOrder.push(item);
    this.enforceCap(sim);
    return eid;
  }

  private removeGroundEntity(sim: SimWorld, item: number, eid: number): void {
    this.entityOf.delete(item);
    if (entityExists(sim.ecs, eid)) sim.despawn(eid);
    // groundOrder is pruned lazily (enforceCap skips ids no longer on the ground).
  }

  /** Past the ground cap, the oldest ground items go. */
  private enforceCap(sim: SimWorld): void {
    while (this.entityOf.size > this.loot.maxGroundItems && this.groundOrder.length > 0) {
      const oldest = this.groundOrder.shift()!;
      const eid = this.entityOf.get(oldest);
      if (eid === undefined) continue;
      this.removeGroundEntity(sim, oldest, eid);
      this.store.destroy(oldest);
    }
    // Keep the order list from growing without bound with stale ids.
    if (this.groundOrder.length > 2 * this.loot.maxGroundItems + 64) {
      const live = this.groundOrder.filter((id) => this.entityOf.has(id));
      this.groundOrder.length = 0;
      this.groundOrder.push(...live);
    }
  }
}

/** Parse a decimal wire id from a client; null when malformed. */
export function parseEntityArg(entity: string): bigint | null {
  if (!/^\d{1,20}$/.test(entity)) return null;
  const v = BigInt(entity);
  if (v > 0xffffffffffffffffn) return null;
  try {
    parseWireEntityId(v);
  } catch {
    return null;
  }
  return v;
}

export { ItemWhere };
