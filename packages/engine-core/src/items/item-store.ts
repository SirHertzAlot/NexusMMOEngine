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
 * In memory only for now: the item ledger (roadmap P2a) makes items and
 * bags survive restarts.
 */

export const ItemWhere = {
  /** Slot unused. */
  Free: 0,
  Ground: 1,
  Bag: 2,
} as const;
export type ItemWhereCode = (typeof ItemWhere)[keyof typeof ItemWhere];

const INITIAL_CAPACITY = 1024;

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
  private readonly slotOf = new Map<number, number>();
  private readonly bags = new Map<number, Uint32Array>();

  constructor(
    /** Bag slots per character (rules loot.bagSlots). */
    readonly bagSlots: number,
    capacity = INITIAL_CAPACITY,
  ) {
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
    return id;
  }

  /** Remove an item from existence (it must not be in a bag). */
  destroy(id: number): void {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return;
    if (this.where[slot] === ItemWhere.Bag) this.takeFromBag(this.owner[slot], id);
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
  placeOnGround(id: number, owner: number): void {
    const slot = this.mustSlot(id);
    if (this.where[slot] === ItemWhere.Bag) this.takeFromBag(this.owner[slot], id);
    this.where[slot] = ItemWhere.Ground;
    this.owner[slot] = owner;
  }

  /**
   * Put an item in a character's bag, in its first empty slot. Returns the
   * bag slot, or -1 when the bag is full (the item is left where it was).
   */
  putInBag(character: number, id: number): number {
    const slot = this.mustSlot(id);
    const bag = this.bag(character);
    const free = bag.indexOf(0);
    if (free < 0) return -1;
    if (this.where[slot] === ItemWhere.Bag) this.takeFromBag(this.owner[slot], id);
    bag[free] = id;
    this.where[slot] = ItemWhere.Bag;
    this.owner[slot] = character;
    return free;
  }

  /** Whether a character's bag has an empty slot. */
  hasRoom(character: number): boolean {
    return this.bag(character).indexOf(0) >= 0;
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

  private takeFromBag(character: number, id: number): void {
    const bag = this.bags.get(character);
    if (!bag) return;
    const i = bag.indexOf(id);
    if (i >= 0) bag[i] = 0;
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
