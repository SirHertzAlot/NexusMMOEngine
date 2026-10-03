/**
 * CombatSystem damage (M2a): the strike lands on the move's hit frame, in
 * reach and ahead of the attacker; guards and rolls change the outcome.
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

function setup(weapon: Weapon | null = SWORD, skills?: CombatSkills) {
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
  const combat = new CombatSystem(30, undefined, { hooks, weaponOf: () => weapon, skills });
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
  return { e, target, combat, run };
}

const hitTick = (move: number): number => 1 + Math.round(combatMove(move)!.hitAt! * 30);

describe("combat damage", () => {
  it("lands once, on the hit frame, in front", () => {
    const w = setup();
    const t = w.target(0, 1); // ahead (+Z, yaw 0)
    w.run(hitTick(Move.SwordA) - 1, IntentButton.Attack);
    assert.equal(C.Health.current[t], 100, "not before the hit frame");
    w.run(1, IntentButton.Attack);
    const hits = w.combat.drainHits();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].outcome, "hit");
    assert.equal(hits[0].target, t);
    assert.ok(hits[0].amount > 0);
    assert.ok(Math.abs(C.Health.current[t] - (100 - hits[0].amount)) < 1e-3);
    w.run(10);
    assert.equal(w.combat.drainHits().length, 0, "one strike per move");
  });

  it("misses what is behind, out of reach, or above", () => {
    const w = setup();
    const behind = w.target(0, -1);
    const far = w.target(0, 3);
    const high = w.target(0, 1);
    C.Transform.py[high] = 5;
    w.run(hitTick(Move.SwordA), IntentButton.Attack);
    for (const t of [behind, far, high]) assert.equal(C.Health.current[t], 100);
    assert.equal(w.combat.drainHits().length, 0);
  });

  it("an empty hand hits softer than a sword", () => {
    const armed = setup();
    const a = armed.target(0, 1);
    armed.run(hitTick(Move.SwordA), IntentButton.Attack);
    const sword = C.Health.current[a]; // the stores are shared between worlds
    const bare = setup(null);
    const b = bare.target(0, 1);
    bare.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(C.Health.current[b] > sword);
    assert.ok(C.Health.current[b] < 100);
  });

  it("a guard facing the blow takes only a fraction", () => {
    const open = setup();
    const o = open.target(0, 1);
    open.run(hitTick(Move.SwordA), IntentButton.Attack);
    const full = 100 - C.Health.current[o];

    const w = setup();
    const t = w.target(0, 1, true);
    C.Action.move[t] = Move.Guard;
    C.Action.yaw[t] = Math.PI; // facing the attacker (at -Z of it)
    w.run(hitTick(Move.SwordA), IntentButton.Attack);
    const hit = w.combat.drainHits()[0];
    assert.equal(hit.outcome, "blocked");
    assert.ok(Math.abs(100 - C.Health.current[t] - full * GUARD_FACTOR) < 1e-3);
  });

  it("a roll's i-frames avoid the blow", () => {
    const w = setup();
    const t = w.target(0, 1, true);
    C.Action.move[t] = Move.Roll;
    C.Action.started[t] = 1; // 0.2 s in at the hit frame
    w.run(hitTick(Move.SwordA), IntentButton.Attack);
    const hit = w.combat.drainHits()[0];
    assert.equal(hit.outcome, "dodged");
    assert.equal(C.Health.current[t], 100);
  });

  it("health stops at zero and the dead are not struck again", () => {
    const w = setup();
    const t = w.target(0, 1);
    C.Health.current[t] = 1;
    w.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.equal(C.Health.current[t], 0);
    w.combat.drainHits();
    w.run(60, IntentButton.Attack);
    assert.equal(w.combat.drainHits().filter((h) => h.target === t).length, 0);
  });

  it("the shield bash and the guard do no damage", () => {
    assert.equal(combatMove(Move.ShieldBash)!.hitAt, undefined);
    assert.equal(combatMove(Move.Guard)!.hitAt, undefined);
  });
});

/** A skill book that records training. */
function book(values: Record<string, number> = {}) {
  const trained: Array<{ e: number; id: string }> = [];
  const skills: CombatSkills = {
    get: (_e, id) => values[id] ?? 0,
    train: (e, id) => {
      trained.push({ e, id });
    },
    techniqueSkill: (t) => ({ cut: "cutting", thrust: "thrusting", bludgeon: "bludgeoning" })[t],
  };
  return { skills, trained };
}

describe("combat skills (M3c)", () => {
  it("a higher weapon skill hits harder", () => {
    const lo = setup(SWORD, book({ cutting: 0 }).skills);
    const a = lo.target(0, 1);
    lo.run(hitTick(Move.SwordA), IntentButton.Attack);
    const novice = 100 - C.Health.current[a];
    const hi = setup(SWORD, book({ cutting: 90 }).skills);
    const b = hi.target(0, 1);
    hi.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(100 - C.Health.current[b] > novice);
  });

  it("a landed hit trains the attacker's weapon skill", () => {
    const k = book();
    const w = setup(SWORD, k.skills);
    const t = w.target(0, 1);
    w.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.deepEqual(k.trained, [{ e: w.e, id: "cutting" }]);
    assert.ok(C.Health.current[t] < 100);
  });

  it("a block trains Blocking", () => {
    const k = book();
    const w = setup(SWORD, k.skills);
    const t = w.target(0, 1, true);
    C.Action.move[t] = Move.Guard;
    C.Action.yaw[t] = Math.PI;
    w.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(k.trained.some((u) => u.e === t && u.id === "blocking"));
  });

  it("a dodge trains Evading", () => {
    const k = book();
    const w = setup(SWORD, k.skills);
    const t = w.target(0, 1, true);
    C.Action.move[t] = Move.Roll;
    C.Action.started[t] = 1;
    w.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(k.trained.some((u) => u.e === t && u.id === "evading"));
  });
});

describe("defence contests (M3)", () => {
  /** Skills by entity: the attacker (the first spawned) and everyone else. */
  function duel(attacker: number, defender: number) {
    let me = -1;
    const skills: CombatSkills = {
      get: (e, id) => (e === me ? (id === "cutting" ? attacker : 0) : id === "blocking" || id === "parrying" ? defender : 0),
      train: () => undefined,
      techniqueSkill: (t) => ({ cut: "cutting", thrust: "thrusting", bludgeon: "bludgeoning" })[t],
    };
    let stopped = 0;
    let through = 0;
    const N = 40;
    for (let lead = 0; lead < N; lead++) {
      const w = setup(SWORD, skills);
      me = w.e;
      const t = w.target(0, 1, true);
      C.Action.move[t] = Move.Guard;
      C.Action.yaw[t] = Math.PI; // facing the attacker
      w.run(lead); // a different tick, so a different roll
      w.run(hitTick(Move.SwordA), IntentButton.Attack);
      const hit = w.combat.drainHits().find((h) => h.target === t)!;
      if (hit.outcome === "blocked") {
        assert.equal(hit.amount, 0, "a won contest stops the blow");
        assert.equal(C.Health.current[t], 100);
        stopped++;
      } else {
        assert.equal(hit.outcome, "hit");
        through++;
      }
    }
    return { stopped, through, N };
  }

  it("a master's guard stops a novice's blows; a novice's guard rarely stops a master's", () => {
    const strong = duel(0, 100);
    assert.ok(strong.stopped >= strong.N * 0.8, `stopped ${strong.stopped}/${strong.N}`);
    const weak = duel(100, 0);
    assert.ok(weak.through >= weak.N * 0.8, `through ${weak.through}/${weak.N}`);
  });

  it("a lost contest lets the rules' share of the blow through", () => {
    const skills: CombatSkills = {
      get: (e, id) => (id === "cutting" ? 100 : 0),
      train: () => undefined,
      techniqueSkill: (t) => ({ cut: "cutting" })[t],
    };
    const { rules } = loadGameRules();
    for (let lead = 0; lead < 20; lead++) {
      const w = setup(SWORD, skills);
      const t = w.target(0, 1, true);
      C.Action.move[t] = Move.Guard;
      C.Action.yaw[t] = Math.PI;
      w.run(lead);
      w.run(hitTick(Move.SwordA), IntentButton.Attack);
      const hit = w.combat.drainHits().find((h) => h.target === t)!;
      if (hit.outcome !== "hit") continue;
      const full = hooks.computeDamage({ technique: "cut", skill: 100, item: SWORD.item, part: "torso" }).amount;
      assert.ok(Math.abs(hit.amount - full * rules.combat.defence.failedLetsThrough) < 1e-3);
      return;
    }
    assert.fail("no blow got through in 20 tries at the minimum stop chance");
  });
});

describe("familiarity and disarms (M4)", () => {
  const FAMILY_SWORD: Weapon = { ...SWORD, family: "sword" };
  it("familiarity with the item's family adds to the blow, and each blow builds it", () => {
    const used: string[] = [];
    const strike = (familiarity: number): number => {
      const skills: CombatSkills = {
        get: () => 0,
        train: () => undefined,
        techniqueSkill: () => undefined,
        familiarity: (_e, f) => (f === "sword" ? familiarity : 0),
        useFamily: (_e, f) => void used.push(f),
      };
      const w = setup(FAMILY_SWORD, skills);
      const t = w.target(0, 1);
      w.run(hitTick(Move.SwordA), IntentButton.Attack);
      return w.combat.drainHits().find((h) => h.target === t)!.amount;
    };
    const fresh = strike(0);
    const known = strike(1);
    assert.ok(known > fresh, `${known} > ${fresh}`);
    assert.deepEqual(used, ["sword", "sword"]);
  });

  /** A parry by `defender` against a sword at `attacker`, knowing the disarm or not. */
  function parries(attacker: number, defender: number, knows: boolean) {
    let me = -1;
    const skills: CombatSkills = {
      get: (e, id) => (e === me ? (id === "cutting" ? attacker : 0) : id === "parrying" ? defender : 0),
      train: () => undefined,
      techniqueSkill: (t) => ({ cut: "cutting" })[t],
      knows: (e, technique) => knows && e !== me && technique === "disarm",
    };
    let disarmed = 0;
    let blocked = 0;
    for (let lead = 0; lead < 20; lead++) {
      const w = setup(SWORD, skills);
      me = w.e;
      const t = w.target(0, 1, true);
      C.Action.move[t] = Move.Guard;
      C.Action.yaw[t] = Math.PI;
      w.run(lead);
      w.run(hitTick(Move.SwordA), IntentButton.Attack);
      const hit = w.combat.drainHits().find((h) => h.target === t)!;
      if (hit.outcome === "blocked") blocked++;
      if (hit.disarmed) {
        assert.equal(hit.outcome, "blocked", "only a parry that stops the blow disarms");
        disarmed++;
      }
    }
    return { disarmed, blocked };
  }

  it("a much better parry by someone who knows the disarm takes the weapon", () => {
    const master = parries(20, 90, true);
    assert.ok(master.disarmed > 0 && master.disarmed === master.blocked, JSON.stringify(master));
    assert.equal(parries(20, 90, false).disarmed, 0, "without the technique");
    assert.equal(parries(70, 90, true).disarmed, 0, "against a near equal");
  });

  it("an empty hand can't be disarmed", () => {
    const skills: CombatSkills = {
      get: (e, id) => (id === "parrying" ? 100 : 0),
      train: () => undefined,
      techniqueSkill: () => undefined,
      knows: () => true,
    };
    for (let lead = 0; lead < 5; lead++) {
      const w = setup(null, skills);
      const t = w.target(0, 0.8, true);
      C.Action.move[t] = Move.Guard;
      C.Action.yaw[t] = Math.PI;
      w.run(lead);
      w.run(hitTick(Move.SwordA), IntentButton.Attack);
      for (const h of w.combat.drainHits()) assert.ok(!h.disarmed);
    }
  });
});

