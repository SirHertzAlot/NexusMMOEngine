/**
 * BodySystem (M2): body parts, injuries, bleeding, healing, penalties, and
 * the body's part in combat and death.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { combatMove, IntentButton, Move } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { blowRng, Body, BodySystem, BLEEDING_BIT, Injury, NO_JUMP, restoreBody } from "../src/body.js";
import { CombatSystem, type Weapon } from "../src/combat.js";
import { DeathSystem } from "../src/death.js";
import { IntegrateSystem, IntentSystem } from "../src/systems.js";
import { loadGameRules } from "../src/rules/boot.js";

const DT = 1 / 30;
const game = loadGameRules();
const { hooks, rules } = game;
const share = (id: string): number => rules.body.parts.find((p) => p.id === id)!.share;

function setup() {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const body = new BodySystem(rules.body, hooks);
  const make = (x = 0, z = 0): number => {
    const e = sim.spawn();
    for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Health]) {
      addComponent(sim.ecs, c, e);
      for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
    }
    C.Transform.qw[e] = 1;
    C.Transform.px[e] = x;
    C.Transform.pz[e] = z;
    C.Health.current[e] = C.Health.max[e] = 100;
    return e;
  };
  let tick = 0;
  const run = (seconds: number, extra: { step(sim: SimWorld, dt: number): void }[] = []): void => {
    const n = Math.round(seconds * 30);
    for (let i = 0; i < n; i++) {
      sim.beginTick(++tick);
      body.step(sim, DT);
      for (const s of extra) s.step(sim, DT);
      sim.endTick();
    }
  };
  return { sim, body, make, run };
}

const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps;

describe("body", () => {
  it("gives every character a whole body, and Health is the parts combined", () => {
    const w = setup();
    const e = w.make();
    w.run(DT);
    assert.ok(w.body.has(w.sim, e));
    for (const id of w.body.parts) assert.equal(w.body.stateOf(e, id), "healthy");
    assert.ok(near(C.Health.current[e], 100));
    assert.equal(Body.blood[e], rules.body.blood.max);
    assert.equal(Injury.move[e], 1);
  });

  it("a cut harms the part, opens a wound that bleeds, and clots", () => {
    const w = setup();
    const e = w.make();
    w.body.ensure(w.sim, e);
    const r = w.body.applyBlow(w.sim, e, "torso", "cut", 5);
    assert.equal(r.part, "torso");
    assert.equal(r.state, "harmed");
    assert.ok(near(C.Health.current[e], 95));
    w.run(1);
    assert.ok((Injury.bits[e] & BLEEDING_BIT) !== 0);
    assert.ok(near(Body.blood[e], rules.body.blood.max - rules.body.blood.bleedPerSecond.cut, 0.05));
    w.run(rules.body.blood.clotSeconds.cut!);
    assert.equal(Injury.bits[e] & BLEEDING_BIT, 0, "clotted");
    assert.equal(w.body.view(e).parts.find((p) => p.id === "torso")!.bleeding, false);
  });

  it("a heavy blunt blow maims a leg: a limp, and no jumping", () => {
    const w = setup();
    const e = w.make();
    const legMax = share("legLeft") * 100;
    const r = w.body.applyBlow(w.sim, e, "legLeft", "blunt", legMax * 0.45);
    assert.equal(r.state, "maimed");
    w.run(DT);
    assert.ok(near(Injury.move[e], rules.body.penalties.uselessLeg));
    assert.equal(Injury.flags[e] & NO_JUMP, NO_JUMP);
    w.body.applyBlow(w.sim, e, "legRight", "blunt", legMax * 0.45);
    w.run(DT);
    assert.ok(near(Injury.move[e], rules.body.penalties.crawl), "two useless legs crawl");
  });

  it("a weakened leg slows without stopping the jump", () => {
    const w = setup();
    const e = w.make();
    w.body.applyBlow(w.sim, e, "legLeft", "cut", share("legLeft") * 100 * 0.3);
    w.body.applyBlow(w.sim, e, "legLeft", "cut", share("legLeft") * 100 * 0.35);
    w.run(DT);
    assert.equal(w.body.stateOf(e, "legLeft"), "harmed");
    assert.ok(near(Injury.move[e], rules.body.penalties.weakLeg));
    assert.equal(Injury.flags[e] & NO_JUMP, 0);
  });

  it("a severing cut takes the part and everything below it, and the stump bleeds", () => {
    const w = setup();
    const e = w.make();
    const r = w.body.applyBlow(w.sim, e, "armUpperRight", "cut", share("armUpperRight") * 100 * 0.95);
    assert.equal(r.state, "dismembered");
    assert.deepEqual(r.lost.sort(), ["armLowerRight", "armUpperRight", "handRight"]);
    assert.equal(w.body.stateOf(e, "handRight"), "dismembered");
    assert.equal(w.body.armFactor(w.sim, e, "main"), 0, "no sword arm");
    assert.equal(w.body.armFactor(w.sim, e, "off"), 1);
    const lost = (share("armUpperRight") + share("armLowerRight") + share("handRight")) * 100;
    assert.ok(near(C.Health.current[e], 100 - lost));
    // A blow at the lost hand lands on what is left of the arm: the torso.
    assert.equal(w.body.applyBlow(w.sim, e, "handRight", "blunt", 1).part, "torso");
    w.run(1);
    assert.ok(Body.blood[e] < rules.body.blood.max - rules.body.blood.bleedPerSecond.dismember * 0.9);
    w.run(rules.body.blood.clotSeconds.cut! + 5);
    assert.ok((Injury.bits[e] & BLEEDING_BIT) !== 0, "a stump never clots");
  });

  it("dies when a vital part is gone or the blood runs out", () => {
    const w = setup();
    const a = w.make();
    w.body.applyBlow(w.sim, a, "head", "blunt", share("head") * 100);
    assert.equal(C.Health.current[a], 0);
    assert.deepEqual(w.body.causeOf(a), { cause: "part", part: "head" });

    const b = w.make();
    w.body.applyBlow(w.sim, b, "armUpperLeft", "cut", share("armUpperLeft") * 100);
    const seconds = rules.body.blood.max / rules.body.blood.bleedPerSecond.dismember + 1;
    w.run(seconds);
    assert.equal(C.Health.current[b], 0);
    assert.deepEqual(w.body.causeOf(b), { cause: "bleeding" });
  });

  it("spreads Health changed elsewhere over the parts, never regrowing a lost one", () => {
    const w = setup();
    const e = w.make();
    w.run(DT);
    C.Health.current[e] = 50; // hunger, drowning, a restored save
    w.run(DT);
    assert.ok(near(C.Health.current[e], 50, 0.05), "a tick of healing aside");
    for (const p of w.body.view(e).parts) {
      assert.ok(near(p.hp, 0.5, 0.01));
      assert.equal(p.state, "harmed");
    }
    w.body.applyBlow(w.sim, e, "legLeft", "cut", 100); // gone
    C.Health.current[e] = 100;
    w.run(DT);
    assert.ok(near(C.Health.current[e], 100 - share("legLeft") * 100, 0.01));
    assert.equal(w.body.stateOf(e, "legLeft"), "dismembered");
    assert.equal(w.body.stateOf(e, "torso"), "healthy");
  });

  it("heals harmed parts once they stop bleeding; maimed parts wait for treatment", () => {
    const w = setup();
    const e = w.make();
    w.body.applyBlow(w.sim, e, "torso", "blunt", 5);
    w.body.applyBlow(w.sim, e, "legLeft", "blunt", share("legLeft") * 100 * 0.5);
    const torsoBefore = w.body.view(e).parts.find((p) => p.id === "torso")!.hp;
    w.run(1 / rules.body.healPerSecond);
    assert.ok(w.body.view(e).parts.find((p) => p.id === "torso")!.hp > torsoBefore);
    assert.equal(w.body.stateOf(e, "torso"), "healthy");
    assert.equal(w.body.stateOf(e, "legLeft"), "maimed");
  });

  it("hard landings hurt the legs; ordinary ones don't", () => {
    const w = setup();
    const e = w.make();
    assert.equal(w.body.applyFall(w.sim, e, rules.body.fall.safeSpeed), 0);
    assert.ok(near(C.Health.current[e], 100));
    const dmg = w.body.applyFall(w.sim, e, rules.body.fall.safeSpeed + 8);
    assert.ok(near(dmg, 8 * rules.body.fall.damagePerSpeed));
    assert.ok(near(C.Health.current[e], 100 - dmg, 0.01));
    assert.equal(w.body.stateOf(e, "legLeft"), "maimed", "8 m/s too fast breaks a leg");
    assert.equal(w.body.stateOf(e, "head"), "healthy");
  });

  it("a hand that becomes useless lets go of what it holds, once", () => {
    const w = setup();
    const e = w.make();
    w.body.applyBlow(w.sim, e, "handRight", "cut", 0.5);
    assert.deepEqual(w.body.drainDropped(), [], "a scratch holds on");
    w.body.applyBlow(w.sim, e, "armLowerRight", "blunt", share("armLowerRight") * 100 * 0.5);
    assert.deepEqual(w.body.drainDropped(), [{ e, hand: "main" }]);
    w.body.applyBlow(w.sim, e, "handRight", "cut", 100);
    assert.deepEqual(w.body.drainDropped(), [], "already let go");
    w.body.applyBlow(w.sim, e, "armUpperLeft", "cut", 100);
    assert.deepEqual(w.body.drainDropped(), [{ e, hand: "off" }]);
  });

  it("reports the slots a lost part takes with it, and when the body is whole again", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const body = new BodySystem(rules.body, hooks, rules.appearance);
    const e = sim.spawn();
    for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Health]) addComponent(sim.ecs, c, e);
    C.Health.current[e] = C.Health.max[e] = 100;
    body.step(sim, DT);
    assert.deepEqual(body.drainLooks(), []);
    body.applyBlow(sim, e, "armLowerLeft", "cut", 100);
    body.step(sim, DT);
    assert.deepEqual(body.drainLooks(), [e]);
    assert.deepEqual(body.lostSlots(e).sort(), ["armLowerLeft", "elbowLeft", "handLeft"]);
    body.step(sim, DT);
    assert.deepEqual(body.drainLooks(), [], "reported once");
    body.respawned(sim, e, { clearInjuries: true, restoreParts: true });
    body.step(sim, DT);
    assert.deepEqual(body.drainLooks(), [e]);
    assert.deepEqual(body.lostSlots(e), []);
  });

  it("the admin heal makes the body whole", () => {
    const w = setup();
    const e = w.make();
    w.body.applyBlow(w.sim, e, "armUpperLeft", "cut", 100);
    restoreBody(w.sim, e);
    C.Health.current[e] = C.Health.max[e];
    w.run(DT);
    for (const id of w.body.parts) assert.equal(w.body.stateOf(e, id), "healthy");
    assert.ok(near(C.Health.current[e], 100, 0.01));
  });

  it("respawning clears injuries and lost parts (the rules' onRespawn)", () => {
    const w = setup();
    const e = w.make();
    const death = new DeathSystem(hooks, 30, undefined, undefined, () => 1, undefined, w.body);
    w.body.applyBlow(w.sim, e, "armUpperLeft", "cut", 100);
    w.body.applyBlow(w.sim, e, "head", "blunt", 100);
    w.run(DT, [death]);
    const dead = death.drainEvents();
    assert.equal(dead.length, 1);
    assert.deepEqual(dead[0].cause, { cause: "part", part: "head" });
    w.run(1.1, [death]);
    assert.equal(death.drainEvents()[0]?.state, "alive");
    for (const id of w.body.parts) assert.equal(w.body.stateOf(e, id), "healthy");
    assert.ok(near(C.Health.current[e], 100, 0.01));
    assert.equal(Body.blood[e], rules.body.blood.max);
  });

  it("the blow stream is deterministic per tick and pair", () => {
    const a = blowRng(42, 1, 2);
    const b = blowRng(42, 1, 2);
    const c = blowRng(43, 1, 2);
    const xs = [a(), a(), a()];
    assert.deepEqual(xs, [b(), b(), b()]);
    assert.notDeepEqual(xs, [c(), c(), c()]);
    for (const x of xs) assert.ok(x >= 0 && x < 1);
  });
});

describe("body in combat", () => {
  const SWORD: Weapon = { technique: "cut", item: { mass: 1.2, edge: 0.8, point: 0.3, hardness: 0.6 }, reach: 0.9 };
  const hitTick = (move: number): number => 1 + Math.round(combatMove(move)!.hitAt! * 30);

  function fight() {
    const w = setup();
    const e = w.make(0, 0);
    const t = w.make(0, 1);
    const combat = new CombatSystem(30, undefined, { hooks, weaponOf: () => SWORD, body: w.body });
    const systems = [new IntentSystem(), combat, w.body, new IntegrateSystem()];
    let tick = 0;
    const run = (ticks: number, buttons = 0): void => {
      for (let i = 0; i < ticks; i++) {
        w.sim.queueIntent(e, { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons });
        w.sim.beginTick(++tick);
        for (const s of systems) s.step(w.sim, DT);
        w.sim.endTick();
      }
    };
    return { ...w, e, t, combat, run };
  }

  it("a blow lands on a part and says which, and how it left it", () => {
    const f = fight();
    f.run(hitTick(Move.SwordA), IntentButton.Attack);
    const hits = f.combat.drainHits();
    assert.equal(hits.length, 1);
    const h = hits[0];
    assert.ok(h.part && f.body.parts.includes(h.part));
    assert.notEqual(h.state, "healthy");
    assert.equal(f.body.stateOf(f.t, h.part!), h.state);
    // The part's own multiplier: the same blow on the torso, scaled.
    const torso = hooks.computeDamage({ technique: "cut", skill: 0, item: SWORD.item, part: "torso" }).amount;
    const mult = rules.body.parts.find((p) => p.id === h.part)!.hitMultiplier;
    assert.ok(near(h.amount, torso * mult, 1e-3));
    assert.ok(near(C.Health.current[f.t], 100 - h.amount, 0.01));
  });

  it("a useless sword arm cannot attack", () => {
    const f = fight();
    f.run(1);
    f.body.applyBlow(f.sim, f.e, "armUpperRight", "blunt", 100);
    assert.equal(f.body.stateOf(f.e, "armUpperRight"), "maimed");
    f.run(hitTick(Move.SwordA) + 2, IntentButton.Attack);
    assert.equal(f.combat.drainHits().length, 0);
    assert.equal(C.Action.move[f.e], Move.None);
  });
});
