/**
 * CreatureSystem (AI1): a goblin wakes near a character, chases, swings,
 * gives up past its leash and heals at home; packs size from the rules and
 * the respawn delay is the creature's own.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { IntentButton } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CreatureSystem } from "../src/creatures.js";
import { DeathSystem } from "../src/death.js";
import { loadGameRules } from "../src/rules/boot.js";

const game = loadGameRules();
const goblin = game.rules.creatures.creatures.goblin;

function setup() {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const player = sim.spawn();
  for (const c of [C.Transform, C.Health, C.CharacterRef]) {
    addComponent(sim.ecs, c, player);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[player] = 0;
  }
  C.Transform.qw[player] = 1;
  C.Health.current[player] = C.Health.max[player] = 100;
  const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
  let tick = 0;
  const run = (n: number, after?: () => void): void => {
    for (let i = 0; i < n; i++) {
      sim.beginTick(++tick);
      creatures.step(sim);
      // Stand in for IntegrateSystem: move by intent at the creature's speed.
      for (const e of [...Array(64).keys()]) {
        if (!creatures.isCreature(e)) continue;
        C.Transform.px[e] += C.PlayerIntent.mx[e] * 0.1;
        C.Transform.pz[e] += C.PlayerIntent.mz[e] * 0.1;
      }
      after?.();
      sim.endTick();
    }
  };
  return { sim, player, creatures, run, now: () => tick };
}

describe("creatures", () => {
  it("spawns a pack inside the rules' size range, each with a weapon", () => {
    const w = setup();
    const sizes = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const ids = w.creatures.spawnPack(w.sim, "goblin", 100, 100);
      sizes.add(ids.length);
      for (const e of ids) {
        assert.ok(w.creatures.weaponOf(e));
        assert.equal(C.Health.max[e], goblin.health);
      }
    }
    assert.ok(Math.min(...sizes) >= goblin.pack[0] && Math.max(...sizes) <= goblin.pack[1]);
    assert.ok(sizes.size > 1, "pack size varies");
  });

  it("stays idle with nobody in aggro range, wakes and closes in when someone is", () => {
    const w = setup();
    const [g] = w.creatures.spawnPack(w.sim, "goblin", 0, 0);
    C.Transform.px[w.player] = goblin.aggroRadius + 20;
    w.run(5);
    assert.equal(C.PlayerIntent.mx[g], 0);
    C.Transform.px[w.player] = goblin.aggroRadius - 2;
    const before = Math.hypot(C.Transform.px[w.player] - C.Transform.px[g], C.Transform.pz[w.player] - C.Transform.pz[g]);
    w.run(10);
    const after = Math.hypot(C.Transform.px[w.player] - C.Transform.px[g], C.Transform.pz[w.player] - C.Transform.pz[g]);
    assert.ok(after < before, "closed the distance");
  });

  it("swings through intent once in reach, then waits out its cooldown", () => {
    const w = setup();
    const [g] = w.creatures.spawnPack(w.sim, "goblin", 0, 0);
    C.Transform.px[g] = 0;
    C.Transform.pz[g] = 0;
    C.Transform.px[w.player] = 0.5;
    const swings: number[] = [];
    w.run(Math.round(goblin.attackEverySeconds * 30) * 2 + 2, () => {
      if (C.PlayerIntent.buttons[g] === IntentButton.Attack) swings.push(w.now());
    });
    assert.ok(swings.length >= 2);
    assert.equal(swings[1] - swings[0], Math.round(goblin.attackEverySeconds * 30));
  });

  it("gives up past the leash, walks home and heals", () => {
    const w = setup();
    const [g] = w.creatures.spawnPack(w.sim, "goblin", 0, 0);
    const hx = C.Transform.px[g];
    C.Transform.px[w.player] = goblin.leashRadius + 50; // far: out of aggro
    C.Transform.px[g] = hx + goblin.leashRadius + 5; // dragged out
    C.Health.current[g] = 1;
    w.run(2000);
    assert.ok(Math.hypot(C.Transform.px[g] - hx, C.Transform.pz[g]) < 2.5);
    assert.equal(C.Health.current[g], goblin.health);
  });

  it("rises after its own respawn delay, back at home", () => {
    const w = setup();
    const [g] = w.creatures.spawnPack(w.sim, "goblin", 10, 10);
    const hx = C.Transform.px[g];
    for (const c of [C.Action, C.Velocity]) addComponent(w.sim.ecs, c, g);
    const death = new DeathSystem(
      game.hooks,
      30,
      undefined,
      (s, e) => w.creatures.place(s, e),
      (e) => w.creatures.respawnSeconds(e),
    );
    C.Health.current[g] = 0;
    C.Transform.px[g] = 50;
    const ticks = Math.round(goblin.respawnSeconds * 30);
    for (let i = 0; i < ticks; i++) {
      w.sim.beginTick(i + 1);
      death.step(w.sim);
      w.sim.endTick();
    }
    assert.ok(death.isDead(g), "dead until its delay is up");
    w.sim.beginTick(ticks + 1);
    death.step(w.sim);
    w.sim.endTick();
    assert.equal(death.isDead(g), false);
    assert.equal(C.Transform.px[g], hx);
    assert.equal(C.Health.current[g], goblin.health);
  });
});
