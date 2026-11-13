/**
 * Item instances (roadmap M3a): every item that exists in the region, in
 * preallocated columns indexed by slot, and each character's bag.
 *
 * An item is created when it drops (or an admin gives it) and lives on the
 * ground or in a bag until it is destroyed. Ids are positive integers that
 * are never reused while the server runs; a slot is reused once its item
 * is gone (free list). Nothing here runs per tick: items change on pickups,
 * drops and kills, so the id → slot map and the bag arrays are touched
 * only by those events.
 *
 * Every change is also recorded to an optional ItemLedger (roadmap P2a), and
 * `restore` rebuilds an item from its ledger row after a restart.
 */

import { NOT_A_CELL, checkPlace, firstFit, gridFor, packPlacement, stamp, unpackPlacement, type Footprint, type GridSize, type PlaceRefusal, type Placement } from "@mmo-engine/protocol";
import { ItemLedger, LedgerKind, type ItemRow } from "../persist/item-ledger.js";

export const ItemWhere = {
  /** Slot unused. */
  Free: 0,
  Ground: 1,
  Bag: 2,
  /** In a character's hand (roadmap M3b). */
  Held: 3,
  /** Worn in a character's armour slot (roadmap U10). */
  Worn: 4,
} as const;

/** Hand slots: index into a character's hands. */
export const HandSlot = { Main: 0, Off: 1 } as const;

/** Armour slots: index into a character's worn set, in rules slot order. */
export const ArmourSlot = { head: 0, chest: 1, hands: 2, legs: 3, ring: 4, amulet: 5 } as const;
export const ARMOUR_SLOTS = ["head", "chest", "hands", "legs", "ring", "amulet"] as const;
export type ArmourSlotName = (typeof ARMOUR_SLOTS)[number];
export type ItemWhereCode = (typeof ItemWhere)[keyof typeof ItemWhere];

const INITIAL_CAPACITY = 1024;

const ONE: Footprint = [1, 1];

/** How a bag is laid out (roadmap CF6): omit it and every item is one cell in one row, exactly the slot bag. */
export interface BagLayout {
  /** Cells across; the grid has ceil(bagSlots / columns) rows. */
  columns?: number;
  /** An item definition's footprint in cells; absent: one cell each. */
  footprintOf?: (def: number) => Footprint;
}

export class ItemStore {
  /** Columns, indexed by slot. */
  ids: Uint32Array;
  defs: Uint32Array;
  where: Uint8Array;
  /** Character id holding it (bag), or that the drop belongs to (ground); 0: nobody. */
  owner: Float64Array;
  durability: Float32Array;

  private capacity: number;
  private readonly freeSlots: number[] = [];
  private used = 0;
  /** Slots ever handed out (the next fresh slot). */
  private top = 0;
  private nextId = 1;
  /** Where every change is recorded (roadmap P2a); none: items live in memory only. */
  ledger?: ItemLedger;
  private readonly slotOf = new Map<number, number>();
  private readonly bags = new Map<number, Uint32Array>();
  /** Each character's bag cells: the item id on every cell it covers (0: free, NOT_A_CELL: past the last slot). */
  private readonly cellsOf = new Map<number, Uint32Array>();
  /** Bag items that lie turned a quarter. */
  private readonly turned = new Set<number>();
  /** The bag as a grid. */
  readonly grid: GridSize;
  /** Whether the bag was given a layout (columns): the inventory then says where each item lies. */
  readonly spatial: boolean;
  private readonly footprintOf: (def: number) => Footprint;
  /** Item id held in each hand ([main, off]; 0: empty), per character. */
  private readonly handsOf = new Map<number, Uint32Array>();
  /** Item id worn in each armour slot (ARMOUR_SLOTS order; 0: empty), per character. */
  private readonly wornOf = new Map<number, Uint32Array>();

  constructor(
    /** Bag slots per character (rules loot.bagSlots). */
    readonly bagSlots: number,
    capacity = INITIAL_CAPACITY,
    layout: BagLayout = {},
  ) {
    this.spatial = layout.columns !== undefined;
    this.grid = gridFor(bagSlots, layout.columns ?? bagSlots);
    // Footprints only mean something in a grid: a plain slot bag is one cell per item, whatever the rules say.
    this.footprintOf = this.spatial ? (layout.footprintOf ?? (() => ONE)) : () => ONE;
    this.capacity = capacity;
    this.ids = new Uint32Array(capacity);
    this.defs = new Uint32Array(capacity);
    this.where = new Uint8Array(capacity);
    this.owner = new Float64Array(capacity);
    this.durability = new Float32Array(capacity);
  }

  /** Items that exist. */
  get size(): number {
    return this.used;
  }

  /** Make a new item of definition `def`; returns its id. */
  create(def: number, durability: number): number {
    const slot = this.freeSlots.length > 0 ? this.freeSlots.pop()! : this.top++;
    if (slot >= this.capacity) this.grow();
    const id = this.nextId++;
    this.ids[slot] = id;
    this.defs[slot] = def;
    this.where[slot] = ItemWhere.Free;
    this.owner[slot] = 0;
    this.durability[slot] = durability;
    this.slotOf.set(id, slot);
    this.used++;
    this.ledger?.record(LedgerKind.Create, id, def, 0, 0, durability);
    return id;
  }

  /**
   * Put an item back from its ledger row (after a restart): into its bag
   * slot or hand, or on the ground. Records nothing; ids stay unique.
   */
  restore(row: ItemRow): void {
    if (this.slotOf.has(row.id)) return;
    const slot = this.freeSlots.length > 0 ? this.freeSlots.pop()! : this.top++;
    if (slot >= this.capacity) this.grow();
    this.ids[slot] = row.id;
    this.defs[slot] = row.def;
    this.durability[slot] = row.durability;
    this.owner[slot] = row.owner;
    this.slotOf.set(row.id, slot);
    this.used++;
    if (row.id >= this.nextId) this.nextId = row.id + 1;
    if (row.kind === LedgerKind.Bag && (row.slot & 0x7fff) < this.bagSlots) {
      // Where it lay (its anchor and turn); when a footprint now overlaps, or the grid changed, the first place it fits.
      const f = this.footprintOf(row.def);
      const cells = this.cells(row.owner);
      const want = unpackPlacement(this.grid, row.slot);
      const at = checkPlace(this.grid, cells, f, want, row.id) === null ? want : firstFit(this.grid, cells, f, row.id);
      if (at) {
        this.lay(row.owner, row.id, f, at);
        this.where[slot] = ItemWhere.Bag;
      } else this.where[slot] = ItemWhere.Free;
    } else if (row.kind === LedgerKind.Hold && row.slot < 2) {
      this.hands(row.owner)[row.slot] = row.id;
      this.where[slot] = ItemWhere.Held;
    } else if (row.kind === LedgerKind.Wear && row.slot < ARMOUR_SLOTS.length) {
      this.worn(row.owner)[row.slot] = row.id;
      this.where[slot] = ItemWhere.Worn;
    } else {
      this.where[slot] = row.kind === LedgerKind.Create ? ItemWhere.Free : ItemWhere.Ground;
    }
  }

  /** Make later ids start above `id` (ids of destroyed items are never reused). */
  reserveIds(id: number): void {
    if (id >= this.nextId) this.nextId = id + 1;
  }

  /** Remove an item from existence (it must not be in a bag). */
  destroy(id: number): void {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return;
    this.takeFromWherever(slot, id);
    this.ledger?.record(LedgerKind.Destroy, id, this.defs[slot], this.owner[slot], 0, this.durability[slot]);
    this.slotOf.delete(id);
    this.ids[slot] = 0;
    this.where[slot] = ItemWhere.Free;
    this.owner[slot] = 0;
    this.freeSlots.push(slot);
    this.used--;
  }

  /** Slot of a live item, or -1. */
  slot(id: number): number {
    return this.slotOf.get(id) ?? -1;
  }

  exists(id: number): boolean {
    return this.slotOf.has(id);
  }

  /** Mark an item as lying on the ground, belonging to `owner` (0: anyone). */
  placeOnGround(id: number, owner: number, x = 0, z = 0): void {
    const slot = this.mustSlot(id);
    this.takeFromWherever(slot, id);
    this.where[slot] = ItemWhere.Ground;
    this.owner[slot] = owner;
    this.ledger?.record(LedgerKind.Ground, id, this.defs[slot], owner, 0, this.durability[slot], x, z);
  }

  /**
   * Put an item in a character's bag, in its first empty slot. Returns the
   * bag slot, or -1 when the bag is full (the item is left where it was).
   */
  putInBag(character: number, id: number): number {
    const slot = this.mustSlot(id);
    const f = this.footprintOf(this.defs[slot]);
    // Where it fits (its own cells, when it is already in this bag, do not block it).
    const at = firstFit(this.grid, this.cells(character), f, id);
    if (!at) return -1;
    this.takeFromWherever(slot, id);
    this.lay(character, id, f, at);
    this.where[slot] = ItemWhere.Bag;
    this.owner[slot] = character;
    this.ledger?.record(LedgerKind.Bag, id, this.defs[slot], character, packPlacement(this.grid, at), this.durability[slot]);
    return at.y * this.grid.columns + at.x;
  }

  /**
   * Move an item within a character's bag to `to`, turned or not (CF6). The placement is checked here, whatever the
   * client said: wholly inside the grid, over nothing else, and turned only if the item is not square. Nothing moves
   * on a refusal.
   */
  moveInBag(character: number, id: number, to: Placement): PlaceRefusal | "not-yours" | null {
    if (!this.inBagOf(character, id)) return "not-yours";
    const slot = this.mustSlot(id);
    const f = this.footprintOf(this.defs[slot]);
    const refusal = checkPlace(this.grid, this.cells(character), f, to, id);
    if (refusal) return refusal;
    this.takeFromBag(character, id);
    this.lay(character, id, f, to);
    this.ledger?.record(LedgerKind.Bag, id, this.defs[slot], character, packPlacement(this.grid, to), this.durability[slot]);
    return null;
  }

  /** Where an item lies in a character's bag (anchor and turn), or null when it is not there. */
  placementOf(character: number, id: number): Placement | null {
    if (!this.inBagOf(character, id)) return null;
    const i = this.bag(character).indexOf(id);
    if (i < 0) return null;
    return { x: i % this.grid.columns, y: Math.floor(i / this.grid.columns), rot: this.turned.has(id) };
  }

  /** The footprint (before any turn) of an item definition. */
  footprint(def: number): Footprint {
    return this.footprintOf(def);
  }

  /**
   * Whether items of these definitions would all fit in a character's bag, one after another, once the items in
   * `removing` (in that bag now, about to leave it) are gone: the check before a swap or a pickup.
   */
  canFit(character: number, defs: readonly number[], removing: readonly number[] = []): boolean {
    const cells = Uint32Array.from(this.cells(character));
    for (const id of removing) {
      const at = this.placementOf(character, id);
      if (at) stamp(this.grid, cells, this.footprintOf(this.defs[this.mustSlot(id)]), at, 0);
    }
    let n = 0;
    for (const def of defs) {
      const f = this.footprintOf(def);
      const at = firstFit(this.grid, cells, f);
      if (!at) return false;
      stamp(this.grid, cells, f, at, ++n); // any non-zero mark will do
    }
    return true;
  }

  /** A character's bag cells, created (with the cells past the last slot closed) on first use. */
  private cells(character: number): Uint32Array {
    let c = this.cellsOf.get(character);
    if (!c) {
      c = new Uint32Array(this.grid.columns * this.grid.rows);
      for (let i = this.bagSlots; i < c.length; i++) c[i] = NOT_A_CELL;
      this.cellsOf.set(character, c);
    }
    return c;
  }

  /** Mark an item on its cells and at its anchor, and remember a turn. */
  private lay(character: number, id: number, f: Footprint, at: Placement): void {
    stamp(this.grid, this.cells(character), f, at, id);
    this.bag(character)[at.y * this.grid.columns + at.x] = id;
    if (at.rot) this.turned.add(id);
    else this.turned.delete(id);
  }

  /**
   * Put an item in a character's bag at an exact slot (slice A2: the
   * settled-outcome reconciler places items where the world record
   * says they are). Returns false — moving nothing — when the slot is
   * out of range or already holds a different item.
   */
  putInBagAt(character: number, id: number, at: number): boolean {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return false;
    if (!Number.isInteger(at) || at < 0 || at >= this.bagSlots) return false;
    const f = this.footprintOf(this.defs[slot]);
    const to: Placement = { x: at % this.grid.columns, y: Math.floor(at / this.grid.columns), rot: false };
    if (this.bag(character)[at] === id && !this.turned.has(id)) return true;
    if (checkPlace(this.grid, this.cells(character), f, to, id) !== null) return false;
    this.takeFromWherever(slot, id);
    this.lay(character, id, f, to);
    this.where[slot] = ItemWhere.Bag;
    this.owner[slot] = character;
    this.ledger?.record(LedgerKind.Bag, id, this.defs[slot], character, packPlacement(this.grid, to), this.durability[slot]);
    return true;
  }

  /** Put an item in a character's hand (taken from wherever it was). */
  hold(character: number, id: number, hand: number): void {
    const slot = this.mustSlot(id);
    this.takeFromWherever(slot, id);
    this.hands(character)[hand] = id;
    this.where[slot] = ItemWhere.Held;
    this.owner[slot] = character;
    this.ledger?.record(LedgerKind.Hold, id, this.defs[slot], character, hand, this.durability[slot]);
  }

  /** A character's hands: item id held in each ([main, off]; 0: empty). Created empty on first use. */
  hands(character: number): Uint32Array {
    let h = this.handsOf.get(character);
    if (!h) this.handsOf.set(character, (h = new Uint32Array(2)));
    return h;
  }

  /** Put an item in a character's armour slot (taken from wherever it was). */
  wear(character: number, id: number, slot: number): void {
    const at = this.mustSlot(id);
    this.takeFromWherever(at, id);
    this.worn(character)[slot] = id;
    this.where[at] = ItemWhere.Worn;
    this.owner[at] = character;
    this.ledger?.record(LedgerKind.Wear, id, this.defs[at], character, slot, this.durability[at]);
  }

  /** A character's worn armour: item id per ARMOUR_SLOTS index, 0 when empty. Created empty on first use. */
  worn(character: number): Uint32Array {
    let w = this.wornOf.get(character);
    if (!w) this.wornOf.set(character, (w = new Uint32Array(ARMOUR_SLOTS.length)));
    return w;
  }

  /** Empty bag cells a character has. */
  emptySlots(character: number): number {
    const cells = this.cells(character);
    let n = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i] === 0) n++;
    return n;
  }

  /** Whether a character's bag has an empty cell (for an item of known size, `canFit`). */
  hasRoom(character: number): boolean {
    return this.cells(character).indexOf(0) >= 0;
  }

  /** A character's bag: item id per slot, 0 when empty. Created empty on first use. */
  bag(character: number): Uint32Array {
    let bag = this.bags.get(character);
    if (!bag) this.bags.set(character, (bag = new Uint32Array(this.bagSlots)));
    return bag;
  }

  /** Whether `character` holds item `id` in its bag. */
  inBagOf(character: number, id: number): boolean {
    const slot = this.slotOf.get(id);
    return slot !== undefined && this.where[slot] === ItemWhere.Bag && this.owner[slot] === character;
  }

  private takeFromWherever(slot: number, id: number): void {
    const where = this.where[slot];
    if (where === ItemWhere.Bag) this.takeFromBag(this.owner[slot], id);
    else if (where === ItemWhere.Held) {
      const h = this.handsOf.get(this.owner[slot]);
      if (h) for (let i = 0; i < h.length; i++) if (h[i] === id) h[i] = 0;
    } else if (where === ItemWhere.Worn) {
      const w = this.wornOf.get(this.owner[slot]);
      if (w) for (let i = 0; i < w.length; i++) if (w[i] === id) w[i] = 0;
    }
  }

  private takeFromBag(character: number, id: number): void {
    const bag = this.bags.get(character);
    if (!bag) return;
    const i = bag.indexOf(id);
    if (i < 0) return;
    const at: Placement = { x: i % this.grid.columns, y: Math.floor(i / this.grid.columns), rot: this.turned.has(id) };
    stamp(this.grid, this.cells(character), this.footprintOf(this.defs[this.mustSlot(id)]), at, 0);
    bag[i] = 0;
    this.turned.delete(id);
  }

  private mustSlot(id: number): number {
    const slot = this.slotOf.get(id);
    if (slot === undefined) throw new Error(`items: no item ${id}`);
    return slot;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const grow32 = (a: Uint32Array): Uint32Array => {
      const b = new Uint32Array(cap);
      b.set(a);
      return b;
    };
    this.ids = grow32(this.ids);
    this.defs = grow32(this.defs);
    const where = new Uint8Array(cap);
    where.set(this.where);
    this.where = where;
    const owner = new Float64Array(cap);
    owner.set(this.owner);
    this.owner = owner;
    const dur = new Float32Array(cap);
    dur.set(this.durability);
    this.durability = dur;
    this.capacity = cap;
  }
}
