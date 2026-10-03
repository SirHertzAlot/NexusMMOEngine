/**
 * Crash and replay over the item ledger (roadmap P2c): what a crash loses and
 * keeps, a flush that fails midway leaving nothing, restart cycles that don't
 * drift, and the full history replaying to the same state as the latest rows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { ItemLedger, LedgerKind } from "../../src/persist/item-ledger.js";
import { ItemStore, ItemWhere } from "../../src/items/index.js";

function tmpDb(): { file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-crash-"));
  return { file: path.join(dir, "world.db"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A new process: reopen the file, restore a store from the ledger. */
function boot(file: string): { ledger: ItemLedger; store: ItemStore } {
  const ledger = new ItemLedger(file);
  const store = new ItemStore(8, 3);
  for (const row of ledger.load()) store.restore(row);
  store.reserveIds(ledger.maxItemId());
  store.ledger = ledger;
  return { ledger, store };
}

describe("ItemLedger crash and replay", () => {
  it("a crash loses only what was recorded since the last flush", () => {
    const { file, done } = tmpDb();
    try {
      const a = boot(file);
      const kept = a.store.create(1, 10);
      a.store.putInBag(50, kept);
      a.ledger.flush();
      const lost = a.store.create(2, 20);
      a.store.putInBag(50, lost);
      assert.ok(a.ledger.pending > 0);
      a.ledger.close(); // killed: the pending events never reach disk

      const b = boot(file);
      assert.equal(b.store.size, 1);
      assert.equal(b.store.bag(50)[0], kept);
      assert.equal(b.store.exists(lost), false);
      assert.equal(b.store.create(0, 1), kept + 1, "the lost item's id was never written, so it is free again");
      b.ledger.close();
    } finally {
      done();
    }
  });

  it("a flush that fails midway writes nothing", () => {
    const { file, done } = tmpDb();
    try {
      const l = new ItemLedger(file);
      l.record(LedgerKind.Create, 1, 0, 0, 0, 1);
      l.flush();
      const db = new Database(file);
      db.exec(
        "CREATE TRIGGER boom BEFORE INSERT ON item_events WHEN NEW.item_id = 3 BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      );
      db.close();
      l.record(LedgerKind.Create, 2, 0, 0, 0, 1);
      l.record(LedgerKind.Create, 3, 0, 0, 0, 1);
      l.record(LedgerKind.Create, 4, 0, 0, 0, 1);
      assert.throws(() => l.flush(), /disk full/);
      assert.equal(l.pending, 3, "the events are kept for the next flush");
      l.close();

      const check = new ItemLedger(file);
      assert.deepEqual(check.load().map((r) => r.id), [1], "no half-written batch");
      assert.equal(check.count(), 1);
      check.close();
    } finally {
      done();
    }
  });

  it("an unclean close with a hot WAL still recovers every flushed event", () => {
    const { file, done } = tmpDb();
    try {
      const l = new ItemLedger(file);
      for (let i = 1; i <= 50; i++) l.record(LedgerKind.Ground, i, i % 4, 0, 0, i, i, i);
      l.flush();
      // not closed: the WAL may hold the rows, as after a kill
      const b = boot(file);
      assert.equal(b.store.size, 50);
      b.ledger.close();
      l.close();
    } finally {
      done();
    }
  });

  it("repeated restarts neither duplicate nor drop items, and ids keep climbing", () => {
    const { file, done } = tmpDb();
    try {
      let last = 0;
      for (let cycle = 0; cycle < 5; cycle++) {
        const { ledger, store } = boot(file);
        assert.equal(store.size, cycle * 2, `cycle ${cycle}: items carried over`);
        const bagged = store.create(1, 5);
        store.putInBag(60 + cycle, bagged);
        const dropped = store.create(2, 6);
        store.placeOnGround(dropped, 0, cycle, -cycle);
        assert.ok(bagged > last && dropped > bagged, "ids never reused across restarts");
        last = dropped;
        ledger.flush();
        ledger.close();
      }
      const { ledger, store } = boot(file);
      assert.equal(store.size, 10);
      for (let c = 0; c < 5; c++) assert.equal(store.bag(60 + c).length > 0, true);
      ledger.close();
    } finally {
      done();
    }
  });

  it("replaying the whole history gives the same state as the latest rows", () => {
    const { file, done } = tmpDb();
    try {
      const a = boot(file);
      const sword = a.store.create(1, 10);
      const potion = a.store.create(2, 3);
      const rock = a.store.create(3, 1);
      a.store.putInBag(7, sword);
      a.store.hold(7, sword, 0);
      a.store.putInBag(7, potion);
      a.store.placeOnGround(potion, 0, 3, 4);
      a.store.putInBag(8, potion);
      a.store.placeOnGround(rock, 0, 9, 9);
      a.store.destroy(rock);
      a.ledger.flush();
      a.ledger.close();

      const db = new Database(file, { readonly: true });
      const events = db
        .prepare("SELECT item_id AS id, kind, def, owner, slot, durability, x, z FROM item_events ORDER BY seq")
        .all() as { id: number; kind: number; def: number; owner: number; slot: number; durability: number; x: number; z: number }[];
      db.close();

      const replay = new Map<number, (typeof events)[number]>();
      for (const e of events) {
        if (e.kind === LedgerKind.Destroy) replay.delete(e.id);
        else replay.set(e.id, e);
      }
      const b = boot(file);
      const latest = b.ledger.load();
      assert.equal(latest.length, replay.size);
      for (const row of latest) assert.deepEqual(row, replay.get(row.id));
      assert.equal(b.store.where[b.store.slot(sword)], ItemWhere.Held);
      assert.equal(b.store.bag(8)[0], potion);
      assert.equal(b.store.exists(rock), false);
      assert.ok(events.length > latest.length, "history is kept, not overwritten");
      b.ledger.close();
    } finally {
      done();
    }
  });
});
