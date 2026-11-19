/**
 * Hitting a target at its body, not its pivot (DE4c): a modular building part is placed at its model's pivot (the top
 * of a wall, 2.5 m up), so `hitBody` gives the middle and the box's reach, and a wall can be hit from its foot.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { combatMove, IntentButton, Move } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CombatSystem, GUARD_FACTOR, type CombatSkills, type Weapon } from "../src/combat.js";
import { IntegrateSystem, IntentSystem } from "../src/systems.js";
import { loadGameRules } from "../src/rules/boot.js";

const DT = 1 / 30;
const { hooks } = loadGameRules();
const SWORD: Weapon = { technique: "cut", item: { mass: 1.2, edge: 0.8, point: 0.3, hardness: 0.6 }, reach: 0.9 };

function setup(hitBody?: (t: number) => { x: number; y: number; z: number; rx: number; ry: number } | undefined, weapon: Weapon | null = SWORD, skills?: CombatSkills, armourOf?: (target: number) => number) {
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
  const combat = new CombatSystem(30, undefined, { hooks, weaponOf: () => weapon, skills, armourOf, hitBody });
  const systems = [new IntentSystem(), combat, new IntegrateSystem()];
  let tick = 0;
  const run = (ticks: number, buttons = 0, lookYaw = 0): void => {
    for (let i = 0; i < ticks; i++) {
      sim.queueIntent(e, { mx: 0, my: 0, mz: 0, lookYaw, lookPitch: 0, jump: false, buttons });
      sim.beginTick(++tick);
      for (const s of systems) s.step(sim, DT);
      sim.endTick();
    }
  };
  return { e, target, combat, run, sim };
}

const hitTick = (move: number): number => 1 + Math.round(combatMove(move)!.hitAt! * 30);
const swing = (w: ReturnType<typeof setup>): number => {
  w.run(hitTick(Move.SwordA), IntentButton.Attack);
  return w.combat.drainHits().length;
};

describe("hitBody", () => {
  it("a wall placed at its top is out of reach by its pivot, in reach by its middle", () => {
    // The pivot is 2.6 m up (the attacker stands on the ground): beyond the 2 m height limit.
    const pivot = setup();
    C.Transform.py[pivot.target(0, 1)] = 2.6;
    assert.equal(swing(pivot), 0, "by its pivot it is too high");
    const wall = setup((t) => ({ x: 0, y: 1.3, z: 1, rx: 1, ry: 1.3 }));
    const t = wall.target(0, 1);
    C.Transform.py[t] = 2.6;
    assert.equal(swing(wall), 1, "by its middle it is within reach");
    assert.ok(C.Health.current[t]! < 100);
  });

  it("a long wall is reached anywhere along it: the reach is measured to its edge", () => {
    const wall = setup((t) => ({ x: 0, y: 1.3, z: 4, rx: 3, ry: 1.3 }));
    const t = wall.target(0, 4); // its middle is 4 m ahead; its near edge 1 m
    assert.equal(swing(wall), 1);
    assert.ok(C.Health.current[t]! < 100);
    const far = setup((t) => ({ x: 0, y: 1.3, z: 8, rx: 3, ry: 1.3 }));
    far.target(0, 8);
    assert.equal(swing(far), 0, "its near edge is 5 m away");
  });

  it("still misses a part that is far above (a roof), and what is behind", () => {
    const roof = setup((t) => ({ x: 0, y: 6, z: 1, rx: 1, ry: 0.2 }));
    roof.target(0, 1);
    assert.equal(swing(roof), 0);
    const behind = setup((t) => ({ x: 0, y: 1.3, z: -1, rx: 0.5, ry: 1.3 }));
    behind.target(0, -1);
    assert.equal(swing(behind), 0);
  });

  it("leaves targets with no body (creatures, props) measured at their Transform", () => {
    const w = setup((t) => undefined);
    const t = w.target(0, 1);
    assert.equal(swing(w), 1);
    assert.ok(C.Health.current[t]! < 100);
  });
});
