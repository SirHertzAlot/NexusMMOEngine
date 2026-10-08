/**
 * AbilitySystem: the GCD, per-ability cooldowns, the one-deep queue,
 * casts and interrupts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AbilitySystem } from "../src/abilities.js";
import type { SimWorld } from "../src/world.js";
const DT = 1 / 30;
const simAt = (tick: number): SimWorld => ({ currentTick: tick }) as SimWorld;

const HZ = 30;
const ticks = (ms: number): number => Math.round((ms / 1000) * HZ);

function setup(fired: Array<[number, string]>): AbilitySystem {
  const s = new AbilitySystem(HZ, (e, id) => fired.push([e, id]));
  s.define({ id: "slash", gcdMs: 1000, cooldownMs: 0, castMs: 0 });
  s.define({ id: "fireball", gcdMs: 1000, cooldownMs: 5000, castMs: 2000 });
  s.define({ id: "potion", gcdMs: 500, cooldownMs: 30000, castMs: 0 });
  return s;
}

describe("AbilitySystem", () => {
  it("an instant ability fires at once and starts the GCD", () => {
    const fired: Array<[number, string]> = [];
    const s = setup(fired);
    assert.equal(s.trigger(1, "slash", 10), "fired");
    assert.deepEqual(fired, [[1, "slash"]]);
    assert.equal(s.gcdLeft(1, 10), ticks(1000));
    const ev = s.drainEvents();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].state, "fired");
  });

  it("a press during the GCD queues one deep; the latest press wins", () => {
    const fired: Array<[number, string]> = [];
    const s = setup(fired);
    s.trigger(1, "slash", 10);
    assert.equal(s.trigger(1, "potion", 11), "queued");
    assert.equal(s.trigger(1, "slash", 12), "queued"); // replaces potion
    s.step(simAt(10 + ticks(1000)), DT); // GCD clears
    assert.deepEqual(fired, [
      [1, "slash"],
      [1, "slash"],
    ]);
    assert.ok(!fired.some(([, id]) => id === "potion"), "potion was replaced in the queue");
  });

  it("an ability on cooldown is rejected, not queued", () => {
    const fired: Array<[number, string]> = [];
    const s = setup(fired);
    s.trigger(1, "potion", 10);
    // GCD (500ms) clears before the 30s cooldown does.
    s.step(simAt(10 + ticks(500)), DT);
    assert.equal(s.trigger(1, "potion", 10 + ticks(500) + 1), "rejected");
    assert.equal(s.cooldownLeft(1, "potion", 10 + ticks(500) + 1) > 0, true);
    const ev = s.drainEvents();
    assert.equal(ev[ev.length - 1].reason, "cooldown");
  });

  it("a cast emits casting, fires on completion, and can be interrupted", () => {
    const fired: Array<[number, string]> = [];
    const s = setup(fired);
    assert.equal(s.trigger(1, "fireball", 10), "fired"); // accepted -> casting
    assert.deepEqual(fired, [], "nothing fires until the cast completes");
    let ev = s.drainEvents();
    assert.equal(ev[ev.length - 1].state, "casting");

    assert.equal(s.interrupt(1, 20), true);
    assert.deepEqual(fired, [], "an interrupted cast fires nothing");
    ev = s.drainEvents();
    assert.equal(ev[ev.length - 1].state, "interrupted");

    s.trigger(1, "fireball", 30);
    s.step(simAt(30 + ticks(2000)), DT);
    assert.deepEqual(fired, [[1, "fireball"]]);
    assert.equal(s.gcdLeft(1, 30 + ticks(2000)) > 0, true, "the GCD starts when the cast lands");
  });

  it("unknown ids are rejected", () => {
    const s = setup([]);
    assert.equal(s.trigger(1, "nope", 10), "rejected");
    const ev = s.drainEvents();
    assert.equal(ev[ev.length - 1].reason, "unknown");
  });

  it("entities are independent", () => {
    const fired: Array<[number, string]> = [];
    const s = setup(fired);
    s.trigger(1, "slash", 10);
    assert.equal(s.trigger(2, "slash", 10), "fired", "entity 2 has its own GCD");
    assert.deepEqual(fired, [
      [1, "slash"],
      [2, "slash"],
    ]);
  });
});
