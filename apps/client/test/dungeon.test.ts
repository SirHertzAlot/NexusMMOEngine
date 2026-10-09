import "./strings-setup.js";
/**
 * Dungeon runs (D4): the run clock, the result card's text, and which
 * entrance the player stands in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatClock, outcomeText, secondsLeft, unopenedChests, type DungeonState } from "../src/ui/dungeon.js";
import { entranceAt } from "../src/render/dungeon-entrances.js";

describe("formatClock and secondsLeft", () => {
  it("reads minutes and seconds, never below zero", () => {
    assert.equal(formatClock(725), "12:05");
    assert.equal(formatClock(2700), "45:00");
    assert.equal(formatClock(-3), "0:00");
  });

  it("counts down locally from the last state", () => {
    const st: DungeonState = { kind: "dungeon", op: "state", dungeon: "D", secondsLeft: 100, creaturesLeft: 3, bossLeft: 1, chests: [], traps: [] };
    assert.equal(secondsLeft(st, 1000, 3500), 97.5);
    assert.equal(secondsLeft(st, 0, 1_000_000), 0);
  });
});

describe("outcomeText", () => {
  it("names the outcome and the loot", () => {
    assert.equal(outcomeText({ kind: "dungeon", op: "ended", outcome: "cleared", items: 2 }).title, "Dungeon cleared");
    assert.equal(outcomeText({ kind: "dungeon", op: "ended", outcome: "cleared", items: 1 }).loot, "1 item waiting in your bag.");
    assert.equal(outcomeText({ kind: "dungeon", op: "ended", outcome: "timeout", items: 0 }).loot, "No loot this time.");
  });
});

describe("unopenedChests", () => {
  const st: DungeonState = {
    kind: "dungeon", op: "state", dungeon: "D", secondsLeft: 100, creaturesLeft: 3, bossLeft: 1,
    chests: [{ id: "chest-0", opened: false }, { id: "chest-1", opened: true }],
    traps: [],
  };
  it("lists closed chests, none without a state", () => {
    assert.deepEqual(unopenedChests(st), ["chest-0"]);
    assert.deepEqual(unopenedChests(null), []);
  });

  it("is empty when every chest is opened", () => {
    assert.deepEqual(unopenedChests({ ...st, chests: [{ id: "chest-0", opened: true }] }), []);
  });
});

describe("entranceAt", () => {
  const gates = [
    { id: "a", name: "A", x: 0, z: 0, radius: 8 },
    { id: "b", name: "B", x: 10, z: 0, radius: 4 },
  ];
  it("finds the ring the player stands in, the nearest centre when rings overlap", () => {
    assert.equal(entranceAt(gates, 2, 0)?.id, "a");
    assert.equal(entranceAt(gates, 7, 0)?.id, "b");
    assert.equal(entranceAt(gates, 0, 20), null);
  });
});
