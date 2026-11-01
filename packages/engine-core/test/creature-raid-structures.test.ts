/**
 * Raid blows on structures (WL2): a raiding creature swings at a settlement's
 * structure through the same combat path a player's blow takes, and the
 * structure's Health goes down by the blow's amount. Synthetic world, fixed
 * seed; the creature walks by its own intent, the blow is CombatSystem's.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { IntentButton } from "@mmo-engine/protocol";
import { CreaturesSchema } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CreatureSystem } from "../src/creatures.js";
import { CombatSystem } from "../src/combat.js";
import { IntentSystem } from "../src/systems.js";
import { loadGameRules } from "../src/rules/boot.js";

const DT = 1 / 30;
const game = loadGameRules();

const raider = CreaturesSchema.parse({
  creatures: {
    boar: {
      name: "Boar",
      health: 500,
      aggroRadius: 5,
      leashRadius: 20,
      respawnSeconds: 60,
      weapons: ["tusk"],
      behavior: {
        temperament: "raid",
        noticeM: 5,
        size: 3,
        speedX: 6,
        raid: { rangeM: 800, hungerSeconds: 0.1, satiateSeconds: 60, minStructures: 1, weights: { player: 1, livestock: 3, structure: 1 } },
      },
    },
  },
}).creatures;

function setup() {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const settlement = { x: 0, z: 0, size: 3, radius: 20 };
  const sys = new CreatureSystem({
    creatures: raider,
    bases: game.rules.items.bases,
    settlements: () => [settlement],
    tickHz: 30,
    massPower: game.rules.combat.damage.massPower,
  });
  const combat = new CombatSystem(30, undefined, { hooks: game.hooks, weaponOf: (e) => sys.weaponOf(e) });
  const intent = new IntentSystem();
  // A building: a Transform and a Health, no character, no creature brain.
  const structure = sim.spawn();
  for (const c of [C.Transform, C.Health]) {
    addComponent(sim.ecs, c, structure);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[structure] = 0;
  }
  C.Transform.px[structure] = 0;
  C.Transform.pz[structure] = 3;
  C.Health.current[structure] = C.Health.max[structure] = 400;
  let tick = 0;
  const run = (n: number): void => {
    for (let i = 0; i < n; i++) {
      sim.beginTick(++tick);
      sys.step(sim);
      for (const e of sys.entities()) {
        C.Transform.px[e] += C.PlayerIntent.mx[e] * DT;
        C.Transform.pz[e] += C.PlayerIntent.mz[e] * DT;
      }
      intent.step(sim, DT);
      combat.step(sim, DT);
      sim.endTick();
    }
  };
  return { sim, sys, combat, structure, run };
}

describe("raid blows reduce structure health", () => {
  it("a raider that reaches a structure strikes it and the structure's Health goes down by the blow", () => {
    const w = setup();
    const [r] = w.sys.spawnPack(w.sim, "boar", 0, 0, [1, 1]);
    const start = C.Health.current[w.structure]!;
    let swung = false;
    w.run(600);
    for (let i = 0; i < 1200 && !swung; i++) {
      w.run(1);
      if (C.PlayerIntent.buttons[r] === IntentButton.Attack) swung = true;
    }
    assert.ok(swung, "the raider swings at the structure");
    const hits = w.combat.drainHits().filter((h) => h.target === w.structure);
    assert.ok(hits.length > 0, "the blow lands on the structure through the combat path");
    const dealt = hits.reduce((s, h) => s + h.amount, 0);
    assert.ok(dealt > 0);
    assert.ok(Math.abs(C.Health.current[w.structure]! - (start - dealt)) < 1e-6, `health ${C.Health.current[w.structure]} = ${start} - ${dealt}`);
  });
});
