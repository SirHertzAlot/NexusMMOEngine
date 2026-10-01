/**
 * StaminaSystem (U2): flat costs for dodges, attacks and jumps, per-second
 * drains for swimming and running, and cooldown-gated regen. CombatSystem
 * gates move starts through spend(): denied starts never fire.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { IntentButton, LocomotionMode, Move } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CombatSystem } from "../src/combat.js";
import { IntentSystem } from "../src/systems.js";
import {
  ATTACK_COST,
  DODGE_COST,
  JUMP_COST,
  StaminaSystem,
} from "../src/stats/stamina-system.js";

const DT = 1 / 30;

function setup(withLocomotion: boolean): {
  sim: SimWorld;
  e: number;
  stamina: StaminaSystem;
  run(ticks: number, intent?: { buttons?: number; jump?: boolean; mx?: number; mz?: number; my?: number }): void;
} {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const e = sim.spawn();
  const comps = withLocomotion
    ? [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Stamina, C.Locomotion]
    : [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Stamina];
  for (const c of comps) {
    addComponent(sim.ecs, c, e);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Transform.qw[e] = 1;
  C.Stamina.current[e] = 100;
  C.Stamina.max[e] = 100;
  const stamina = new StaminaSystem();
  const systems = [new IntentSystem(), new CombatSystem(30, stamina), stamina];
  let tick = 0;
  return {
    sim,
    e,
    stamina,
    run(ticks, intent = {}) {
      for (let i = 0; i < ticks; i++) {
        sim.queueIntent(e, {
          mx: intent.mx ?? 0, my: intent.my ?? 0, mz: intent.mz ?? 0,
          lookYaw: 0, lookPitch: 0, jump: intent.jump ?? false, buttons: intent.buttons ?? 0,
        });
        sim.beginTick(++tick);
        for (const s of systems) s.step(sim, DT);
        sim.endTick();
      }
    },
  };
}

describe("StaminaSystem", () => {
  it("a dodge roll starts and spends its cost", () => {
    const w = setup(false);
    w.run(1, { buttons: IntentButton.Dodge });
    assert.equal(C.Action.move[w.e], Move.Roll);
    assert.equal(C.Stamina.current[w.e], 100 - DODGE_COST);
  });

  it("a dodge is denied below its cost and fires nothing", () => {
    const w = setup(false);
    assert.equal(w.stamina.spend(w.sim, w.e, 100 - (DODGE_COST - 1)), true, "setup: spend down to 19");
    w.run(1, { buttons: IntentButton.Dodge });
    assert.equal(C.Action.move[w.e], Move.None);
    assert.equal(C.Stamina.current[w.e], DODGE_COST - 1, "denied spends nothing (and cooldown blocks regen)");
  });

  it("attacks spend, guards stay free", () => {
    const w = setup(false);
    w.run(1, { buttons: IntentButton.Attack });
    assert.equal(C.Action.move[w.e], Move.SwordA);
    assert.equal(C.Stamina.current[w.e], 100 - ATTACK_COST);
  });

  it("spend() deducts once and denies when short", () => {
    const w = setup(false);
    assert.equal(w.stamina.spend(w.sim, w.e, 30), true);
    assert.equal(C.Stamina.current[w.e], 70);
    assert.equal(w.stamina.spend(w.sim, w.e, 71), false);
    assert.equal(C.Stamina.current[w.e], 70);
  });

  it("jumps cost on the rising edge only", () => {
    const w = setup(false);
    w.run(1, { jump: true });
    assert.equal(C.Stamina.current[w.e], 100 - JUMP_COST);
    w.run(3, { jump: true });
    assert.equal(C.Stamina.current[w.e], 100 - JUMP_COST, "held, not pressed");
  });

  it("running drains per second and regen returns it after the cooldown", () => {
    const w = setup(false);
    w.run(30, { mx: 1 });
    const drained = C.Stamina.current[w.e];
    assert.ok(drained < 100 && drained > 90, `run drain after 1 s: ${drained}`);
    w.run(31);
    assert.ok(C.Stamina.current[w.e] > drained, "regen after the cooldown");
    w.run(300);
    assert.equal(C.Stamina.current[w.e], 100, "regen clamps at max");
  });

  it("swimming drains while moving, not while still", () => {
    const w = setup(true);
    C.Locomotion.mode[w.e] = LocomotionMode.Swim;
    w.run(30);
    assert.equal(C.Stamina.current[w.e], 100, "still water costs nothing");
    w.run(30, { mx: 1 });
    assert.ok(C.Stamina.current[w.e] < 100, "moving water costs");
  });

  it("the pool floors at zero", () => {
    const w = setup(false);
    C.Stamina.current[w.e] = 1;
    w.run(30, { mx: 1 });
    assert.equal(C.Stamina.current[w.e], 0);
  });
});
