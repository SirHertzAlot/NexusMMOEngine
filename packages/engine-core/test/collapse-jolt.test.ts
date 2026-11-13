/**
 * The collapse against the real physics world (DE4): a part that loses its support is retyped static -> dynamic
 * (body off for a tick, then on), Jolt drops it onto what is below, and it freezes there static again.
 * Needs the native physics addon.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { addComponent, hasComponent } from "bitecs";
import { BodyConfig, MotionType, PhysicsSystem, ShapeKind, SimWorld, STEP_MS, Transform, Velocity, createJoltBackend } from "../src/index.js";
import { CollapseSystem, type CollapsePartSpec } from "../src/interact/collapse.js";

const require = createRequire(import.meta.url);
const dt = STEP_MS / 1000;

function addonBuilt(): boolean {
  try {
    require("@mmo-engine/addon-physics");
    return true;
  } catch {
    return false;
  }
}

function box(sim: SimWorld, y: number, size: [number, number, number]): number {
  const e = sim.spawn();
  addComponent(sim.ecs, Transform, e);
  addComponent(sim.ecs, Velocity, e);
  addComponent(sim.ecs, BodyConfig, e);
  Transform.py[e] = y;
  Transform.qw[e] = 1;
  const B = BodyConfig;
  B.shapeKind[e] = ShapeKind.Box;
  B.halfX[e] = size[0] / 2;
  B.halfY[e] = size[1] / 2;
  B.halfZ[e] = size[2] / 2;
  B.motionType[e] = MotionType.Static;
  B.layer[e] = 0;
  B.friction[e] = 0.8;
  return e;
}

/** The model entity of a part (no body) and its collider (a static box at the middle). */
function partOf(sim: SimWorld, category: string, y: number, size: [number, number, number]) {
  const model = sim.spawn();
  addComponent(sim.ecs, Transform, model);
  Transform.py[model] = y;
  Transform.qw[model] = 1;
  const col = box(sim, y, size);
  const spec: CollapsePartSpec = { eid: model, colliders: [col], part: { pos: [0, y, 0], size, yawDeg: 0, category } };
  return { model, col, spec };
}

test("a part that loses its support falls onto what is below, its model follows, and it freezes there", (t) => {
  if (!addonBuilt()) {
    t.skip("native physics addon not built");
    return;
  }
  const sim = new SimWorld();
  // A floor slab, a wall block resting on it, and another block resting on the wall.
  const floor = partOf(sim, "floor", 0, [10, 1, 10]);
  const lower = partOf(sim, "wall", 1, [2, 1, 2]);
  const upper = partOf(sim, "wall", 2, [2, 1, 2]);
  const collapse = new CollapseSystem({ waveDelayS: 0.05, settleS: 0.5 });
  collapse.registerBuilding(sim, "tower", [floor.spec, lower.spec, upper.spec]);
  const physics = new PhysicsSystem(createJoltBackend());
  try {
    // Let the static scene settle a few ticks, then break the lower block (the break system would despawn it).
    for (let i = 0; i < 5; i++) {
      collapse.step(sim, dt);
      physics.step(sim, dt);
    }
    assert.equal(Transform.py[upper.model], 2, "static parts do not move");
    sim.despawn(lower.model);
    assert.equal(collapse.partBroken(sim, lower.model), 1);
    assert.equal(sim.resolveWireId(sim.wireId(lower.col)), -1, "its collider went with it");
    let fell = false;
    for (let i = 0; i < 240; i++) {
      collapse.step(sim, dt);
      physics.step(sim, dt);
      if (collapse.carrierOf(sim.wireId(upper.model)) !== undefined) fell = true;
    }
    assert.ok(fell, "it got a dynamic carrier");
    assert.equal(sim.resolveWireId(sim.wireId(upper.col)), -1, "and lost its collider");
    // It rests on the floor top (y 0.5) by its half height (0.5); its model rests with it.
    assert.ok(Math.abs(Transform.py[upper.model]! - 1.0) < 0.06, `model rest y=${Transform.py[upper.model]}`);
    assert.equal(collapse.stats.active, 0, "and froze");
    // Something static now stands where it lies (the carrier), and the floor is untouched.
    let rubble = 0;
    for (let e = 0; e <= sim.maxSlotSeen; e++) {
      if (hasComponent(sim.ecs, BodyConfig, e) && BodyConfig.motionType[e] === MotionType.Static && Math.abs(Transform.py[e]! - Transform.py[upper.model]!) < 0.01 && e !== floor.col) rubble++;
    }
    assert.ok(rubble >= 1);
    assert.equal(BodyConfig.motionType[floor.col], MotionType.Static);
  } finally {
    physics.close();
  }
});
