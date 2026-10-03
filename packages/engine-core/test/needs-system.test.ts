/** NeedsSystem (U3): drain, exertion, starvation damage, restore. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { parseRules } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { NeedsSystem } from "../src/stats/needs-system.js";

const DT = 1 / 30;
const rules = parseRules({}).needs;

function setup(): { sim: SimWorld; e: number; sys: NeedsSystem; run(ticks: number): void } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const e = sim.spawn();
  for (const c of [C.Needs, C.Health, C.PlayerIntent]) {
    addComponent(sim.ecs, c, e);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Needs.hunger[e] = C.Needs.hungerMax[e] = 100;
  C.Needs.thirst[e] = C.Needs.thirstMax[e] = 100;
  C.Health.current[e] = C.Health.max[e] = 100;
  const sys = new NeedsSystem(rules);
  let tick = 0;
  return {
    sim, e, sys,
    run(ticks) {
      for (let i = 0; i < ticks; i++) {
        sim.beginTick(++tick);
        sys.step(sim, DT);
        sim.endTick();
      }
    },
  };
}

describe("NeedsSystem", () => {
  it("drains hunger and thirst at the rules' per-minute rates", () => {
    const { e, run } = setup();
    run(60 * 30);
    assert.ok(Math.abs(C.Needs.hunger[e] - 98) < 0.01);
    assert.ok(Math.abs(C.Needs.thirst[e] - 97) < 0.01);
  });

  it("drains faster while running", () => {
    const { e, run } = setup();
    C.PlayerIntent.mx[e] = 1;
    run(60 * 30);
    assert.ok(Math.abs(C.Needs.hunger[e] - 97) < 0.01);
  });

  it("hurts only once a meter is empty, and floors at zero", () => {
    const { e, run } = setup();
    C.Needs.thirst[e] = 0;
    run(30);
    assert.ok(Math.abs(C.Health.current[e] - 99) < 0.01);
    assert.equal(C.Needs.thirst[e], 0);
    C.Needs.hunger[e] = 0;
    run(30);
    assert.ok(Math.abs(C.Health.current[e] - 97) < 0.01);
  });

  it("leaves the dead alone", () => {
    const { e, run } = setup();
    C.Needs.hunger[e] = 50;
    C.Health.current[e] = 0;
    run(30);
    assert.equal(C.Needs.hunger[e], 50);
  });

  it("restore refills up to the max", () => {
    const { e, sys } = setup();
    C.Needs.hunger[e] = 10;
    sys.restore(e, "hunger", 30);
    assert.equal(C.Needs.hunger[e], 40);
    sys.restore(e, "hunger", 1000);
    assert.equal(C.Needs.hunger[e], 100);
  });

  it("keeps a meter's fraction when the rules' max changes", () => {
    const { sim, e } = setup();
    C.Needs.hunger[e] = 50;
    const sys = new NeedsSystem({ ...rules, hunger: { ...rules.hunger, max: 200, drainPerMinute: 0 } });
    sim.beginTick(1);
    sys.step(sim, DT);
    assert.equal(C.Needs.hungerMax[e], 200);
    assert.equal(C.Needs.hunger[e], 100);
  });
});
