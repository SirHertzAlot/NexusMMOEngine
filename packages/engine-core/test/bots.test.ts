/**
 * BotSystem: bots are ordinary characters driven by a brain — they spawn
 * with looks, and sparring pairs fight through the real CombatSystem.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Move } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { BotSystem } from "../src/bots.js";
import { MovementSchema } from "@mmo-engine/rules";
import { CombatSystem } from "../src/combat.js";
import { IntegrateSystem, IntentSystem } from "../src/systems.js";

describe("BotSystem", () => {
  it("spawns characters with looks, and sparring pairs attack and guard", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const bots = new BotSystem({ count: 6, home: { x: 0, z: 0 }, radius: 8, catalog: null });
    const systems = [bots, new IntentSystem(), new CombatSystem(30), new IntegrateSystem()];
    const seen = new Map<number, Set<number>>();
    for (let tick = 1; tick <= 30 * 20; tick++) {
      sim.beginTick(tick);
      for (const s of systems) s.step(sim, 1 / 30);
      sim.endTick();
      for (const e of bots.entities) {
        if (!seen.has(e)) seen.set(e, new Set());
        seen.get(e)!.add(C.Action.move[e]);
      }
    }
    assert.equal(bots.entities.length, 6);
    for (const e of bots.entities) {
      const look = JSON.parse(sim.lookJson(C.Appearance.look[e])) as { gender: string };
      assert.ok(look.gender === "male" || look.gender === "female");
    }
    // Two in three spar: the first four, in pairs.
    for (const e of bots.entities.slice(0, 4)) {
      const moves = seen.get(e)!;
      assert.ok(moves.has(Move.SwordA), `bot ${e} attacked (${[...moves]})`);
      assert.ok(moves.has(Move.Guard), `bot ${e} guarded (${[...moves]})`);
    }
    // Wanderers never fight.
    for (const e of bots.entities.slice(4)) assert.deepEqual([...seen.get(e)!], [Move.None]);
  });
});

describe("BotSystem pacing from the movement rules (EG12)", () => {
  it("a wanderer strolls at the rules' pace, read each step", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    sim.movement = MovementSchema.parse({ bots: { wanderPace: 0.5 } });
    const bots = new BotSystem({ count: 1, home: { x: 0, z: 0 }, radius: 8, catalog: null });
    const intent = (): number => Math.hypot(C.PlayerIntent.mx[bots.entities[0]!]!, C.PlayerIntent.mz[bots.entities[0]!]!);
    let pace = 0;
    for (let tick = 1; tick <= 30 * 6 && pace === 0; tick++) {
      sim.beginTick(tick);
      bots.step(sim, 1 / 30);
      sim.endTick();
      pace = intent();
    }
    assert.ok(Math.abs(pace - 0.5) < 1e-6, `strolls at half the walk (${pace})`);
    sim.movement = MovementSchema.parse({ bots: { wanderPace: 0.2 } });
    sim.beginTick(10_000);
    bots.step(sim, 1 / 30);
    sim.endTick();
    assert.ok(intent() === 0 || Math.abs(intent() - 0.2) < 1e-6, `a reload changes the pace (${intent()})`);
  });
});
