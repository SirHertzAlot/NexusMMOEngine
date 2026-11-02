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
