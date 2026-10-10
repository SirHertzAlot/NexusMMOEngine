import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSlot, createStore } from "../src/store.js";

describe("store", () => {
  it("get, set and subscribe", () => {
    const s = createStore(1);
    const seen: number[] = [];
    const off = s.subscribe(() => seen.push(s.get()));
    s.set(2);
    s.set((v) => v + 1);
    off();
    s.set(9);
    assert.deepEqual(seen, [2, 3]);
    assert.equal(s.get(), 9);
  });

  it("a set to an equal value is silent", () => {
    const s = createStore({ id: "a" }, (x, y) => x.id === y.id);
    let n = 0;
    s.subscribe(() => n++);
    s.set({ id: "a" });
    s.set({ id: "b" });
    assert.equal(n, 1);
  });

  it("an always-unequal store notifies every set", () => {
    const s = createStore(0, () => false);
    let n = 0;
    s.subscribe(() => n++);
    s.set(0);
    s.set(0);
    assert.equal(n, 2);
  });
});

describe("slot", () => {
  it("a claim shows until released", () => {
    const slot = createSlot<string>();
    assert.equal(slot.get(), null);
    const release = slot.claim("a");
    assert.equal(slot.get(), "a");
    release();
    assert.equal(slot.get(), null);
  });

  it("an old release does not clear a newer claim", () => {
    const slot = createSlot<{ n: number }>();
    const first = { n: 1 };
    const releaseFirst = slot.claim(first);
    const second = { n: 2 };
    slot.claim(second);
    releaseFirst();
    assert.equal(slot.get(), second);
  });
});
