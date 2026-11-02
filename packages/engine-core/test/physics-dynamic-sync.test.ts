/**
 * Dynamic body sync: a body that Jolt simulates (a dynamic sphere falling
 * onto a static floor) reaches the client through the normal delta path.
 *
 * The sim steps the body through PhysicsSystem; the server then encodes
 * a changed-only delta and the client applies the decoded delta to its
 * copy of the world. The client's transform must match the sim's. This
 * is the wire path for physics bodies; it needs the native physics addon.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { addComponent } from "bitecs";
import {
  BodyConfig,
  DeltaTracker,
  MotionType,
  PhysicsSystem,
  ShapeKind,
  SimWorld,
  STEP_MS,
  Transform,
  Velocity,
  applyDelta,
  collectDeltaState,
  collectFullState,
  createJoltBackend,
  decodeDelta,
  encodeDelta,
  stateFromCollected,
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

test("dynamic body: Jolt motion reaches the client through a delta", (t) => {
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
  Transform.qw[floor] = 1;
  BodyConfig.shapeKind[floor] = ShapeKind.Box;
  BodyConfig.halfX[floor] = 50;
  BodyConfig.halfY[floor] = 0.5;
  BodyConfig.halfZ[floor] = 50;
  BodyConfig.motionType[floor] = MotionType.Static;
  BodyConfig.layer[floor] = 0;
  BodyConfig.friction[floor] = 0.8;

  const ball = sim.spawn();
  addComponent(sim.ecs, Transform, ball);
  addComponent(sim.ecs, Velocity, ball);
  addComponent(sim.ecs, BodyConfig, ball);
  Transform.py[ball] = 4;
  Transform.qw[ball] = 1;
  BodyConfig.shapeKind[ball] = ShapeKind.Sphere;
  BodyConfig.radius[ball] = 0.5;
  BodyConfig.mass[ball] = 1;
  BodyConfig.motionType[ball] = MotionType.Dynamic;
  BodyConfig.layer[ball] = 1;
  BodyConfig.friction[ball] = 0.5;

  // Client copy at the baseline tick, before any physics step.
  const tracker = new DeltaTracker();
  const baseline = collectFullState(sim, 0);
  const client = stateFromCollected(baseline);
  tracker.commit(sim);

  const sys = new PhysicsSystem(createJoltBackend());
  try {
    let tick = 0;
    for (let i = 0; i < 60; i++) {
      sys.step(sim, dt);
      tick++;
    }
    // Server side: changed-only delta, encoded and decoded as on the wire.
    const delta = collectDeltaState(sim, tick, 0, tracker);
    const wire = decodeDelta(encodeDelta(delta));
    applyDelta(client, wire);

    const wid = sim.wireId(ball);
    const row = client.get(wid)?.transform;
    assert.ok(row, "client received the ball's transform");
    // The ball fell from y=4 and must now rest on the floor top (y=0.5 + radius 0.5).
    assert.ok(Math.abs(Transform.py[ball] - 1.0) < 0.05, `sim rest y=${Transform.py[ball]}`);
    assert.ok(Math.abs(row!.py - Transform.py[ball]) < 1e-4, `client y=${row!.py} sim y=${Transform.py[ball]}`);
    assert.ok(row!.py < 4, "the fall reached the client");
  } finally {
    sys.close();
  }
});
