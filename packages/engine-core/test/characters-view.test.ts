/**
 * Character record view (roadmap E10): the read-only data gathering in
 * src/characters/character-view.ts, over temp and in-memory databases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engineDefaults } from "@mmo-engine/rules";
import {
  listCharacters,
  readCharacterView,
  SqliteCharacterStore,
  summarizeLook,
} from "../src/index.js";
import { ItemDefs, type PoolItemLike } from "../src/items/index.js";
import { ItemLedger, LedgerKind } from "../src/persist/item-ledger.js";

const LOOK = '{"gender":"female","parts":{"hair":"Chr_Hair_03"},"colours":{"skin":"#8d5524"}}';

function makePool(): PoolItemLike[] {
  return ["a", "b"].map((id, i) => ({
    id,
    rank: "common",
    source: "mob",
    item: "sword",
    seed: i,
    bundle: {
      Identity: { id, name: `Sword ${id}`, base: "sword" },
      Rank: { id: "common", color: "#ffffff" },
      Stats: {},
    },
  }));
}

describe("summarizeLook", () => {
  it("reduces canonical JSON to gender, parts and colours", () => {
    assert.deepEqual(summarizeLook(LOOK), {
      gender: "female",
      parts: [{ slot: "hair", name: "Chr_Hair_03" }],
      colours: [{ slot: "skin", value: "#8d5524" }],
      ok: true,
    });
  });

  it("reports a stored non-look instead of throwing", () => {
    const s = summarizeLook("not json at all");
    assert.equal(s.ok, false);
    assert.equal(s.gender, "unknown");
    assert.deepEqual(s.parts, []);
  });
});

describe("character record view", () => {
  it("gathers name, look, deaths, saved state and items read-only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-charview-"));
    const store = new SqliteCharacterStore(path.join(dir, "characters.db"), () => 5);
    const worldDb = new Database(":memory:");
    let charsDb: Database.Database | null = null;
    try {
      const alice = await store.create("alice", "Brienne", LOOK, 8);
      await store.create("bob", "Gilly", LOOK, 8);
      await store.recordDeath!(alice.id, { at: 100, x: 1, z: 2, killer: null });
      await store.recordDeath!(alice.id, { at: 200, x: 3, z: 4, killer: 9 });
      store.saveState!(alice.id, { x: 10, y: 2, z: -3, health: 55, stamina: 9 });

      const defs = new ItemDefs(makePool(), engineDefaults());
      const ledger = new ItemLedger(worldDb);
      ledger.tick = 7;
      ledger.record(LedgerKind.Create, 1, 0, 0, 0, 10);
      ledger.record(LedgerKind.Bag, 1, 0, alice.id, 2, 9);
      ledger.record(LedgerKind.Create, 2, 1, 0, 0, 5);
      ledger.record(LedgerKind.Hold, 2, 1, alice.id, 0, 5);
      ledger.record(LedgerKind.Create, 3, 0, 0, 0, 8);
      ledger.record(LedgerKind.Ground, 3, 0, alice.id, 0, 8, 4, 6);
      ledger.record(LedgerKind.Create, 4, 0, 0, 0, 1);
      ledger.record(LedgerKind.Bag, 4, 0, 999, 0, 1);
      ledger.record(LedgerKind.Create, 5, 0, 0, 0, 1);
      ledger.record(LedgerKind.Destroy, 5, 0, alice.id, 0, 1);
      ledger.flush();

      // Read back through a read-only handle, like the editor does.
      const ro = new Database(path.join(dir, "characters.db"), { readonly: true });
      charsDb = ro;

      assert.deepEqual(
        listCharacters(ro, "alice").map((c) => c.name),
        ["Brienne"],
      );
      assert.equal(listCharacters(ro, "alice")[0]?.username, "alice");
      assert.equal(listCharacters(ro, "nobody").length, 0);

      const view = readCharacterView(ro, "alice", alice.id, { worldDb, defs });
      assert(view !== null);
      assert.equal(view.name, "Brienne");
      assert.equal(view.username, "alice");
      assert.equal(view.createdAt, 5);
      assert.equal(view.lookJson, LOOK);
      assert.equal(view.look.gender, "female");
      assert.deepEqual(view.deaths, [
        { at: 100, x: 1, z: 2, killer: null },
        { at: 200, x: 3, z: 4, killer: 9 },
      ]);
      assert.deepEqual(view.state, { x: 10, y: 2, z: -3, health: 55, stamina: 9 });
      assert.deepEqual(
        view.items.map((i) => [i.id, i.where, i.name, i.durability]),
        [
          [1, "bag", "Sword a", 9],
          [2, "held", "Sword b", 5],
          [3, "ground", "Sword a", 8],
        ],
      );
      assert.equal(view.items[0]?.slot, 2);
      assert.equal(view.items[2]?.x, 4);
      assert.equal(view.items[2]?.z, 6);

      // Someone else's character is not visible under this account.
      assert.equal(readCharacterView(ro, "bob", alice.id, { worldDb, defs }), null);
      assert.equal(readCharacterView(ro, "alice", 9999, { worldDb, defs }), null);

      // Without the world database there are no items, but the rest loads.
      const noItems = readCharacterView(ro, "alice", alice.id);
      assert(noItems !== null);
      assert.deepEqual(noItems.items, []);
      assert.equal(noItems.deaths.length, 2);

      // Without definitions the rows fall back to `def <n>` placeholders.
      const noDefs = readCharacterView(ro, "alice", alice.id, { worldDb });
      assert(noDefs !== null && noDefs.items.length === 3);
      assert.equal(noDefs.items[0]?.name, "def 0");
    } finally {
      charsDb?.close();
      worldDb.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a never-saved character has no state, deaths or items", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-charview-"));
    const store = new SqliteCharacterStore(path.join(dir, "characters.db"), () => 5);
    const worldDb = new Database(":memory:");
    let charsDb: Database.Database | null = null;
    try {
      const c = await store.create("alice", "Podrick", LOOK, 8);
      new ItemLedger(worldDb); // DDL only, no events.
      const ro = new Database(path.join(dir, "characters.db"), { readonly: true });
      charsDb = ro;
      const view = readCharacterView(ro, "alice", c.id, { worldDb });
      assert(view !== null);
      assert.equal(view.state, null);
      assert.deepEqual(view.deaths, []);
      assert.deepEqual(view.items, []);
    } finally {
      charsDb?.close();
      worldDb.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
