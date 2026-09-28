/**
 * PhysicsSystem tests with a mock backend (Phase 2).
 *
 * The mock implements the PhysicsBackend contract with a tiny Euler
 * integrator: dynamics fall under gravity, kinematics snap to their
 * synced targets, statics never move. This exercises the system's
 * membership diffing (add/remove in sorted wire-id order), the
 * sync/step/copy pipeline, teleport flags, and the IntegrateSystem
 * exclusion — without the native Jolt build. The real Jolt adapter is
 * covered by test/physics-jolt.test.ts and the addon's own tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  BodyConfig,
  MotionType,
  ShapeKind,
  IntegrateSystem,
  PhysicsSystem,
  SimWorld,
  STEP_MS,
  Transform,
  Velocity,
} from "../src/index.js";
import type { PhysicsAddBatch, PhysicsBackend } from "../src/index.js";

interface MockBody {
  id: bigint;
  motion: number;
  px: number; py: number; pz: number;
  lx: number; ly: number; lz: number;
}

/** Minimal backend: Euler gravity for dynamics, exact follow for kinematics. */
class MockBackend implements PhysicsBackend {
  readonly name = "mock";
  readonly bodies = new Map<bigint, MockBody>();
  readonly addedBatches: bigint[][] = [];
  readonly removedBatches: bigint[][] = [];
  readonly syncCalls: { count: number; flags: number[] }[] = [];
  destroyed = false;

  addBodies(batch: PhysicsAddBatch): void {
    const ids: bigint[] = [];
    for (let k = 0; k < batch.count; k++) {
      const id = batch.entityIds[k];
      ids.push(id);
      this.bodies.set(id, {
        id,
        motion: batch.motionType[k],
        px: batch.pos[k * 3], py: batch.pos[k * 3 + 1], pz: batch.pos[k * 3 + 2],
        lx: batch.linVel[k * 3], ly: batch.linVel[k * 3 + 1], lz: batch.linVel[k * 3 + 2],
      });
    }
    this.addedBatches.push(ids);
  }

  removeBodies(entityIds: BigUint64Array): void {
    const ids = [...entityIds];
    for (const id of ids) this.bodies.delete(id);
    this.removedBatches.push(ids);
  }

  syncBodies(
    count: number, entityIds: BigUint64Array, pos: Float32Array,
    _quat: Float32Array, _lin: Float32Array, _ang: Float32Array,
    flags: Uint8Array, _dt: number,
  ): void {
    const fl: number[] = [];
    for (let k = 0; k < count; k++) {
      const b = this.bodies.get(entityIds[k]);
      assert.ok(b, "sync of unknown body");
      if (b.motion === MotionType.Kinematic || (flags[k] & 0x01) !== 0) {
        b.px = pos[k * 3]; b.py = pos[k * 3 + 1]; b.pz = pos[k * 3 + 2];
      }
      fl.push(flags[k]);
    }
    this.syncCalls.push({ count, flags: fl });
  }

  step(dtSeconds: number, _subSteps: number): void {
    for (const b of this.bodies.values()) {
      if (b.motion !== MotionType.Dynamic) continue;
      b.ly -= 9.81 * dtSeconds;
      b.px += b.lx * dtSeconds;
      b.py += b.ly * dtSeconds;
      b.pz += b.lz * dtSeconds;
    }
  }

  copyResults(
    count: number, entityIds: BigUint64Array, pos: Float32Array,
    quat: Float32Array, linVel: Float32Array, angVel: Float32Array,
  ): void {
    for (let k = 0; k < count; k++) {
      const b = this.bodies.get(entityIds[k]);
      assert.ok(b, "copy of unknown body");
      pos[k * 3] = b.px; pos[k * 3 + 1] = b.py; pos[k * 3 + 2] = b.pz;
      quat[k * 4 + 3] = 1;
      linVel[k * 3] = b.lx; linVel[k * 3 + 1] = b.ly; linVel[k * 3 + 2] = b.lz;
      angVel[k * 3] = 0; angVel[k * 3 + 1] = 0; angVel[k * 3 + 2] = 0;
    }
  }

  bodyCount(): number {
    return this.bodies.size;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function spawnBody(
  sim: SimWorld,
  shapeKind: number,
  motionType: number,
  x: number, y: number, z: number,
): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, BodyConfig, eid);
  Transform.px[eid] = x; Transform.py[eid] = y; Transform.pz[eid] = z;
  Transform.qw[eid] = 1;
  BodyConfig.shapeKind[eid] = shapeKind;
  BodyConfig.halfX[eid] = 0.5; BodyConfig.halfY[eid] = 0.5; BodyConfig.halfZ[eid] = 0.5;
  BodyConfig.radius[eid] = 0.5;
  BodyConfig.mass[eid] = 1;
  BodyConfig.motionType[eid] = motionType;
  BodyConfig.layer[eid] = motionType === MotionType.Static ? 0 : 1;
  BodyConfig.friction[eid] = 0.5;
  BodyConfig.restitution[eid] = 0;
  return eid;
}

const dt = STEP_MS / 1000;

test("physics: dynamic bodies are added once and fall under the backend", () => {
  const sim = new SimWorld();
  const e = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 0, 10, 0);
  const backend = new MockBackend();
  const sys = new PhysicsSystem(backend);
  sys.step(sim, dt);
  assert.equal(backend.bodyCount(), 1);
  assert.equal(backend.addedBatches.length, 1);
  const yAfter1 = Transform.py[e];
  assert.ok(yAfter1 < 10, `fell: ${yAfter1}`);
  sys.step(sim, dt);
  assert.equal(backend.addedBatches.length, 1); // no re-add
  assert.ok(Transform.py[e] < yAfter1, "keeps falling");
  assert.ok(Velocity.ly[e] < 0, "velocity copied back");
});

test("physics: adds are issued in ascending wire-id order", () => {
  const sim = new SimWorld();
  const a = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 0, 10, 0);
  const b = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 1, 10, 0);
  const c = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 2, 10, 0);
  // Recycle b's slot: the replacement gets generation 1, so its wire id
  // (0x1_00000001) sorts AFTER c's (0x0_00000002) even though the slot
  // index is lower. bitECS query order is slot order — only an explicit
  // sort produces ascending wire-id order here.
  sim.despawn(b);
  const d = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 3, 10, 0);
  const backend = new MockBackend();
  new PhysicsSystem(backend).step(sim, dt);
  const batch = backend.addedBatches[0];
  assert.equal(batch.length, 3);
  assert.deepEqual(batch, [sim.wireId(a), sim.wireId(c), sim.wireId(d)]);
  const sorted = [...batch].sort((x, y) => (x < y ? -1 : 1));
  assert.deepEqual(batch, sorted);
});

test("physics: despawned entities are removed from the backend", () => {
  const sim = new SimWorld();
  const e0 = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 0, 10, 0);
  const e1 = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 1, 10, 0);
  const backend = new MockBackend();
  const sys = new PhysicsSystem(backend);
  sys.step(sim, dt);
  assert.equal(backend.bodyCount(), 2);
  const wid0 = sim.wireId(e0);
  sim.despawn(e0);
  sys.step(sim, dt);
  assert.equal(backend.bodyCount(), 1);
  assert.deepEqual(backend.removedBatches[0], [wid0]);
  // The surviving body keeps simulating.
  const yBefore = Transform.py[e1];
  sys.step(sim, dt);
  assert.ok(Transform.py[e1] < yBefore);
});

test("physics: kinematic bodies follow the JS-side transform", () => {
  const sim = new SimWorld();
  const e = spawnBody(sim, ShapeKind.Box, MotionType.Kinematic, 0, 0, 0);
  const backend = new MockBackend();
  const sys = new PhysicsSystem(backend);
  sys.step(sim, dt);
  Transform.px[e] = 5;
  sys.step(sim, dt);
  assert.equal(backend.syncCalls.length, 2);
  assert.equal(Transform.px[e], 5); // copied back from the backend
});

test("physics: teleport flag is set only for teleported dynamics", () => {
  const sim = new SimWorld();
  const e = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 0, 10, 0);
  const backend = new MockBackend();
  const sys = new PhysicsSystem(backend);
  sys.step(sim, dt);
  assert.equal(backend.syncCalls.length, 0); // dynamics aren't synced normally
  sys.teleport(sim, e);
  Transform.px[e] = 42;
  sys.step(sim, dt);
  assert.equal(backend.syncCalls.length, 1);
  assert.deepEqual(backend.syncCalls[0].flags, [0x01]);
  assert.equal(Transform.px[e], 42);
  // Flag is one-shot: next tick has no sync again.
  sys.step(sim, dt);
  assert.equal(backend.syncCalls.length, 1);
});

test("physics: static bodies are never synced or copied", () => {
  const sim = new SimWorld();
  spawnBody(sim, ShapeKind.Box, MotionType.Static, 0, -1, 0);
  const e = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 0, 10, 0);
  void e;
  const backend = new MockBackend();
  const sys = new PhysicsSystem(backend);
  sys.step(sim, dt);
  sys.step(sim, dt);
  // Only the dynamic body is ever synced/copied; statics stay put.
  for (const c of backend.syncCalls) assert.equal(c.count, 0);
  assert.equal(backend.bodyCount(), 2);
});

test("physics: close() destroys the backend", () => {
  const backend = new MockBackend();
  const sys = new PhysicsSystem(backend);
  sys.close();
  assert.ok(backend.destroyed);
});

test("integrate skips BodyConfig entities (no double-stepping)", () => {
  const sim = new SimWorld();
  const phys = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 0, 10, 0);
  Velocity.ly[phys] = -3;
  const plain = sim.spawn();
  addComponent(sim.ecs, Transform, plain);
  addComponent(sim.ecs, Velocity, plain);
  Velocity.ly[plain] = -3;
  const yPhysBefore = Transform.py[phys];
  const yPlainBefore = Transform.py[plain];
  new IntegrateSystem().step(sim, dt);
  assert.equal(Transform.py[phys], yPhysBefore); // untouched: physics owns it
  assert.ok(Math.abs(Transform.py[plain] - (yPlainBefore - 3 * dt)) < 1e-6);
});
