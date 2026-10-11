/** BagPanel helpers (M3a, U10a): stat order, hand slots, swap comparison, held totals. */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ItemView } from "@mmo-engine/protocol";
import { compareStats, displaced, slotFor, statLines, sumStats } from "../src/ui/bag-panel.js";

function item(id: number, hand: ItemView["hand"], stats: Record<string, number>, slot?: string): ItemView {
  return { id, def: `d${id}`, name: `item ${id}`, base: "sword", rank: "common", color: "#ffffff", hand, stats, durability: 10, model: "", ...(slot !== undefined ? { slot } : {}) };
}

describe("statLines", () => {
  it("orders known stats first, then the rest alphabetically, dropping zeros", () => {
    assert.deepEqual(statLines({ fire: 3, crit: 5, power: 12, armour: 0, lifesteal: 2 }), [
      ["power", 12],
      ["crit", 5],
      ["fire", 3],
      ["lifesteal", 2],
    ]);
  });
});

describe("slotFor", () => {
  it("puts two-handed items in main, off-hand in off, and nothing for unholdable items", () => {
    assert.equal(slotFor(item(1, "main", {})), "main");
    assert.equal(slotFor(item(1, "both", {})), "main");
    assert.equal(slotFor(item(1, "off", {})), "off");
    assert.equal(slotFor(item(1, "none", {})), null);
  });

  it("puts armour in its slot", () => {
    assert.equal(slotFor(item(1, "none", {}, "head")), "head");
    assert.equal(slotFor(item(1, "none", {}, "ring")), "ring");
    assert.equal(slotFor(item(1, "none", {})), null);
  });
});

describe("displaced", () => {
  const sword = item(1, "main", { power: 10 });
  const shield = item(2, "off", { armour: 8, block: 4 });
  const greataxe = item(3, "both", { power: 20 });

  it("follows the server's swap rules", () => {
    assert.deepEqual(displaced(item(9, "main", {}), { main: sword, off: shield }), [sword]);
    assert.deepEqual(displaced(item(9, "off", {}), { main: sword, off: shield }), [shield]);
    assert.deepEqual(displaced(item(9, "off", {}), { main: greataxe, off: null }), [greataxe]);
    assert.deepEqual(displaced(item(9, "both", {}), { main: sword, off: shield }), [sword, shield]);
    assert.deepEqual(displaced(item(9, "main", {}), { main: null, off: shield }), []);
    assert.deepEqual(displaced(item(9, "none", {}), { main: sword, off: shield }), []);
  });

  it("displaces only the worn piece in the same armour slot", () => {
    const helm = item(4, "none", { armour: 6 }, "head");
    const worn = { head: item(5, "none", { armour: 4 }, "head"), chest: null, hands: null, legs: null, ring: null, amulet: null };
    assert.deepEqual(displaced(helm, { main: sword, off: shield }, worn), [worn.head]);
    assert.deepEqual(displaced(helm, { main: sword, off: shield }, { head: null, chest: null, hands: null, legs: null, ring: null, amulet: null }), []);
    assert.deepEqual(compareStats(helm, { main: sword, off: shield }, worn), [["armour", 2]]);
  });

  it("compares a two-handed item against both hands", () => {
    assert.deepEqual(compareStats(item(9, "both", { power: 18, crit: 2 }), { main: sword, off: shield }), [
      ["power", 8],
      ["armour", -8],
      ["block", -4],
      ["crit", 2],
    ]);
  });

  it("drops stats that don't change", () => {
    assert.deepEqual(compareStats(item(9, "main", { power: 10 }), { main: sword, off: null }), []);
  });
});

describe("sumStats", () => {
  it("adds the held items' stats and skips empty hands", () => {
    assert.deepEqual(sumStats([item(1, "main", { power: 10, crit: 1 }), null, item(2, "off", { armour: 8, crit: 2 })]), {
      power: 10,
      crit: 3,
      armour: 8,
    });
  });
});
