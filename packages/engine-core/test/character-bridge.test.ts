/**
 * Character bridge: a walker is swept by the Jolt CharacterVirtual and stops
 * at a static prop's face, through the real addon (createJoltBackend).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  attachDefaultCollider,
  BodyConfig,
  CharacterBridgeSystem,
  createJoltBackend,
  MotionType,
  PhysicsSystem,
  PlayerIntent,
  PropCollisionSystem,
  ShapeKind,
  SimWorld,
  Transform,
  Velocity,
} from "../src/index.js";

const DT = 1 / 30;

function addStaticBox(backend: ReturnType<typeof createJoltBackend>, id: bigint, x: number): void {
  const n = backend.addBodies({
    count: 1,
    entityIds: new BigUint64Array([id]),
    shapeKind: new Uint8Array([ShapeKind.Box]),
    halfExtents: new Float32Array([0.5, 2, 0.5]),
    radius: new Float32Array([0]),
    mass: new Float32Array([0]),
    friction: new Float32Array([0.8]),
    restitution: new Float32Array([0]),
    motionType: new Uint8Array([MotionType.Static]),
    layer: new Uint8Array([0]),
    pos: new Float32Array([x, 0, 0]),
    quat: new Float32Array([0, 0, 0, 1]),
    linVel: new Float32Array(3),
    angVel: new Float32Array(3),
  });
  assert.equal(n, 0, "the static box was created");
}

function spawnWalker(sim: SimWorld, x: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, PlayerIntent, eid);
  Transform.px[eid] = x;
  Transform.py[eid] = 0;
  Transform.pz[eid] = 0;
  Transform.qw[eid] = 1;
  attachDefaultCollider(sim, eid);
  assert.equal(BodyConfig.motionType[eid], MotionType.Kinematic);
  assert.equal(BodyConfig.shapeKind[eid], ShapeKind.Capsule);
  return eid;
}

test("a bridged walker stops at a static prop's face", () => {
  const backend = createJoltBackend();
  try {
    addStaticBox(backend, 9001n, 0); // faces at x = -0.5 and +0.5
    const sim = new SimWorld();
    const walker = spawnWalker(sim, -3);
    const bridge = new CharacterBridgeSystem(backend);
    for (let t = 0; t < 60; t++) {
      Transform.px[walker] += 0.1; // the intent's move this tick
      bridge.step(sim, DT);
    }
    assert.ok(bridge.has(walker), "the walker is driven by a character");
    // The capsule (radius 0.35) stops at the face: centre no further than -0.5 - 0.35.
    assert.ok(Transform.px[walker] <= -0.85 + 0.05, `stopped at the face, got ${Transform.px[walker]}`);
    assert.ok(Transform.px[walker] > -1.2, `moved up to the face, got ${Transform.px[walker]}`);
  } finally {
    backend.destroy();
  }
});

test("a walker with no prop in its way walks the full distance", () => {
  const backend = createJoltBackend();
  try {
    const sim = new SimWorld();
    const walker = spawnWalker(sim, -3);
    const bridge = new CharacterBridgeSystem(backend);
    for (let t = 0; t < 60; t++) {
      Transform.px[walker] += 0.1;
      bridge.step(sim, DT);
    }
    assert.ok(Math.abs(Transform.px[walker] - 3) < 0.1, `walked to x = 3, got ${Transform.px[walker]}`);
  } finally {
    backend.destroy();
  }
});

test("prop collision skips bridged walkers", () => {
  const sim = new SimWorld();
  const walker = spawnWalker(sim, 0);
  const bridged = { has: (e: number) => e === walker };
  Transform.px[walker] = 0;
  // Even with a prop-like skip, the system must not move a bridged walker.
  new PropCollisionSystem(bridged).step(sim);
  assert.equal(Transform.px[walker], 0);
});

test("a diagonal walk toward a box holds at its face and does not drift off", () => {
  // Regression guard for the live drift (intent steers toward the box centre each tick, from the walker's own position).
  const backend = createJoltBackend();
  try {
    const cx = -9.273, cz = -5.534;
    backend.addBodies({
      count: 1,
      entityIds: new BigUint64Array([9002n]),
      shapeKind: new Uint8Array([ShapeKind.Box]),
      halfExtents: new Float32Array([0.56, 2, 0.533]),
      radius: new Float32Array([0]),
      mass: new Float32Array([0]),
      friction: new Float32Array([0.8]),
      restitution: new Float32Array([0]),
      motionType: new Uint8Array([MotionType.Static]),
      layer: new Uint8Array([0]),
      pos: new Float32Array([cx, 0, cz]),
      quat: new Float32Array([0, 0, 0, 1]),
      linVel: new Float32Array(3),
      angVel: new Float32Array(3),
    });
    const sim = new SimWorld();
    const walker = spawnWalker(sim, -14.44);
    Transform.pz[walker] = -13.6;
    const bridge = new CharacterBridgeSystem(backend);
    let closest = Infinity;
    for (let t = 0; t < 270; t++) {
      const dx = cx - Transform.px[walker], dz = cz - Transform.pz[walker];
      const len = Math.hypot(dx, dz) || 1;
      Transform.px[walker] += (dx / len) * 4 * DT;
      Transform.pz[walker] += (dz / len) * 4 * DT;
      bridge.step(sim, DT);
      closest = Math.min(closest, Math.hypot(cx - Transform.px[walker], cz - Transform.pz[walker]));
    }
    const end = Math.hypot(cx - Transform.px[walker], cz - Transform.pz[walker]);
    assert.ok(closest > 0.8 && closest < 1.0, `stopped at the face, closest ${closest}`);
    assert.ok(end < 1.0, `stayed at the face, ended ${end} m away`);
  } finally {
    backend.destroy();
  }
});

test("a disabled bridge leaves walkers alone", () => {
  const backend = createJoltBackend();
  try {
    const sim = new SimWorld();
    const walker = spawnWalker(sim, 0);
    const bridge = new CharacterBridgeSystem(backend, false);
    Transform.px[walker] = 3;
    bridge.step(sim, DT);
    assert.equal(Transform.px[walker], 3);
    assert.equal(bridge.has(walker), false);
  } finally {
    backend.destroy();
  }
});

test("a bridged walker gets no physics body, so it cannot push its own character", () => {
  const backend = createJoltBackend();
  try {
    const sim = new SimWorld();
    const walker = spawnWalker(sim, 0);
    const bridge = new CharacterBridgeSystem(backend);
    const physics = new PhysicsSystem(backend, 2, undefined, bridge);
    bridge.step(sim, DT);
    physics.step(sim, DT);
    assert.equal(bridge.has(walker), true);
    assert.equal(backend.bodyCount(), 0, "the walker's own kinematic body is not in the world");
  } finally {
    backend.destroy();
  }
});

test("a walker that spawns inside a static box is nudged out once, and its first sweep does not move it", () => {
  // The live spawn at (-14.44, -13.60) sits 4 cm inside a tall box (see docs): the walker must start clear of it.
  const backend = createJoltBackend();
  try {
    const bx = -13.91, by = -0.25, bz = -14.58;
    const hx = 0.71, hy = 7.79, hz = 0.67;
    backend.addBodies({
      count: 1,
      entityIds: new BigUint64Array([9003n]),
      shapeKind: new Uint8Array([ShapeKind.Box]),
      halfExtents: new Float32Array([hx, hy, hz]),
      radius: new Float32Array([0]),
      mass: new Float32Array([0]),
      friction: new Float32Array([0.8]),
      restitution: new Float32Array([0]),
      motionType: new Uint8Array([MotionType.Static]),
      layer: new Uint8Array([0]),
      pos: new Float32Array([bx, by, bz]),
      quat: new Float32Array([0, 0, 0, 1]),
      linVel: new Float32Array(3),
      angVel: new Float32Array(3),
    });
    const sim = new SimWorld();
    const box = sim.spawn();
    addComponent(sim.ecs, Transform, box);
    addComponent(sim.ecs, BodyConfig, box);
    Transform.px[box] = bx; Transform.py[box] = by; Transform.pz[box] = bz; Transform.qw[box] = 1;
    BodyConfig.shapeKind[box] = ShapeKind.Box;
    BodyConfig.halfX[box] = hx; BodyConfig.halfY[box] = hy; BodyConfig.halfZ[box] = hz;
    BodyConfig.radius[box] = 0; BodyConfig.mass[box] = 0; BodyConfig.motionType[box] = MotionType.Static;
    BodyConfig.layer[box] = 0; BodyConfig.friction[box] = 0.8; BodyConfig.restitution[box] = 0;

    const walker = spawnWalker(sim, -14.44);
    Transform.pz[walker] = -13.6;
    Transform.py[walker] = -0.665; // the live spawn height
    const bridge = new CharacterBridgeSystem(backend);
    const spawn = [Transform.px[walker], Transform.pz[walker]];
    bridge.step(sim, DT);
    const afterSpawn = [Transform.px[walker], Transform.pz[walker]];
    // The first step may only nudge the walker out of the box (about 9 cm); without the nudge the sweep moves it about 0.7 m.
    const first = Math.hypot(afterSpawn[0] - spawn[0], afterSpawn[1] - spawn[1]);
    assert.ok(first < 0.15, `first step moved ${first} m`);
    // Clear of the box's XZ footprint by the capsule radius (0.35 m).
    const dx = Math.max(0, Math.abs(afterSpawn[0] - bx) - hx);
    const dz = Math.max(0, Math.abs(afterSpawn[1] - bz) - hz);
    assert.ok(Math.hypot(dx, dz) >= 0.35 - 1e-3, `clear of the box by the radius, got ${Math.hypot(dx, dz)}`);
    // Zero input from here: the settle must be about 0.
    for (let t = 0; t < 10; t++) bridge.step(sim, DT);
    const settle = Math.hypot(Transform.px[walker] - afterSpawn[0], Transform.pz[walker] - afterSpawn[1]);
    assert.ok(settle < 0.01, `zero-input settle ${settle} m`);
  } finally {
    backend.destroy();
  }
});
