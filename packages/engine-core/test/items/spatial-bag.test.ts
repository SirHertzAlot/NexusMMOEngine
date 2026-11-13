/**
 * Grid bags (CF6): items take their base's footprint; a move is checked by the server; a plain slot bag is unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { engineDefaults, type LootRules } from "@mmo-engine/rules";
import { ItemDefs, ItemService, ItemStore, type PoolItemLike } from "../../src/items/index.js";
import { ItemLedger, LedgerKind, type ItemRow } from "../../src/persist/item-ledger.js";

const RULES = (() => {
  const r = engineDefaults();
  r.items.bases.sword = { ...r.items.fallback, hand: "main", footprint: [1, 3] };
  r.items.bases.shield = { ...r.items.fallback, hand: "off", footprint: [2, 2] };
  r.items.bases.ring = { ...r.items.fallback, footprint: [1, 1] };
  return r;
})();

const pool = (id: string, base: string): PoolItemLike => ({
  id, rank: "common", source: "mob", item: base, seed: 1,
  bundle: { Identity: { id, name: id, base }, Rank: { id: "common", color: "#fff" }, Stats: {} },
});
const POOL = [pool("sword", "sword"), pool("shield", "shield"), pool("ring", "ring")];
const defs = () => new ItemDefs(POOL, RULES);
const SWORD = 0, SHIELD = 1, RING = 2;

/** A 4 x 3 grid bag: 12 cells, 4 across. */
const loot = (over: Partial<LootRules> = {}): LootRules => ({ ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 12, bagColumns: 4, maxGroundItems: 100, ...over });
const service = (over: Partial<LootRules> = {}) => new ItemService({ defs: defs(), loot: loot(over), tickHz: 30 });
const C = 1;

describe("item definitions", () => {
  it("take their footprint from the rules, one cell when the rules say nothing", () => {
    const d = defs();
    assert.deepEqual(d.footprint[SWORD], [1, 3]);
    assert.deepEqual(d.footprint[SHIELD], [2, 2]);
    assert.deepEqual(new ItemDefs([pool("bread", "bread")], engineDefaults()).footprint[0], [1, 1]);
  });
});

describe("a grid bag", () => {
  it("places items by footprint, first fit from the top left, and reports where they lie", () => {
    const svc = service();
    assert.equal(svc.give(C, SHIELD).ok, true); // 2x2 at 0,0
    assert.equal(svc.give(C, SWORD).ok, true); // 1x3 at 2,0
    const inv = svc.inventoryOf(C);
    assert.deepEqual(inv.grid, { columns: 4, rows: 3, slots: 12 });
    const at = (i: number) => inv.bag[i]!.at;
    assert.deepEqual(at(0), { x: 0, y: 0, rot: false, w: 2, h: 2 });
    assert.deepEqual(at(2), { x: 2, y: 0, rot: false, w: 1, h: 3 });
    assert.equal(inv.bag[1], null, "a covered cell shows nothing: the item stands at its anchor only");
  });

  it("refuses a move that goes outside, lands on another item or turns a square one, and moves nothing", () => {
    const svc = service();
    svc.give(C, SHIELD);
    svc.give(C, SWORD);
    const shield = svc.inventoryOf(C).bag[0]!.id;
    const sword = svc.inventoryOf(C).bag[2]!.id;
    assert.deepEqual(svc.move(C, shield, { x: 3, y: 0, rot: false }), { ok: false, error: "that does not fit there" });
    assert.deepEqual(svc.move(C, shield, { x: 1, y: 0, rot: false }), { ok: false, error: "something is in the way" });
    assert.deepEqual(svc.move(C, shield, { x: 0, y: 0, rot: true }), { ok: false, error: "that can't be turned" });
    assert.deepEqual(svc.move(C, 999, { x: 0, y: 0, rot: false }), { ok: false, error: "you don't have that" });
    assert.deepEqual(svc.move(2, sword, { x: 0, y: 0, rot: false }), { ok: false, error: "you don't have that" }, "someone else's item");
    assert.deepEqual(svc.inventoryOf(C).bag[0]!.at, { x: 0, y: 0, rot: false, w: 2, h: 2 });
  });

  it("moves and turns an item, and frees what it left", () => {
    const svc = service();
    svc.give(C, SWORD); // 1x3 at 0,0
    const sword = svc.inventoryOf(C).bag[0]!.id;
    assert.deepEqual(svc.move(C, sword, { x: 0, y: 2, rot: true }), { ok: true, message: "moved" }, "turned: 3 across, 1 down, on the bottom row");
    const inv = svc.inventoryOf(C);
    assert.deepEqual(inv.bag[8]!.at, { x: 0, y: 2, rot: true, w: 3, h: 1 });
    assert.equal(inv.bag[0], null);
    // the cells it left are free: a shield now fits at the top left
    assert.equal(svc.give(C, SHIELD).ok, true);
    assert.deepEqual(svc.inventoryOf(C).bag[0]!.at, { x: 0, y: 0, rot: false, w: 2, h: 2 });
  });

  it("says the bag is full when an item fits nowhere, though cells are free", () => {
    const svc = service({ bagSlots: 8, bagColumns: 4 }); // 4 x 2
    assert.equal(svc.give(C, SHIELD).ok, true);
    assert.equal(svc.give(C, SHIELD).ok, true);
    assert.equal(svc.store.hasRoom(C), false);
    const ring = svc.give(C, RING);
    assert.equal(ring.ok, false);
    const tight = service({ bagSlots: 9, bagColumns: 3 }); // 3 x 3: a shield, then a sword lying across the bottom
    tight.give(C, SHIELD);
    assert.equal(tight.give(C, SWORD).ok, true, "turned to lie along the bottom (3 across, 1 down)");
    assert.equal(tight.give(C, SWORD).ok, false, "free cells remain (the right column) but no 1x3 fits upright");
    assert.equal(tight.store.emptySlots(C) > 0, true);
  });

  it("does not let the cells past the last slot be used", () => {
    const svc = service({ bagSlots: 10, bagColumns: 4 }); // 4 x 3 grid, but only 10 cells exist
    for (let i = 0; i < 10; i++) assert.equal(svc.give(C, RING).ok, true, `ring ${i}`);
    assert.equal(svc.give(C, RING).ok, false);
    assert.equal(svc.store.moveInBag(C, svc.inventoryOf(C).bag[0]!.id, { x: 3, y: 2, rot: false }), "occupied", "a cell that does not exist is never free");
  });
});

describe("a plain slot bag", () => {
  it("is unchanged: no grid, no positions, one cell each, bag slots in a row", () => {
    const svc = service({ bagSlots: 3, bagColumns: undefined });
    svc.give(C, SHIELD);
    svc.give(C, SWORD);
    const inv = svc.inventoryOf(C);
    assert.equal(inv.grid, undefined);
    assert.equal(inv.bag[0]!.at, undefined);
    assert.equal(inv.bag.filter(Boolean).length, 2);
    assert.deepEqual(svc.move(C, inv.bag[0]!.id, { x: 1, y: 0, rot: false }), { ok: false, error: "this bag is not a grid" });
  });
});

describe("persistence", () => {
  it("records an item's anchor and turn, and restores it where it lay", () => {
    const rows: ItemRow[] = [];
    const ledger = { record: (kind: number, id: number, def: number, owner: number, slot: number, durability: number) => { rows.push({ id, def, kind, owner, slot, durability, x: 0, z: 0 } as ItemRow); } } as unknown as ItemLedger;
    const a = new ItemStore(12, undefined, { columns: 4, footprintOf: (d) => defs().footprint[d]! });
    a.ledger = ledger;
    const id = a.create(SWORD, 100);
    a.putInBag(C, id);
    assert.equal(a.moveInBag(C, id, { x: 1, y: 2, rot: true }), null);
    const last = rows.filter((r) => r.kind === LedgerKind.Bag).at(-1)!;
    assert.equal(last.slot & 0x8000, 0x8000, "the turn is in the slot");

    const b = new ItemStore(12, undefined, { columns: 4, footprintOf: (d) => defs().footprint[d]! });
    b.restore(last);
    assert.deepEqual(b.placementOf(C, id), { x: 1, y: 2, rot: true });
  });

  it("restores an item whose old place now overlaps another to the first place it fits, and a legacy slot as an upright anchor", () => {
    const fp = (d: number) => defs().footprint[d]!;
    const s = new ItemStore(12, undefined, { columns: 4, footprintOf: fp });
    const row = (id: number, def: number, slot: number): ItemRow => ({ id, def, kind: LedgerKind.Bag, owner: C, slot, durability: 100, x: 0, z: 0 } as ItemRow);
    s.restore(row(1, SHIELD, 0)); // a 2x2 at 0,0
    s.restore(row(2, SHIELD, 1)); // a legacy slot-1 shield: overlaps the first
    assert.deepEqual(s.placementOf(C, 1), { x: 0, y: 0, rot: false });
    assert.deepEqual(s.placementOf(C, 2), { x: 2, y: 0, rot: false }, "moved to the first place it fits");
  });
});

describe("swaps use footprints", () => {
  it("canFit counts what leaves the bag first", () => {
    const s = new ItemStore(4, undefined, { columns: 2, footprintOf: (d) => defs().footprint[d]! }); // 2 x 2: one shield fills it
    const shield = s.create(SHIELD, 100);
    s.putInBag(C, shield);
    assert.equal(s.canFit(C, [SHIELD]), false);
    assert.equal(s.canFit(C, [SHIELD], [shield]), true, "once the shield in the bag has left, another fits");
    assert.equal(s.canFit(C, [SHIELD, SHIELD], [shield]), false);
  });
});
