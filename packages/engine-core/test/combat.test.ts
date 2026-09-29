/**
 * CombatSystem: the sword combo (chaining and recoveries), the guard and
 * shield bash, the dodge roll, and how moves move the character.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { combatMove, IntentButton, Move } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CombatSystem } from "../src/combat.js";
import { IntegrateSystem, IntentSystem, PLAYER_SPEED } from "../src/systems.js";

const DT = 1 / 30;

function setup(): { sim: SimWorld; e: number; run(ticks: number, buttons?: number, input?: { mx?: number; mz?: number; lookYaw?: number }): void; tick(): number } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const e = sim.spawn();
  for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Action]) {
    addComponent(sim.ecs, c, e);
    // Component stores are process-wide and slots are reused: start clean.
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Transform.qw[e] = 1;
  const systems = [new IntentSystem(), new CombatSystem(30), new IntegrateSystem()];
  let tick = 0;
  return {
    sim,
    e,
    tick: () => tick,
    run(ticks, buttons = 0, input = {}) {
      for (let i = 0; i < ticks; i++) {
        sim.queueIntent(e, { mx: input.mx ?? 0, my: 0, mz: input.mz ?? 0, lookYaw: input.lookYaw ?? 0, lookPitch: 0, jump: false, buttons });
        sim.beginTick(++tick);
        for (const s of systems) s.step(sim, DT);
        sim.endTick();
      }
    },
  };
}

const secs = (s: number): number => Math.round(s * 30);

describe("CombatSystem", () => {
  it("an attack plays its hit, then the recovery, lunging along the facing", () => {
    const w = setup();
    w.run(1, IntentButton.Attack, { lookYaw: Math.PI / 2 }); // facing +X
    assert.equal(C.Action.move[w.e], Move.SwordA);
    assert.equal(C.Action.started[w.e], 1);
    assert.ok(Math.abs(C.Action.yaw[w.e] - Math.PI / 2) < 1e-6);
    const seq = C.Action.seq[w.e];
    w.run(secs(0.44));
    assert.equal(C.Action.move[w.e], Move.SwordARecover, "no follow-up: the recovery");
    assert.equal(C.Action.seq[w.e], (seq + 1) & 0xff);
    w.run(secs(1.0));
    assert.equal(C.Action.move[w.e], Move.None, "done");
    // The hit's 0.79 m lunge and the recovery's 0.3 m, along +X.
    assert.ok(Math.abs(C.Transform.px[w.e] - 1.09) < 0.05, `x ${C.Transform.px[w.e]}`);
    assert.ok(Math.abs(C.Transform.pz[w.e]) < 1e-3);
  });

  it("presses in the chain windows run the whole combo, each hit facing the look", () => {
    const w = setup();
    w.run(1, IntentButton.Attack);
    w.run(secs(0.2)); // release
    w.run(1, IntentButton.Attack, { lookYaw: 0.5 }); // queue B, turning
    w.run(secs(0.25), 0, { lookYaw: 0.5 });
    assert.equal(C.Action.move[w.e], Move.SwordB);
    assert.ok(Math.abs(C.Action.yaw[w.e] - 0.5) < 1e-6, "B faces the new look");
    w.run(1); // release
    w.run(1, IntentButton.Attack); // queue C
    w.run(secs(0.5));
    assert.equal(C.Action.move[w.e], Move.SwordC);
    w.run(secs(2.05));
    assert.equal(C.Action.move[w.e], Move.None);
  });

  it("a press early in a recovery still picks the combo up; a held button doesn't", () => {
    const w = setup();
    w.run(1, IntentButton.Attack);
    // Held on from the first press: not a new press, so no follow-up.
    w.run(secs(0.5), IntentButton.Attack);
    assert.equal(C.Action.move[w.e], Move.SwordARecover, "holding attack doesn't chain");
    w.run(1); // release
    w.run(1, IntentButton.Attack); // press inside the recovery's window
    w.run(secs(0.3));
    assert.equal(C.Action.move[w.e], Move.SwordB);
  });

  it("the guard lasts while block is held, slows the walk, and bashes on attack", () => {
    const w = setup();
    w.run(1, IntentButton.Block, { mz: 1 });
    assert.equal(C.Action.move[w.e], Move.Guard);
    assert.ok(Math.abs(C.Velocity.lz[w.e] - PLAYER_SPEED * combatMove(Move.Guard)!.moveScale) < 1e-4);
    w.run(secs(4), IntentButton.Block);
    assert.equal(C.Action.move[w.e], Move.Guard, "held past its clip: still guarding");
    w.run(1, IntentButton.Block | IntentButton.Attack);
    assert.equal(C.Action.move[w.e], Move.ShieldBash);
    w.run(secs(0.9));
    assert.equal(C.Action.move[w.e], Move.None);
    w.run(1, IntentButton.Block);
    w.run(1);
    assert.equal(C.Action.move[w.e], Move.None, "released");
  });

  it("the dodge rolls 4.5 m the way you were moving, and nothing interrupts it", () => {
    const w = setup();
    w.run(1, IntentButton.Dodge, { mx: -1, lookYaw: 0 });
    assert.equal(C.Action.move[w.e], Move.Roll);
    assert.ok(Math.abs(C.Action.yaw[w.e] - Math.atan2(-1, 0)) < 1e-6, "facing the movement, not the look");
    w.run(1, IntentButton.Attack, { mx: -1 });
    assert.equal(C.Action.move[w.e], Move.Roll, "an attack doesn't cut the roll");
    w.run(secs(1.5));
    assert.equal(C.Action.move[w.e], Move.None);
    assert.ok(Math.abs(C.Transform.px[w.e] + 4.5) < 0.1, `rolled to x ${C.Transform.px[w.e]}`);
  });
});
