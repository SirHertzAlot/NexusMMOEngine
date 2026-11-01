/**
 * Terrain colliders: a chunk tile becomes a static Jolt height field that
 * matches the rendered surface (terrainHeightAt) triangle for triangle —
 * right place, right orientation, and the same diagonal in every cell —
 * and goes away with its chunk. Skips when the native addon isn't built.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { addComponent } from "bitecs";
import {
  BodyConfig,
  createJoltBackend,
  MotionType,
  PhysicsSystem,
  ShapeKind,
  SimWorld,
  STEP_MS,
  terrainHeightAt,
  Transform,
  Velocity,
} from "../src/index.js";
import { ENTITY_BUDGET } from "../src/streaming/chunk-streamer.js";

const require = createRequire(import.meta.url);
const joltBuilt = (): boolean => {
  try {
    const addon = require("@mmo-engine/addon-physics") as { createWorld(): { addTerrain?: unknown; destroy(): void } };
    const w = addon.createWorld();
    const ok = typeof w.addTerrain === "function";
    w.destroy();
    return ok;
  } catch {
    return false;
  }
};

const SIZE = 16;
const STEP = SIZE / 15;
const dt = STEP_MS / 1000;
const tileOf = (f: (x: number, z: number) => number): Float32Array =>
  Float32Array.from({ length: 256 }, (_, i) => f(i % 16, Math.floor(i / 16)));

function drop(sim: SimWorld, x: number, y: number, z: number, shape: "ball" | "box"): number {
  const e = sim.spawn();
  addComponent(sim.ecs, Transform, e);
  addComponent(sim.ecs, Velocity, e);
  addComponent(sim.ecs, BodyConfig, e);
  Transform.px[e] = x;
  Transform.py[e] = y;
  Transform.pz[e] = z;
  Transform.qw[e] = 1;
  if (shape === "ball") {
    BodyConfig.shapeKind[e] = ShapeKind.Sphere;
    BodyConfig.radius[e] = 0.1;
  } else {
    BodyConfig.shapeKind[e] = ShapeKind.Box;
    BodyConfig.halfX[e] = 0.2;
    BodyConfig.halfY[e] = 0.2;
    BodyConfig.halfZ[e] = 0.2;
  }
  BodyConfig.mass[e] = 1;
  BodyConfig.motionType[e] = MotionType.Dynamic;
  BodyConfig.layer[e] = 1;
  BodyConfig.friction[e] = 1;
  return e;
}

test("cells split on the engine's diagonal", (t) => {
  if (!joltBuilt()) return t.skip("native physics addon (with terrain) not built");
  // Every odd/odd sample raised 4 m: in cell (2,2) three corners are 0 and
  // the far one is 4. Split along (1,0)-(0,1) — the engine's diagonal —
  // the near triangle is flat at 0; split the other way it would slope.
  const heights = tileOf((x, z) => (x % 2 === 1 && z % 2 === 1 ? 4 : 0));
  const [cx, cz] = [3, -2];
  const [lx, lz] = [(2 + 0.3) * STEP, (2 + 0.2) * STEP];
  assert.equal(terrainHeightAt(heights, lx, lz, SIZE), 0, "the rendered surface is flat there");

  const sim = new SimWorld();
  const physics = new PhysicsSystem(createJoltBackend());
  try {
    physics.terrainColliders(SIZE).add(cx, cz, heights);
    const ball = drop(sim, cx * SIZE + lx, 1, cz * SIZE + lz, "ball");
    for (let i = 0; i < 120; i++) physics.step(sim, dt);
    assert.ok(Math.abs(Transform.py[ball] - 0.1) < 0.02, `rests on the flat triangle (y=${Transform.py[ball]})`);
    assert.ok(Math.hypot(Transform.px[ball] - (cx * SIZE + lx), Transform.pz[ball] - (cz * SIZE + lz)) < 0.05, "and stays put");
  } finally {
    physics.close();
  }
});

test("a ramp along x stays along x (placement and orientation)", (t) => {
  if (!joltBuilt()) return t.skip("native physics addon (with terrain) not built");
  const heights = tileOf((x) => x * 0.25); // ~13 degrees, rising toward +x
  const [cx, cz] = [-5, 7];
  const [lx, lz] = [4, 12];
  const sim = new SimWorld();
  const physics = new PhysicsSystem(createJoltBackend());
  try {
    physics.terrainColliders(SIZE).add(cx, cz, heights);
    const box = drop(sim, cx * SIZE + lx, 6, cz * SIZE + lz, "box");
    for (let i = 0; i < 150; i++) physics.step(sim, dt);
    // A 0.2 m half-extent box resting flat on the ramp: its centre sits
    // 0.2/cos(slope) above the surface under it. Transposed (a ramp along
    // z) it would rest ~1.9 m higher; mirrored, ~1.9 m lower.
    const slope = Math.atan(0.25 / STEP);
    const surface = terrainHeightAt(heights, Transform.px[box] - cx * SIZE, Transform.pz[box] - cz * SIZE, SIZE);
    assert.ok(
      Math.abs(Transform.py[box] - surface - 0.2 / Math.cos(slope)) < 0.05,
      `box centre ${Transform.py[box].toFixed(3)} vs surface ${surface.toFixed(3)}`,
    );
  } finally {
    physics.close();
  }
});

test("removing a chunk's collider drops what stood on it", (t) => {
  if (!joltBuilt()) return t.skip("native physics addon (with terrain) not built");
  const heights = tileOf(() => 2);
  const sim = new SimWorld();
  const physics = new PhysicsSystem(createJoltBackend());
  try {
    const colliders = physics.terrainColliders(SIZE);
    colliders.add(0, 0, heights);
    colliders.add(0, 0, heights); // re-adding replaces (a sculpted chunk)
    const ball = drop(sim, 8, 4, 8, "ball");
    for (let i = 0; i < 90; i++) physics.step(sim, dt);
    assert.ok(Math.abs(Transform.py[ball] - 2.1) < 0.02, `rests on the ground (y=${Transform.py[ball]})`);
    colliders.remove(0, 0);
    for (let i = 0; i < 60; i++) physics.step(sim, dt);
    assert.ok(Transform.py[ball] < 0, `falls once the chunk is gone (y=${Transform.py[ball]})`);
  } finally {
    physics.close();
  }
});

test("a full body pool refuses a chunk's ground instead of throwing", (t) => {
  if (!joltBuilt()) return t.skip("native physics addon (with terrain) not built");
  const backend = createJoltBackend();
  Object.assign(backend, { addTerrain: () => false }); // what a full pool answers
  const physics = new PhysicsSystem(backend);
  try {
    const colliders = physics.terrainColliders(SIZE);
    assert.equal(colliders.add(0, 0, tileOf(() => 0)), false);
    assert.throws(() => colliders.add(0, 0, new Float32Array(25)), /even square/, "a malformed tile is a bug, not a full pool");
  } finally {
    physics.close();
  }
});

test("the body pool holds the streamer's entity budget, with a chunk's ground on top", (t) => {
  if (!joltBuilt()) return t.skip("native physics addon (with terrain) not built");
  const backend = createJoltBackend();
  const sim = new SimWorld();
  const physics = new PhysicsSystem(backend);
  try {
    for (let i = 0; i < ENTITY_BUDGET; i++) {
      const e = sim.spawn();
      addComponent(sim.ecs, Transform, e);
      addComponent(sim.ecs, Velocity, e);
      addComponent(sim.ecs, BodyConfig, e);
      Transform.px[e] = (i % 300) * 2;
      Transform.py[e] = 0;
      Transform.pz[e] = Math.floor(i / 300) * 2;
      Transform.qw[e] = 1;
      BodyConfig.shapeKind[e] = ShapeKind.Sphere;
      BodyConfig.radius[e] = 0.3;
      BodyConfig.mass[e] = 1;
      BodyConfig.motionType[e] = MotionType.Static;
      BodyConfig.layer[e] = 1;
      BodyConfig.friction[e] = 0.5;
    }
    physics.step(sim, dt);
    assert.equal(backend.bodyCount(), ENTITY_BUDGET, "every entity in the budget has a body");
    assert.equal(physics.terrainColliders(SIZE).add(0, 0, tileOf(() => 0)), true, "and a chunk's ground still fits");
  } finally {
    physics.close();
  }
});
