/**
 * Movement rules (EG5): a world moves by its `movement` (content/rules/
 * movement.json), the engine defaults are the values that were code, and a
 * replaced `sim.movement` (a rules reload) applies on the next step.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { Ability, LocomotionMode } from "@mmo-engine/protocol";
import { MovementSchema, type MovementRules } from "@mmo-engine/rules";
import * as C from "../src/components.js";
import { DEFAULT_MOVEMENT } from "../src/movement.js";
import { StaminaSystem } from "../src/stats/stamina-system.js";
import type { ChunkDataSource } from "../src/procgen/chunk-source.js";
import { CharacterSystem, GRAVITY, IntegrateSystem, IntentSystem, JUMP_SPEED, PLAYER_SPEED } from "../src/systems.js";
import { SimWorld } from "../src/world.js";

const DT = 1 / 30;
const flat: ChunkDataSource = { chunkSamples: 256, generateChunk: (_s, _x, _z, _l, out) => out.fill(0) };
const rules = (over: Record<string, unknown>): MovementRules => MovementSchema.parse(over);

function walker(movement?: MovementRules): { sim: SimWorld; e: number; tick: (n: number) => void } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld({ movement });
  const e = sim.spawn();
  for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Stamina, C.Locomotion]) {
    addComponent(sim.ecs, c, e);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Transform.qw[e] = 1;
  C.Locomotion.mode[e] = LocomotionMode.Ground;
  C.Locomotion.abilities[e] = Ability.Swim;
  C.Locomotion.breath[e] = 1;
  C.Stamina.current[e] = C.Stamina.max[e] = 100;
  const systems = [new IntentSystem(), new IntegrateSystem(), new CharacterSystem({ chunkSource: flat, worldSeed: 1n }), new StaminaSystem()];
  let t = 0;
  const tick = (n: number): void => {
    for (let k = 0; k < n; k++) {
      sim.beginTick(++t);
      for (const s of systems) s.step(sim, DT);
      sim.endTick();
    }
  };
  return { sim, e, tick };
}

test("the defaults are the values that were code", () => {
  assert.equal(DEFAULT_MOVEMENT.walkSpeed, 6);
  assert.equal(PLAYER_SPEED, 6);
  assert.equal(JUMP_SPEED, 8);
  assert.equal(GRAVITY, 22);
  assert.equal(new SimWorld().movement, DEFAULT_MOVEMENT);
});

test("walking speed comes from the world's rules, and a reload applies next step", () => {
  const { sim, e, tick } = walker(rules({ walkSpeed: 9 }));
  C.PlayerIntent.mx[e] = 1;
  tick(1);
  assert.equal(C.Velocity.lx[e], 9);
  sim.movement = rules({ walkSpeed: 4 });
  C.PlayerIntent.mx[e] = 1;
  tick(1);
  assert.equal(C.Velocity.lx[e], 4);
});

test("a jump starts at the rules' jump speed and falls by their gravity", () => {
  const { e, tick } = walker(rules({ jumpSpeed: 5, gravity: 10 }));
  C.PlayerIntent.jump[e] = 1;
  tick(1);
  assert.equal(C.Velocity.ly[e], 5);
  C.PlayerIntent.jump[e] = 0;
  tick(1);
  assert.ok(Math.abs(C.Velocity.ly[e] - (5 - 10 * DT)) < 1e-6, `ly ${C.Velocity.ly[e]}`);
});

test("stamina costs, drains and the regen delay come from the rules", () => {
  const { e, tick } = walker(rules({ stamina: { jumpCost: 30, runDrainPerSecond: 0, regenDelaySeconds: 2, regenPerSecond: 30 } }));
  C.PlayerIntent.jump[e] = 1;
  tick(1);
  assert.equal(C.Stamina.current[e], 70);
  C.PlayerIntent.jump[e] = 0;
  tick(59); // 2 s after the spend: still waiting
  assert.equal(C.Stamina.current[e], 70);
  tick(2);
  assert.ok(C.Stamina.current[e] > 70, "regen started after the delay");
});
