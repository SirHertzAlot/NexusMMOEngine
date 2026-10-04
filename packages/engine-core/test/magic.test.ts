/**
 * MagicSystem: the mana pool and its first spender, Mend (spells.json).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { Move } from "@mmo-engine/protocol";
import { parseRules, type SpellsRules } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { Mana, MagicSystem } from "../src/magic.js";
import { loadGameRules } from "../src/rules/boot.js";
import { BodySystem, Body } from "../src/body.js";

const DT = 1 / 30;
const { rules } = loadGameRules();
const mend = rules.spells.spells.find((s) => s.id === "mend")!;

function setup(spells: SpellsRules = rules.spells, withStats = false) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld(withStats ? { stats: rules.stats } : {});
  const magic = new MagicSystem(spells);
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
    if (withStats) sim.stats.attach(e);
    return e;
  };
  let tick = 0;
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds * 30); i++) {
      sim.beginTick(++tick);
      magic.step(sim, DT);
      sim.endTick();
    }
  };
  return { sim, magic, make, run };
}

describe("magic", () => {
  it("every character gets a full pool, sized by the maxMana stat when the rules bind one", () => {
    const plain = setup();
    const a = plain.make();
    plain.run(DT);
    assert.equal(Mana.max[a], rules.spells.defaultMax);
    assert.equal(Mana.current[a], Mana.max[a]);

    const statted = setup(rules.spells, true);
    const b = statted.make();
    statted.run(DT);
    assert.equal(Mana.max[b], statted.sim.stats.drive(b, "maxMana"));
    // A higher maximum keeps the pool's share.
    Mana.current[b] = Mana.max[b] / 2;
    statted.sim.stats.setBase(b, "intellect", 20);
    statted.run(DT);
    assert.ok(Math.abs(Mana.current[b] / Mana.max[b] - 0.5) < 0.01);
    assert.equal(Mana.max[b], statted.sim.stats.drive(b, "maxMana"));
  });

  it("Mend heals after its cast time, spends its mana, then cools down", () => {
    const w = setup();
    const e = w.make();
    w.run(DT);
    C.Health.current[e] = 50;
    assert.equal(w.magic.cast(w.sim, e, "mend"), null);
    assert.deepEqual(w.magic.drainEvents().map((v) => [v.state, v.seconds]), [["started", mend.castSeconds]]);
    w.run(mend.castSeconds - 0.2);
    assert.equal(C.Health.current[e], 50, "not before the cast completes");
    w.run(0.3);
    const done = w.magic.drainEvents();
    assert.equal(done[0].state, "done");
    assert.ok(Math.abs(C.Health.current[e] - (50 + mend.effect.amount)) < 1e-3, `${C.Health.current[e]}`);
    assert.equal(done[0].amount, mend.effect.amount);
    assert.ok(Mana.current[e] <= rules.spells.defaultMax - mend.mana + 1);
    assert.match(w.magic.cast(w.sim, e, "mend")!, /ready in/);
    w.run(mend.cooldownSeconds);
    assert.equal(w.magic.cast(w.sim, e, "mend"), null);
  });

  it("mana comes back while nothing is cast", () => {
    const w = setup();
    const e = w.make();
    w.run(DT);
    Mana.current[e] = 10;
    w.run(2);
    assert.ok(Math.abs(Mana.current[e] - (10 + 2 * rules.spells.defaultRegen)) < 0.1, `${Mana.current[e]}`);
  });

  it("refuses what it can't do", () => {
    const w = setup();
    const e = w.make(0, 0);
    const far = w.make(10, 0);
    w.run(DT);
    assert.equal(w.magic.cast(w.sim, e, "fireball"), 'no spell "fireball"');
    assert.equal(w.magic.cast(w.sim, e, "mend"), "you are unhurt");
    C.Health.current[e] = 50;
    assert.equal(w.magic.cast(w.sim, e, "mend", far), "too far away");
    Mana.current[e] = mend.mana - 1;
    assert.equal(w.magic.cast(w.sim, e, "mend"), "not enough mana");
    const selfOnly = setup(parseRules({ skills: { skills: [] }, spells: { spells: [{ ...mend, target: "self" }] } }).spells);
    const a = selfOnly.make(0, 0);
    const b = selfOnly.make(1, 0);
    C.Health.current[b] = 50;
    selfOnly.run(DT);
    assert.equal(selfOnly.magic.cast(selfOnly.sim, a, "mend", b), "Mend is cast on yourself only");
  });

  it("moving, fighting or the target walking off stops the cast, and costs nothing", () => {
    const w = setup();
    const caster = w.make(0, 0);
    const friend = w.make(1, 0);
    C.Health.current[friend] = 40;
    w.run(DT);
    const full = Mana.current[caster];
    w.magic.cast(w.sim, caster, "mend", friend);
    C.PlayerIntent.mx[caster] = 1;
    w.run(DT);
    assert.equal(w.magic.castingOf(caster), null);
    C.PlayerIntent.mx[caster] = 0;

    w.magic.cast(w.sim, caster, "mend", friend);
    C.Action.move[caster] = Move.SwordA;
    w.run(DT);
    assert.equal(w.magic.castingOf(caster), null);
    C.Action.move[caster] = Move.None;

    w.magic.cast(w.sim, caster, "mend", friend);
    C.Transform.px[friend] = 9;
    w.run(DT);
    assert.equal(w.magic.castingOf(caster), null);
    assert.deepEqual(w.magic.drainEvents().map((v) => v.state), ["started", "stopped", "started", "stopped", "started", "stopped"]);
    assert.equal(Mana.current[caster], full);

    C.Transform.px[friend] = 1;
    w.magic.cast(w.sim, caster, "mend", friend);
    w.run(mend.castSeconds + 0.1);
    assert.ok(C.Health.current[friend] > 40);
  });

  it("an instant spell completes at once; a heal never goes past the maximum", () => {
    const instant = parseRules({ skills: { skills: [] }, spells: { spells: [{ ...mend, castSeconds: 0, cooldownSeconds: 0 }] } }).spells;
    const w = setup(instant);
    const e = w.make();
    w.run(DT);
    C.Health.current[e] = 95;
    assert.equal(w.magic.cast(w.sim, e, "mend"), null);
    assert.equal(C.Health.current[e], 100);
    const evs = w.magic.drainEvents();
    assert.deepEqual(evs.map((v) => v.state), ["started", "done"]);
    assert.equal(evs[1].amount, 5);
  });

  it("with a body, Mend heals the harmed parts but sets no bone and stops no bleeding", () => {
    const { hooks } = loadGameRules();
    const w = setup();
    const body = new BodySystem(rules.body, hooks);
    const e = w.make();
    w.run(DT);
    body.ensure(w.sim, e);
    body.applyBlow(w.sim, e, "torso", "cut", 10);
    body.applyBlow(w.sim, e, "legLeft", "blunt", 10);
    const torso = body.parts.indexOf("torso");
    const before = Body.hp[e][torso];
    w.magic.cast(w.sim, e, "mend");
    for (let i = 0; i < Math.round((mend.castSeconds + 0.1) * 30); i++) {
      w.sim.beginTick(w.sim.currentTick + 1);
      w.magic.step(w.sim, DT);
      body.step(w.sim, DT);
      w.sim.endTick();
    }
    assert.ok(Body.hp[e][torso] > before + 0.05, `torso ${before} -> ${Body.hp[e][torso]}`);
    assert.equal(body.stateOf(e, "legLeft"), "maimed");
    assert.ok(body.view(e).parts[torso].bleeding, "the cut still bleeds");
  });
});

