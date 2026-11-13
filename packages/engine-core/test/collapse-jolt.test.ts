/**
 * The collapse against the real physics world (DE4): a part that loses its support is retyped static -> dynamic
 * (body off for a tick, then on), Jolt drops it onto what is below, and it freezes there static again.
 * Needs the native physics addon.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { addComponent, hasComponent } from "bitecs";
import type { SupportPart } from "@mmo-engine/placement";
import { BodyConfig, MotionType, PhysicsSystem, ShapeKind, SimWorld, STEP_MS, Transform, Velocity, createJoltBackend } from "../src/index.js";
import { CollapseSystem } from "../src/interact/collapse.js";

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

const part = (e: number, category: string, y: number, size: [number, number, number]): { eid: number; colliders: number[]; part: SupportPart } => ({
  eid: e,
  colliders: [],
  part: { pos: [0, y, 0], size, yawDeg: 0, category },
});

test("a part that loses its support falls onto what is below and freezes there", (t) => {
  if (!addonBuilt()) {
    t.skip("native physics addon not built");
    return;
  }
  const sim = new SimWorld();
  // A floor slab, a wall block resting on it, and another block resting on the wall.
  const floor = box(sim, 0, [10, 1, 10]);
  const lower = box(sim, 1, [2, 1, 2]);
  const upper = box(sim, 2, [2, 1, 2]);
  const collapse = new CollapseSystem({ waveDelayS: 0.05, settleS: 0.5 });
  collapse.registerBuilding(sim, "tower", [
    part(floor, "floor", 0, [10, 1, 10]),
    part(lower, "wall", 1, [2, 1, 2]),
    part(upper, "wall", 2, [2, 1, 2]),
  ]);
  const physics = new PhysicsSystem(createJoltBackend());
  try {
    // Settle the static scene a few ticks, then break the lower block (the break system would despawn it).
    for (let i = 0; i < 5; i++) {
      collapse.step(sim, dt);
      physics.step(sim, dt);
    }
    assert.equal(Transform.py[upper], 2, "static parts do not move");
    sim.despawn(lower);
    assert.equal(collapse.partBroken(sim, lower), 1);
    let sawDynamic = false;
    for (let i = 0; i < 240; i++) {
      collapse.step(sim, dt);
      physics.step(sim, dt);
      if (hasComponent(sim.ecs, BodyConfig, upper) && BodyConfig.motionType[upper] === MotionType.Dynamic) sawDynamic = true;
    }
    assert.ok(sawDynamic, "it went dynamic");
    // It rests on the floor top (y 0.5) by its half height (0.5).
    assert.ok(Math.abs(Transform.py[upper]! - 1.0) < 0.06, `rest y=${Transform.py[upper]}`);
    assert.equal(BodyConfig.motionType[upper], MotionType.Static, "and froze again");
    assert.equal(collapse.stats.active, 0);
    assert.equal(BodyConfig.motionType[floor], MotionType.Static);
  } finally {
    physics.close();
  }
});
