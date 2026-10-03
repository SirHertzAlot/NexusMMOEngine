/** MasterySystem (M1): swimming and running train their skills. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import { fileURLToPath } from "node:url";
import { loadRules } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { MasterySystem } from "../src/stats/mastery-system.js";

const DT = 1 / 30;
const skills = loadRules(fileURLToPath(new URL("../../../../content/rules", import.meta.url))).skills;

function setup(): { sim: SimWorld; e: number; sys: MasterySystem; run(seconds: number): void } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const e = sim.spawn();
  for (const c of [C.Health, C.PlayerIntent, C.Locomotion]) {
    addComponent(sim.ecs, c, e);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Health.current[e] = C.Health.max[e] = 100;
  const sys = new MasterySystem(skills, () => 1000);
  let tick = 0;
  return {
    sim, e, sys,
    run(seconds) {
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        sim.beginTick(++tick);
        sys.step(sim, DT);
        sim.endTick();
      }
    },
  };
}

describe("MasterySystem", () => {
  it("standing still trains nothing", () => {
    const { e, sys, run } = setup();
    run(60);
    assert.equal(sys.sheetOf(e).get("athletics"), 0);
  });

  it("running trains athletics, not swimming", () => {
    const { e, sys, run } = setup();
    C.PlayerIntent.mx[e] = 1;
    run(60);
    assert.ok(sys.sheetOf(e).get("athletics") > 0);
    assert.equal(sys.sheetOf(e).get("swimming"), 0);
  });

  it("swimming trains swimming", () => {
    const { e, sys, run } = setup();
    C.Locomotion.mode[e] = LocomotionMode.Swim;
    C.PlayerIntent.mz[e] = 1;
    run(60);
    assert.ok(sys.sheetOf(e).get("swimming") > 0);
  });

  it("the dead and forgotten train nothing", () => {
    const { e, sys, run } = setup();
    C.PlayerIntent.mx[e] = 1;
    C.Health.current[e] = 0;
    run(60);
    assert.equal(sys.sheetOf(e).get("athletics"), 0);
    sys.forget(e);
    assert.equal(sys.sheetOf(e).get("athletics"), 0);
  });
});
