/**
 * createJoltBackend adapter test (Phase 2).
 *
 * Exercises the real @mmo-engine/addon-physics through the
 * PhysicsBackend interface: a sphere dropped onto a static floor must
 * settle at rest height. Skips gracefully if the native addon isn't
 * built (e.g. engine-core tests run before the addon's install
 * script) — the addon's own test suite covers the native boundary in
 * full.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { addComponent } from "bitecs";
import {
  BodyConfig,
  CHARACTER_CAPSULE,
  ColliderSystem,
  MotionType,
  PhysicsSystem,
  PlayerIntent,
  ShapeKind,
  SimWorld,
  STEP_MS,
  Transform,
  Velocity,
  createJoltBackend,
} from "../src/index.js";

const require = createRequire(import.meta.url);

function addonBuilt(): boolean {
  try {
    require("@mmo-engine/addon-physics");
    return true;
  } catch {
    return false;
  }
}

test("jolt backend: sphere settles on the floor through PhysicsSystem", (t) => {
  if (!addonBuilt()) {
    t.skip("native physics addon not built");
    return;
  }
  const sim = new SimWorld();
  const dt = STEP_MS / 1000;

  const floor = sim.spawn();
  addComponent(sim.ecs, Transform, floor);
  addComponent(sim.ecs, Velocity, floor);
  addComponent(sim.ecs, BodyConfig, floor);
  Transform.py[floor] = -0.5;
  Transform.qw[floor] = 1;
  BodyConfig.shapeKind[floor] = ShapeKind.Box;
  BodyConfig.halfX[floor] = 50; BodyConfig.halfY[floor] = 0.5; BodyConfig.halfZ[floor] = 50;
  BodyConfig.motionType[floor] = MotionType.Static;
  BodyConfig.layer[floor] = 0;
  BodyConfig.friction[floor] = 0.8;

  const ball = sim.spawn();
  addComponent(sim.ecs, Transform, ball);
  addComponent(sim.ecs, Velocity, ball);
  addComponent(sim.ecs, BodyConfig, ball);
  Transform.py[ball] = 5;
  Transform.qw[ball] = 1;
  BodyConfig.shapeKind[ball] = ShapeKind.Sphere;
  BodyConfig.radius[ball] = 0.5;
  BodyConfig.mass[ball] = 1;
  BodyConfig.motionType[ball] = MotionType.Dynamic;
  BodyConfig.layer[ball] = 1;
  BodyConfig.friction[ball] = 0.5;

  const backend = createJoltBackend();
  assert.equal(backend.name, "jolt");
  const sys = new PhysicsSystem(backend);
  try {
    for (let i = 0; i < 180; i++) sys.step(sim, dt);
    assert.equal(backend.bodyCount(), 2);
    assert.ok(Math.abs(Transform.py[ball] - 0.5) < 0.05, `rest y=${Transform.py[ball]}`);
    assert.ok(Math.abs(Velocity.ly[ball]) < 0.05, `rest vy=${Velocity.ly[ball]}`);
  } finally {
    sys.close();
  }
});

test("jolt backend: a character's capsule stands on its feet, and things land on its head", (t) => {
  if (!addonBuilt()) {
    t.skip("native physics addon not built");
    return;
  }
  const sim = new SimWorld();
  const dt = STEP_MS / 1000;
  const character = sim.spawn();
  for (const c of [Transform, Velocity, PlayerIntent]) addComponent(sim.ecs, c, character);
  Transform.qw[character] = 1;
  const ball = sim.spawn();
  addComponent(sim.ecs, Transform, ball);
  addComponent(sim.ecs, Velocity, ball);
  addComponent(sim.ecs, BodyConfig, ball);
  Transform.py[ball] = 4;
  Transform.qw[ball] = 1;
  BodyConfig.shapeKind[ball] = ShapeKind.Sphere;
  BodyConfig.radius[ball] = 0.2;
  BodyConfig.mass[ball] = 1;
  BodyConfig.motionType[ball] = MotionType.Dynamic;
  BodyConfig.layer[ball] = 1;
  BodyConfig.friction[ball] = 1;

  const colliders = new ColliderSystem();
  const sys = new PhysicsSystem(createJoltBackend());
  try {
    for (let i = 0; i < 120; i++) {
      colliders.step(sim);
      sys.step(sim, dt);
    }
    const top = 2 * (CHARACTER_CAPSULE.halfHeight + CHARACTER_CAPSULE.radius);
    assert.ok(Math.abs(Transform.py[ball] - (top + 0.2)) < 0.08, `ball rests on the head at y=${Transform.py[ball]} (top ${top})`);
    assert.equal(Transform.py[character], 0, "the character stays where the game put it");
  } finally {
    sys.close();
  }
});
