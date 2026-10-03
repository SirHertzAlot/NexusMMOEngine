/** Rebake keeps held items (roadmap L3). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { bakeLootPool } from "@mmo-engine/compose";
import { ItemLedger, LedgerKind } from "../../src/persist/item-ledger.js";
import { defRemap, heldFromLedger, rebakeKeepingHeld } from "../../src/items/rebake.js";
import type { PoolItemLike } from "../../src/items/index.js";

const oldPool = bakeLootPool({ size: 200, seed: 1 }).items as unknown as PoolItemLike[];

describe("rebake keeps held items", () => {
  it("holds bag and hand items once each, not ground items", () => {
    const l = new ItemLedger(new Database(":memory:"));
    l.record(LedgerKind.Bag, 1, 7, 5, 0, 1);
    l.record(LedgerKind.Bag, 2, 7, 5, 1, 1);
    l.record(LedgerKind.Hold, 3, 3, 5, 0, 1);
    l.record(LedgerKind.Ground, 4, 9, 0, 0, 1, 1, 1);
    l.flush();
    const held = heldFromLedger(l.load(), oldPool);
    assert.deepEqual(held.map((h) => h.id), [oldPool[3].id, oldPool[7].id]);
  });

  it("the new pool still has every held item, and the ledger points at it", () => {
    const l = new ItemLedger(new Database(":memory:"));
    l.record(LedgerKind.Bag, 1, 7, 5, 0, 4);
    l.record(LedgerKind.Hold, 2, 3, 5, 0, 6);
    l.record(LedgerKind.Ground, 3, 9, 0, 0, 1, 2, 3);
    l.flush();
    const idOf = (d: number): string => oldPool[d].id;
    const r = rebakeKeepingHeld(l, oldPool, { size: 200, seed: 2 });
    const ids = new Set(r.pool.map((p) => p.id));
    assert.ok(ids.has(idOf(7)) && ids.has(idOf(3)));
    assert.equal(r.held, 2);
    const byId = new Map(l.load().map((x) => [x.id, x]));
    assert.equal(r.pool[byId.get(1)!.def].id, idOf(7), "bag item is still the same pool item");
    assert.equal(r.pool[byId.get(2)!.def].id, idOf(3), "held item is still the same pool item");
    assert.equal(byId.get(1)!.durability, 4);
    assert.equal(byId.get(2)!.kind, LedgerKind.Hold);
    // A ground item survives only if its entry happens to be in the new pool.
    assert.equal(byId.has(3), ids.has(idOf(9)));
    assert.equal(r.moved + r.destroyed, 3);
  });

  it("an empty ledger rebakes to a plain pool", () => {
    const l = new ItemLedger(new Database(":memory:"));
    const r = rebakeKeepingHeld(l, oldPool, { size: 50, seed: 3 });
    assert.equal(r.pool.length, 50);
    assert.equal(r.held, 0);
    assert.ok(defRemap(oldPool, r.pool).size <= 50);
  });
});
