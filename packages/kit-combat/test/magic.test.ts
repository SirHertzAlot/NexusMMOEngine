/**
 * MagicSystem: the mana pool and its first spender, Mend (spells.json).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { Move } from "@mmo-engine/protocol";
import { parseRules, type SpellsRules } from "@mmo-engine/rules";
import { Body, loadGameRules, Mana, SimWorld } from "@mmo-engine/engine-core";
import * as C from "@mmo-engine/engine-core";
import { MagicSystem } from "../src/magic.js";
import { BodySystem } from "../src/body.js";

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
    assert.equal(mend.effect.kind, "heal");
    if (mend.effect.kind === "heal") {
      assert.ok(Math.abs(C.Health.current[e] - (50 + mend.effect.amount)) < 1e-3, `${C.Health.current[e]}`);
      assert.equal(done[0].amount, mend.effect.amount);
    }
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

  it("clamps client-proposed spline paths to authoritative reach and detonates/shields/launches", () => {
    const w = setup();
    const caster = w.make(0, 0);
    const enemy = w.make(10, 0);
    const farEnemy = w.make(28, 0);
    w.run(DT);

    // Propose an out-of-range spline to (30, 0, 0): server clamps inside Blaze Path's 18m reach
    // Wait: arc/radial clamp puts endpoint at x=18 (within reach of 18, >10 from enemy).
    // Instead test clamping at x=40 -> endpoint at x=18 hits a target standing at x=17:
    const targetAtEdge = w.make(17, 0);
    assert.equal(
      w.magic.cast(w.sim, caster, "blazePath", caster, [[0, 0.5, 0], [40, 0.5, 0]]),
      null,
    );
    const evs = w.magic.drainEvents();
    const done = evs.find((v) => v.state === "done")!;
    assert.ok(done.detonateAt && done.detonateAt[0] <= 18.01, `clamped endpoint: ${done.detonateAt?.[0]}`);
    assert.ok(C.Health.current[targetAtEdge] < 100, "enemy near clamped endpoint took fire damage");
    assert.equal(C.Health.current[farEnemy], 100, "out-of-range enemy untouched");
    assert.equal(C.Health.current[enemy], 100, "mid-path bystander outside endpoint radius untouched");

    // Aegis Ward absorbs incoming elemental damage and emits shield-hit
    w.magic.refill(w.sim, targetAtEdge);
    assert.equal(w.magic.cast(w.sim, targetAtEdge, "aegis"), null);
    w.magic.drainEvents();
    const beforeHp = C.Health.current[targetAtEdge];
    const remaining = w.magic.absorbDamage(w.sim, targetAtEdge, 20, caster);
    assert.equal(remaining, 0, "shield absorbed the full blow");
    assert.equal(C.Health.current[targetAtEdge], beforeHp);
    assert.ok(w.magic.drainEvents().some((e) => e.state === "shield-hit"));

    // Gale Sphere launches caster along clamped spline endpoint
    w.magic.refill(w.sim, caster);
    assert.equal(
      w.magic.cast(w.sim, caster, "galeSphere", caster, [[0, 0.5, 0], [5, 2.0, 5], [10, 0.5, 8]]),
      null,
    );
    assert.ok(Math.hypot(C.Transform.px[caster] - 10, C.Transform.pz[caster] - 8) < 1e-4);
  });

  it("blazePath scales to 2x target radius, ramps damage per tick in pillar, and ignites", () => {
    const w = setup();
    const caster = w.make(0, 0);
    const largeMob = w.make(10, 0);
    addComponent(w.sim.ecs, C.BodyConfig, largeMob);
    C.BodyConfig.radius[largeMob] = 2.5; // 2x radius = 5.0m AoE
    const edgeMob = w.make(14.5, 0); // 4.5m from (10, 0), inside 5.0m (2 * 2.5) radius
    w.run(DT);

    assert.equal(w.magic.cast(w.sim, caster, "blazePath", caster, [[2, 0, 0], [10, 0, 0]]), null);
    const evs = w.magic.drainEvents();
    const done = evs.find((v) => v.state === "done")!;
    assert.ok((done.radiusM ?? 0) >= 5, `expected radiusM >= 5 (2x target radius), got ${done.radiusM}`);
    assert.ok(C.Health.current[edgeMob]! < 100, "target inside 2x radius took fire damage");

    const hpAfterImpact = C.Health.current[largeMob]!;
    w.run(1.0); // Stand inside pillar for 4 burn ticks -> escalates & ignites
    assert.ok(C.Health.current[largeMob]! < hpAfterImpact - 10, "standing inside fire pillar deals cumulative burn ticks");
    assert.equal(w.magic.isIgnited(largeMob), true, "target becomes ignited after sustained exposure");
  });

  it("tidalSurge sweeps targets forward along wave and drains breath + stamina", () => {
    const w = setup();
    const caster = w.make(0, 0);
    const foe = w.make(6, 0);
    addComponent(w.sim.ecs, C.Locomotion, foe);
    C.Locomotion.breath[foe] = 1.0;
    addComponent(w.sim.ecs, C.Stamina, foe);
    C.Stamina.current[foe] = C.Stamina.max[foe] = 100;
    w.run(DT);

    const startX = C.Transform.px[foe]!;
    const startHp = C.Health.current[foe]!;
    assert.equal(w.magic.cast(w.sim, caster, "tidalSurge", caster, [[1, 0, 0], [12, 0, 0]]), null);
    w.magic.drainEvents();
    w.run(0.75);

    assert.ok(C.Transform.px[foe]! > startX + 0.5, `wave pushed foe forward: ${startX} -> ${C.Transform.px[foe]}`);
    assert.ok(C.Locomotion.breath[foe]! < 0.8, `wave drained breath: ${C.Locomotion.breath[foe]}`);
    assert.ok(C.Stamina.current[foe]! < 100, "wave drained stamina");
    assert.ok(C.Health.current[foe]! < startHp, "wave dealt damage while drowning");
  });

  it("glacialSpike traps susceptible monsters in a breakable ice ring, spares players/allies and alpine creatures", () => {
    const w = setup();
    const caster = w.make(0, 0);
    const enemy = w.make(8, 0);
    const imp = w.make(8.5, 0);
    const alpineWolf = w.make(7.8, 0);
    const friendPlayer = w.make(8.2, 0);
    addComponent(w.sim.ecs, C.CharacterRef, friendPlayer);
    for (const e of [enemy, imp, alpineWolf, friendPlayer]) {
      addComponent(w.sim.ecs, C.Stamina, e);
      C.Stamina.current[e] = C.Stamina.max[e] = 100;
    }

    w.magic.setHooks({
      areAllies: (a, b) => a === caster && b === friendPlayer,
      creatureInfo: (e) => {
        if (e === alpineWolf) return { kind: "wolf", biome: "mountains" };
        if (e === imp) return { kind: "imp", biome: "plains", iceVulnerable: true };
        return { kind: "bandit", biome: "plains" };
      },
    });
    w.run(DT);

    assert.equal(w.magic.cast(w.sim, caster, "glacialSpike", caster, [[1, 0, 0], [8, 0, 0]]), null);
    const evs = w.magic.drainEvents();
    assert.ok(evs.some((e) => e.state === "ice-ring-spawn" && e.target === enemy));

    // Player/allies & alpine/mountain creatures remain completely untouched
    assert.equal(C.Health.current[friendPlayer], 100);
    assert.equal(C.Stamina.current[friendPlayer], 100);
    assert.equal(w.magic.iceRingOf(friendPlayer), null);
    assert.equal(C.Health.current[alpineWolf], 100);
    assert.equal(C.Stamina.current[alpineWolf], 100);
    assert.equal(w.magic.iceRingOf(alpineWolf), null);

    // Non-alpine enemies lose HP + stamina, get slowed & confined to Ice Ring; vulnerable imp takes more
    assert.ok(C.Stamina.current[enemy]! < 100, "enemy lost stamina");
    assert.ok(w.magic.chillRemaining(enemy) > 0, "enemy slowed");
    assert.ok(C.Health.current[imp]! < C.Health.current[enemy]!, "ice-vulnerable imp took amplified damage");

    const ring = w.magic.iceRingOf(enemy)!;
    assert.ok(ring !== null, "enemy trapped in circular ice ring");
    C.Transform.px[enemy] = 99; // attempt to escape ring
    w.run(DT);
    assert.ok(Math.hypot(C.Transform.px[enemy]! - ring.cx, C.Transform.pz[enemy]! - ring.cz) <= ring.radius, "ice ring confines target");

    // Destroying the ice ring frees the target
    assert.equal(w.magic.damageIceRing(enemy, ring.maxHp), true);
    assert.equal(w.magic.iceRingOf(enemy), null);
    assert.ok(w.magic.drainEvents().some((e) => e.state === "ice-ring-break" && e.target === enemy));
  });
});

