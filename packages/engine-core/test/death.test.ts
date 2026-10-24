/**
 * DeathSystem (M2b): a body at 0 health dies once, is still until the rules'
 * respawn delay passes, then rises at full health (placed, if it has a place).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { IntentButton, Move } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { DeathSystem } from "../src/death.js";
import { loadGameRules } from "../src/rules/boot.js";
import { DuelSystem } from "../src/duel.js";

const { hooks } = loadGameRules();
const DELAY_TICKS = Math.round(hooks.onDeath({ cause: "part", part: "torso" }).respawnInSeconds * 30);

function setup(place?: (sim: SimWorld, e: number) => boolean, killerOf?: (e: number) => number | undefined, duels?: DuelSystem) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const e = sim.spawn();
  for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Health]) {
    addComponent(sim.ecs, c, e);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Transform.qw[e] = 1;
  C.Transform.px[e] = 5;
  C.Health.current[e] = C.Health.max[e] = 100;
  const death = new DeathSystem(hooks, 30, killerOf, place, undefined, undefined, undefined, duels);
  let tick = 0;
  const run = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      sim.beginTick(++tick);
      death.step(sim);
      sim.endTick();
    }
  };
  return { e, death, run, now: () => tick };
}

describe("death", () => {
  it("does nothing to the living", () => {
    const w = setup();
    w.run(5);
    assert.equal(w.death.drainEvents().length, 0);
    assert.equal(w.death.isDead(w.e), false);
  });

  it("kills once, stills the body and credits the killer", () => {
    const w = setup(undefined, () => 99);
    C.Health.current[w.e] = 0;
    C.Action.move[w.e] = Move.SwordA;
    C.Velocity.lx[w.e] = 3;
    w.run(1);
    const ev = w.death.drainEvents();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].state, "dead");
    assert.equal(ev[0].target, w.e);
    assert.equal(ev[0].killer, 99);
    assert.equal(ev[0].respawnAt, w.now() + DELAY_TICKS);
    assert.equal(ev[0].x, 5);
    assert.equal(C.Action.move[w.e], Move.None);
    assert.equal(C.Velocity.lx[w.e], 0);
    assert.ok(w.death.isDead(w.e));
    w.run(3);
    assert.equal(w.death.drainEvents().length, 0, "one death event");
  });

  it("holds the corpse still until the delay is up, then rises at full health", () => {
    const placed: number[] = [];
    const w = setup((_s, e) => {
      placed.push(e);
      C.Transform.px[e] = 0;
      return true;
    });
    C.Health.current[w.e] = 0;
    w.run(1);
    w.death.drainEvents();
    C.Velocity.lx[w.e] = 4; // something shoves the corpse
    w.run(DELAY_TICKS - 1);
    assert.equal(C.Velocity.lx[w.e], 0);
    assert.ok(w.death.isDead(w.e), "still dead a tick early");
    assert.equal(placed.length, 0);
    C.PlayerIntent.buttons[w.e] = IntentButton.Attack;
    w.run(1);
    const ev = w.death.drainEvents();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].state, "alive");
    assert.equal(C.Health.current[w.e], 100);
    assert.equal(C.PlayerIntent.buttons[w.e], 0, "held buttons do not carry over");
    assert.deepEqual(placed, [w.e]);
    assert.equal(C.Transform.px[w.e], 0);
    assert.equal(w.death.isDead(w.e), false);
  });

  it("without a place the body rises where it fell", () => {
    const w = setup();
    C.Health.current[w.e] = 0;
    w.run(DELAY_TICKS + 1);
    assert.equal(C.Health.current[w.e], 100);
    assert.equal(C.Transform.px[w.e], 5);
  });

  it("a duelist felled by their opponent loses the duel, not their life (M5)", () => {
    const duels = new DuelSystem(30);
    const w = setup(undefined, () => 99, duels);
    duels.challenge(99, w.e, 0);
    duels.accept(w.e, 0);
    duels.drainEvents();
    C.Health.current[w.e] = 0;
    w.run(1);
    assert.equal(w.death.drainEvents().length, 0, "no death, no drop, no respawn delay");
    assert.equal(w.death.isDead(w.e), false);
    assert.equal(C.Health.current[w.e], 100, "put right where they stand");
    assert.equal(C.Transform.px[w.e], 5);
    const [ended] = duels.drainEvents();
    assert.equal(ended.state, "ended");
    assert.equal(ended.reason, "blood");
    assert.equal(ended.winner, 99);
    assert.equal(duels.inDuel(w.e), false, "first blood ends the duel");
  });

  it("a duelist killed by someone else dies as usual", () => {
    const duels = new DuelSystem(30);
    const w = setup(undefined, () => 7, duels);
    duels.challenge(99, w.e, 0);
    duels.accept(w.e, 0);
    C.Health.current[w.e] = 0;
    w.run(1);
    assert.equal(w.death.drainEvents()[0].state, "dead");
    assert.ok(w.death.isDead(w.e));
  });
});
