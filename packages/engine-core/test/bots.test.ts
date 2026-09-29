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
