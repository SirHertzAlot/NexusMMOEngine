/**
 * Combat resolution as rules (EG6): reach, cone, height, the unskilled
 * guard, fight difficulty and the fist come from combat.json's `resolution`
 * and items.json's `unarmed`, read each strike; the defaults are the values
 * that were code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { combatMove, IntentButton, Move } from "@mmo-engine/protocol";
import { parseRules } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { ARM_REACH, CombatSystem, DEFAULT_COMBAT_TUNING, FIGHT_DIFFICULTY, GUARD_FACTOR, type CombatSkills, type CombatTuning, type Weapon } from "../src/combat.js";
import { IntegrateSystem, IntentSystem } from "../src/systems.js";
import { loadGameRules } from "../src/rules/boot.js";

const DT = 1 / 30;
const { hooks } = loadGameRules();
const SWORD: Weapon = { technique: "cut", item: { mass: 1.2, edge: 0.8, point: 0.3, hardness: 0.6 }, reach: 0.9 };
const tuningOf = (over: { combat?: object; items?: object }): CombatTuning => {
  const r = parseRules(over);
  return { resolution: r.combat.resolution, unarmed: r.items.unarmed };
};

function setup(weapon: Weapon | null, tuning: () => CombatTuning, skills?: CombatSkills) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const make = (comps: object[], x: number, z: number): number => {
    const e = sim.spawn();
    for (const c of comps) {
      addComponent(sim.ecs, c, e);
      for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
    }
    C.Transform.qw[e] = 1;
    C.Transform.px[e] = x;
    C.Transform.pz[e] = z;
    return e;
  };
  const e = make([C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Health], 0, 0);
  C.Health.current[e] = C.Health.max[e] = 100;
  const target = (x: number, z: number, withAction = false): number => {
    const t = make(withAction ? [C.Transform, C.Health, C.Action] : [C.Transform, C.Health], x, z);
    C.Health.current[t] = C.Health.max[t] = 100;
    return t;
  };
  const combat = new CombatSystem(30, undefined, { hooks, weaponOf: () => weapon, skills, tuning });
  const systems = [new IntentSystem(), combat, new IntegrateSystem()];
  let tick = 0;
  const run = (n: number, buttons: number): void => {
    for (let i = 0; i < n; i++) {
      sim.queueIntent(e, { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons });
      sim.beginTick(++tick);
      for (const s of systems) s.step(sim, DT);
      sim.endTick();
    }
  };
  const swing = (): void => run(1 + Math.round(combatMove(Move.SwordA)!.hitAt! * 30), IntentButton.Attack);
  /** Let the swing finish, hands still, and step back to where it started (a swing lunges). */
  const rest = (): void => {
    run(60, 0);
    C.Transform.px[e] = C.Transform.pz[e] = 0;
  };
  return { target, combat, swing, rest };
}

describe("combat resolution rules", () => {
  it("the defaults are the values that were code", () => {
    assert.deepEqual(DEFAULT_COMBAT_TUNING.resolution, { guardLetsThrough: 0.25, armReachM: 0.6, coneDegrees: 60, maxHeightDifferenceM: 2, fightDifficulty: 0.5 });
    assert.equal(GUARD_FACTOR, 0.25);
    assert.equal(ARM_REACH, 0.6);
    assert.equal(FIGHT_DIFFICULTY, 0.5);
    const u = DEFAULT_COMBAT_TUNING.unarmed;
    assert.deepEqual([u.mass, u.length, u.edge, u.point, u.hardness, u.technique], [0.5, 0.8, 0, 0, 0.3, "bludgeon"]);
  });

  it("a longer arm reaches farther", () => {
    const near = setup(SWORD, () => DEFAULT_COMBAT_TUNING);
    const t = near.target(0, 2); // 2 m: past 0.9 + 0.6
    near.swing();
    assert.equal(near.combat.drainHits().length, 0);
    const long = setup(SWORD, () => tuningOf({ combat: { resolution: { armReachM: 1.5 } } }));
    long.target(0, 2);
    long.swing();
    assert.equal(long.combat.drainHits()[0]?.outcome, "hit");
    void t;
  });

  it("the cone and the height limit come from the rules", () => {
    const wide = setup(SWORD, () => DEFAULT_COMBAT_TUNING);
    wide.target(0.4, 1); // ~22 degrees off the facing
    wide.swing();
    assert.equal(wide.combat.drainHits().length, 1);
    const narrow = setup(SWORD, () => tuningOf({ combat: { resolution: { coneDegrees: 10 } } }));
    narrow.target(0.4, 1);
    narrow.swing();
    assert.equal(narrow.combat.drainHits().length, 0);
    const flat = setup(SWORD, () => tuningOf({ combat: { resolution: { maxHeightDifferenceM: 1 } } }));
    const up = flat.target(0, 1);
    C.Transform.py[up] = 1.5; // within the default 2 m, above 1 m
    flat.swing();
    assert.equal(flat.combat.drainHits().length, 0);
  });

  it("an unskilled guard lets through the rules' share", () => {
    const open = setup(SWORD, () => DEFAULT_COMBAT_TUNING);
    open.target(0, 1);
    open.swing();
    const full = open.combat.drainHits()[0].amount;
    const w = setup(SWORD, () => tuningOf({ combat: { resolution: { guardLetsThrough: 0.5 } } }));
    const t = w.target(0, 1, true);
    C.Action.move[t] = Move.Guard;
    C.Action.yaw[t] = Math.PI;
    w.swing();
    assert.ok(Math.abs(100 - C.Health.current[t] - full * 0.5) < 1e-3);
  });

  it("training uses the rules' fight difficulty", () => {
    const seen: number[] = [];
    const skills: CombatSkills = { get: () => 0, train: (_e, _id, d) => void seen.push(d), techniqueSkill: () => "cutting" };
    const w = setup(SWORD, () => tuningOf({ combat: { resolution: { fightDifficulty: 0.8 } } }), skills);
    w.target(0, 1);
    w.swing();
    assert.ok(seen.length > 0 && seen.every((d) => d === 0.8), String(seen));
  });

  it("the fist is items.json's unarmed, and a change applies on the next strike", () => {
    let tuning = DEFAULT_COMBAT_TUNING;
    const w = setup(null, () => tuning);
    w.target(0, 1);
    w.swing();
    const soft = w.combat.drainHits()[0].amount;
    tuning = tuningOf({ items: { unarmed: { mass: 4, length: 0.8, edge: 0, point: 0, hardness: 0.3, technique: "bludgeon" } } });
    w.rest();
    w.swing();
    const hard = w.combat.drainHits()[0]?.amount ?? 0;
    assert.ok(hard > soft * 1.5, `${hard} vs ${soft}`);
  });
});
