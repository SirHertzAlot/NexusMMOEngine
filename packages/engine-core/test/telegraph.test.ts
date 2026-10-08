/**
 * TelegraphSystem: shape tests, warn -> resolve, cancellation, and the
 * rule that only the living inside the shape are hit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { inShape, TelegraphSystem } from "../src/telegraph.js";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";

function spawnAt(sim: SimWorld, x: number, z: number, hp = 100): number {
  const e = sim.spawn();
  for (const c of [C.Transform, C.Health]) {
    addComponent(sim.ecs, c, e);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Transform.px[e] = x;
  C.Transform.pz[e] = z;
  C.Health.current[e] = hp;
  C.Health.max[e] = hp;
  return e;
}

describe("inShape", () => {
  it("circle: inside the radius, outside beyond it", () => {
    const s = { kind: "circle", x: 0, z: 0, r: 3 } as const;
    assert.equal(inShape(s, 2, 2), true);
    assert.equal(inShape(s, 3, 3), false);
  });

  it("cone: the facing wedge only", () => {
    // Facing +Z (yaw 0), 90-degree cone, range 5.
    const s = { kind: "cone", x: 0, z: 0, yaw: 0, range: 5, halfAngle: Math.PI / 4 } as const;
    assert.equal(inShape(s, 0, 4), true, "dead ahead");
    assert.equal(inShape(s, 0, -4), false, "behind");
    assert.equal(inShape(s, 4, 0), false, "to the side");
    assert.equal(inShape(s, 0, 6), false, "out of range");
  });

  it("rect: the lane ahead of the caster", () => {
    // Facing +X (yaw PI/2), 6 long, 2 wide.
    const s = { kind: "rect", x: 0, z: 0, yaw: Math.PI / 2, length: 6, width: 2 } as const;
    assert.equal(inShape(s, 3, 0), true, "in the lane");
    assert.equal(inShape(s, 3, 2), false, "too far across");
    assert.equal(inShape(s, -1, 0), false, "behind the start");
    assert.equal(inShape(s, 7, 0), false, "past the end");
  });
});

describe("TelegraphSystem", () => {
  it("warns, then hits only the living inside the shape", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const caster = spawnAt(sim, 0, 0);
    const inside = spawnAt(sim, 1, 1);
    const outside = spawnAt(sim, 10, 10);
    const dead = spawnAt(sim, 1, 0, 0);

    const t = new TelegraphSystem(30);
    const id = t.cast(sim, { source: caster, shape: { kind: "circle", x: 0, z: 0, r: 3 }, warnMs: 1000, amount: 25 }, 10);
    let ev = t.drainEvents();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].state, "warned");
    assert.equal(ev[0].ticksUntilHit, 30);

    t.step(sim, 10 + 30);
    ev = t.drainEvents();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].state, "resolved");
    assert.deepEqual(
      ev[0].hits!.map((h) => h.target).sort(),
      [inside],
      "the caster, the outsider and the dead are untouched",
    );
    assert.equal(C.Health.current[inside], 75);
    assert.equal(C.Health.current[outside], 100);
    assert.ok(id > 0);
  });

  it("a cancelled telegraph never resolves", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const caster = spawnAt(sim, 0, 0);
    const inside = spawnAt(sim, 1, 1);

    const t = new TelegraphSystem(30);
    const id = t.cast(sim, { source: caster, shape: { kind: "circle", x: 0, z: 0, r: 3 }, warnMs: 1000, amount: 25 }, 10);
    assert.equal(t.cancel(id, 20), true);
    t.step(sim, 10 + 30);
    const ev = t.drainEvents();
    assert.equal(ev[ev.length - 1].state, "cancelled");
    assert.equal(C.Health.current[inside], 100, "no damage");
  });

  it("cancelFrom clears every telegraph a dead caster left behind", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const caster = spawnAt(sim, 0, 0);

    const t = new TelegraphSystem(30);
    t.cast(sim, { source: caster, shape: { kind: "circle", x: 0, z: 0, r: 3 }, warnMs: 1000, amount: 25 }, 10);
    t.cast(sim, { source: caster, shape: { kind: "circle", x: 5, z: 5, r: 2 }, warnMs: 2000, amount: 10 }, 10);
    assert.equal(t.cancelFrom(caster, 15), 2);
    t.step(sim, 10 + 60);
    assert.ok(!t.drainEvents().some((e) => e.state === "resolved"), "nothing resolved");
  });

  it("damageOf overrides the fixed amount per target", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const caster = spawnAt(sim, 0, 0);
    const a = spawnAt(sim, 1, 0);
    const b = spawnAt(sim, 0, 1);

    const t = new TelegraphSystem(30);
    t.cast(
      sim,
      {
        source: caster,
        shape: { kind: "circle", x: 0, z: 0, r: 3 },
        warnMs: 500,
        amount: 25,
        damageOf: (target) => (target === a ? 40 : 10),
      },
      10,
    );
    t.step(sim, 10 + 15);
    assert.equal(C.Health.current[a], 60);
    assert.equal(C.Health.current[b], 90);
  });
});
