/**
 * World chests: shared (the first to open gets the loot), out of reach
 * refused, empty until the refill timer, then full again; changes are drained
 * once for the push to clients.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import { BodyConfig, Transform } from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { ChestSystem } from "../../src/interact/index.js";

function at(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  addComponent(sim.ecs, Transform, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  return e;
}

function setup() {
  const clock = { t: 1_000_000 };
  const drops: Array<[string, number, number, number]> = [];
  const chests = new ChestSystem({ drop: (_s, table, x, z, owner) => (drops.push([table, x, z, owner]), 2), now: () => clock.t });
  const sim = new SimWorld();
  const chest = at(sim, 10, 10);
  chests.register(chest, "town/chest-0", { table: "chest-common", refillSeconds: 60 });
  return { chests, sim, chest, clock, drops, near: at(sim, 11, 10), far: at(sim, 30, 10) };
}

describe("ChestSystem", () => {
  it("drops the table at the chest for the opener, refuses the far and the empty, and refills on a timer", () => {
    const { chests, sim, chest, clock, drops, near, far } = setup();
    assert.deepEqual(chests.open(sim, 7, far, chest), { ok: false, error: "too far away" });
    assert.deepEqual(chests.open(sim, 7, near, -1), { ok: false, error: "nothing to open there" });
    assert.deepEqual(chests.open(sim, 7, near, chest), { ok: true, items: 2 });
    assert.deepEqual(drops, [["chest-common", 10, 10, 7]]);
    assert.deepEqual(chests.open(sim, 8, near, chest), { ok: false, error: "the chest is empty" }, "shared: someone else finds it empty");
    clock.t += 59_000;
    chests.step();
    assert.equal(chests.views(sim)[0]!.open, true, "not yet");
    clock.t += 1_000;
    chests.step();
    assert.equal(chests.views(sim)[0]!.open, false);
    assert.equal(chests.open(sim, 8, near, chest).ok, true, "full again for the next player");
  });

  it("drains each change once", () => {
    const { chests, sim, chest, clock, near } = setup();
    assert.equal(chests.drainChanges(sim).length, 0);
    chests.open(sim, 7, near, chest);
    assert.deepEqual(chests.drainChanges(sim).map((v) => v.open), [true]);
    assert.equal(chests.drainChanges(sim).length, 0);
    clock.t += 60_000;
    chests.step();
    assert.deepEqual(chests.drainChanges(sim).map((v) => v.open), [false]);
  });
});

describe("ChestSystem: keys, casts and doors", () => {
  function keyed(consume: boolean) {
    const clock = { t: 1_000_000 };
    const bag = new Map<number, number>([[7, 1]]);
    const chests = new ChestSystem({
      drop: () => 1,
      has: (h, base) => base === "key" && (bag.get(h) ?? 0) > 0,
      take: (h, base) => base === "key" && (bag.get(h) ?? 0) > 0 && (bag.set(h, bag.get(h)! - 1), true),
      now: () => clock.t,
    });
    const sim = new SimWorld();
    const chest = at(sim, 10, 10);
    chests.register(chest, "arena/locked", { table: "chest-common", refillSeconds: 60, castSeconds: 3, requires: { base: "key", consume } });
    return { chests, sim, chest, bag, near: at(sim, 11, 10) };
  }

  it("asks for a key, says how long it takes, and uses the key up only when told to", () => {
    const { chests, sim, chest, bag, near } = keyed(true);
    assert.deepEqual(chests.check(sim, 8, near, chest), { ok: false, error: "it is locked: you need a key" });
    assert.deepEqual(chests.check(sim, 7, near, chest), { ok: true, castSeconds: 3, spell: "chest" });
    assert.equal(bag.get(7), 1, "checking costs nothing");
    assert.equal(chests.open(sim, 7, near, chest).ok, true);
    assert.equal(bag.get(7), 0, "consumed");
    const kept = keyed(false);
    kept.chests.open(kept.sim, 7, kept.near, kept.chest);
    assert.equal(kept.bag.get(7), 1, "kept");
  });

  it("a door opens and shuts, and its collider goes while it stands open", () => {
    const sim = new SimWorld();
    const chests = new ChestSystem({ drop: () => 0, has: () => true });
    const door = at(sim, 10, 10);
    addComponent(sim.ecs, BodyConfig, door);
    BodyConfig.shapeKind[door] = 0;
    BodyConfig.halfX[door] = 1.5;
    BodyConfig.halfY[door] = 1.5;
    BodyConfig.halfZ[door] = 0.25;
    BodyConfig.friction[door] = 0.5;
    chests.register(door, "arena/door", { kind: "door", requires: { base: "key", consume: false } });
    const near = at(sim, 11, 10);
    assert.equal(chests.open(sim, 7, near, door).ok, true);
    assert.equal(hasComponent(sim.ecs, BodyConfig, door), false, "open: no body");
    assert.deepEqual(chests.views(sim).map((v) => [v.kind, v.open]), [["door", true]]);
    assert.equal(chests.open(sim, 7, near, door).ok, true);
    assert.equal(hasComponent(sim.ecs, BodyConfig, door), true, "shut: the body is back");
    assert.deepEqual([BodyConfig.halfX[door], BodyConfig.halfZ[door], BodyConfig.friction[door]], [1.5, 0.25, 0.5], "as it was");
    assert.equal(chests.views(sim)[0]!.open, false);
  });
});
