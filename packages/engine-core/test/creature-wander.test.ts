/**
 * Wandering (WL2): an idle, awake creature strolls around its home within
 * `wanderM`, pausing between strolls; a sleeping one stays put, and one with
 * no `wanderM` stands where it spawned, as before.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { CreaturesSchema, type CreaturesRules } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CreatureSystem } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";

const game = loadGameRules();
type Beh = NonNullable<CreaturesRules["creatures"][string]["behavior"]>;

function kind(behavior: Partial<Beh>): CreaturesRules["creatures"] {
  return CreaturesSchema.parse({
    creatures: {
      deer: { name: "Deer", health: 60, aggroRadius: 8, leashRadius: 60, respawnSeconds: 60, weapons: ["bite"], behavior: { temperament: "flee", noticeM: 1, ...behavior } },
    },
  }).creatures;
}

function setup(creatures: CreaturesRules["creatures"], tod: number | null = null) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const sys = new CreatureSystem({
    creatures,
    bases: game.rules.items.bases,
    timeOfDay: () => tod,
    steer: false,
  });
  let tick = 0;
  const run = (n: number): void => {
    for (let i = 0; i < n; i++) {
      sim.beginTick(++tick);
      sys.step(sim);
      for (const e of sys.entities()) {
        C.Transform.px[e] += C.PlayerIntent.mx[e] * 0.1;
        C.Transform.pz[e] += C.PlayerIntent.mz[e] * 0.1;
      }
      sim.endTick();
    }
  };
  return { sim, sys, run };
}

describe("wandering", () => {
  it("strolls about its home, never farther than wanderM from it", () => {
    const w = setup(kind({ wanderM: 6, wanderPauseS: 1, activity: "cathemeral" }));
    const [d] = w.sys.spawnPack(w.sim, "deer", 0, 0, [1, 1]);
    let moved = 0;
    let far = 0;
    let lastX = C.Transform.px[d]!;
    let lastZ = C.Transform.pz[d]!;
    for (let i = 0; i < 900; i++) {
      w.run(1);
      const dist = Math.hypot(C.Transform.px[d]!, C.Transform.pz[d]!);
      far = Math.max(far, dist);
      if (Math.hypot(C.Transform.px[d]! - lastX, C.Transform.pz[d]! - lastZ) > 0.01) moved++;
      lastX = C.Transform.px[d]!;
      lastZ = C.Transform.pz[d]!;
    }
    assert.ok(moved > 100, `it walked about (${moved} ticks moving)`);
    assert.ok(far > 1, `it went away from the spot it spawned on (furthest ${far.toFixed(2)} m)`);
    assert.ok(far <= 6 + 0.5, `it stayed within wanderM of home (furthest ${far.toFixed(2)} m)`);
  });

  it("pauses between strolls: it is still for part of the time", () => {
    const w = setup(kind({ wanderM: 4, wanderPauseS: 2, activity: "cathemeral" }));
    const [d] = w.sys.spawnPack(w.sim, "deer", 0, 0, [1, 1]);
    let still = 0;
    let lastX = C.Transform.px[d]!;
    let lastZ = C.Transform.pz[d]!;
    for (let i = 0; i < 900; i++) {
      w.run(1);
      if (Math.hypot(C.Transform.px[d]! - lastX, C.Transform.pz[d]! - lastZ) <= 0.001) still++;
      lastX = C.Transform.px[d]!;
      lastZ = C.Transform.pz[d]!;
    }
    assert.ok(still > 100, `it paused between strolls (${still} still ticks)`);
  });

  it("a creature with no wanderM stands where it spawned", () => {
    const w = setup(kind({ activity: "cathemeral" }));
    const [d] = w.sys.spawnPack(w.sim, "deer", 0, 0, [1, 1]);
    w.run(300);
    assert.equal(C.Transform.px[d], 0);
    assert.equal(C.Transform.pz[d], 0);
  });

  it("a sleeping creature does not wander outside its hours", () => {
    // Diurnal: asleep at midnight (time 0).
    const w = setup(kind({ wanderM: 6, wanderPauseS: 1, activity: "diurnal" }), 0);
    const [d] = w.sys.spawnPack(w.sim, "deer", 0, 0, [1, 1]);
    w.run(300);
    assert.equal(C.Transform.px[d], 0);
    assert.equal(C.Transform.pz[d], 0);
  });
});
