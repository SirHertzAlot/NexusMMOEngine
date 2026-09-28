import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  IntentSystem,
  IntegrateSystem,
  PLAYER_SPEED,
  PlayerIntent,
  SimWorld,
  STEP_MS,
  Transform,
  Velocity,
} from "../src/index.js";
import type { SimSystem } from "../src/index.js";

function spawnMover(sim: SimWorld): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Velocity, eid);
  return eid;
}

test("integrate: position += velocity * dt", () => {
  const sim = new SimWorld();
  const eid = spawnMover(sim);
  Transform.px[eid] = 1;
  Transform.py[eid] = 2;
  Transform.pz[eid] = 3;
  Velocity.lx[eid] = 10;
  Velocity.ly[eid] = -4;
  Velocity.lz[eid] = 0;
  const dt = STEP_MS / 1000;
  new IntegrateSystem().step(sim, dt);
  assert.ok(Math.abs(Transform.px[eid] - (1 + 10 * dt)) < 1e-6);
  assert.ok(Math.abs(Transform.py[eid] - (2 - 4 * dt)) < 1e-6);
  assert.equal(Transform.pz[eid], 3);
});

test("integrate ignores entities without velocity", () => {
  const sim = new SimWorld();
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  Transform.px[eid] = 5;
  new IntegrateSystem().step(sim, STEP_MS / 1000);
  assert.equal(Transform.px[eid], 5);
});

test("intent: wish-move becomes velocity at player speed", () => {
  const sim = new SimWorld();
  const eid = spawnMover(sim);
  addComponent(sim.ecs, PlayerIntent, eid);
  PlayerIntent.mx[eid] = 1;
  PlayerIntent.mz[eid] = -0.5;
  new IntentSystem().step(sim, STEP_MS / 1000);
  assert.equal(Velocity.lx[eid], PLAYER_SPEED);
  assert.equal(Velocity.lz[eid], -0.5 * PLAYER_SPEED);
});

test("systems run in pipeline order: intent then integrate moves the entity", () => {
  const sim = new SimWorld();
  const eid = spawnMover(sim);
  addComponent(sim.ecs, PlayerIntent, eid);
  const systems: SimSystem[] = [new IntentSystem(), new IntegrateSystem()];
  sim.queueIntent(eid, {
    mx: 1, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0,
  });
  sim.beginTick();
  const dt = STEP_MS / 1000;
  for (const s of systems) s.step(sim, dt);
  assert.ok(Math.abs(Transform.px[eid] - PLAYER_SPEED * dt) < 1e-6);
});

test("the system interface is narrow and replaceable", () => {
  // A future C++ addon replaces a system by implementing this same
  // interface — prove a foreign implementation slots in.
  const seen: string[] = [];
  const foreign: SimSystem = {
    name: "cpp-shim",
    step: (sim, dt) => {
      seen.push(`step:${dt}`);
      assert.ok(sim instanceof SimWorld);
    },
  };
  foreign.step(new SimWorld(), 0.5);
  assert.deepEqual(seen, ["step:0.5"]);
  assert.equal(foreign.name, "cpp-shim");
});
