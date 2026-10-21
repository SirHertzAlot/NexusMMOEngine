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

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import {
  AssetRef,
  BodyConfig,
  CHARACTER_CAPSULE,
  Chunk,
  ColliderSystem,
  Locomotion,
  MotionType,
  PlayerIntent,
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

  // Phase 2 (zero-copy): reads Transform directly from the passed
  // component arrays at eids[k], mirroring the native backend.
  syncBodies(
    count: number, entityIds: BigUint64Array, eids: Int32Array,
    px: Float32Array, py: Float32Array, pz: Float32Array,
    _qx: Float32Array, _qy: Float32Array, _qz: Float32Array,
    _qw: Float32Array, flags: Uint8Array, _dt: number,
  ): void {
    const fl: number[] = [];
    for (let k = 0; k < count; k++) {
      const b = this.bodies.get(entityIds[k]);
      assert.ok(b, "sync of unknown body");
      if (b.motion === MotionType.Kinematic || (flags[k] & 0x01) !== 0) {
        const e = eids[k];
        b.px = px[e]; b.py = py[e]; b.pz = pz[e];
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

  // Phase 2 (zero-copy): writes results directly into the passed
  // component arrays at eids[k], mirroring the native backend.
  copyResults(
    count: number, entityIds: BigUint64Array, eids: Int32Array,
    px: Float32Array, py: Float32Array, pz: Float32Array,
    qx: Float32Array, qy: Float32Array, qz: Float32Array,
    qw: Float32Array, lx: Float32Array, ly: Float32Array,
    lz: Float32Array, ax: Float32Array, ay: Float32Array,
    az: Float32Array,
  ): void {
    for (let k = 0; k < count; k++) {
      const b = this.bodies.get(entityIds[k]);
      assert.ok(b, "copy of unknown body");
      const e = eids[k];
      px[e] = b.px; py[e] = b.py; pz[e] = b.pz;
      qx[e] = 0; qy[e] = 0; qz[e] = 0; qw[e] = 1;
      lx[e] = b.lx; ly[e] = b.ly; lz[e] = b.lz;
      ax[e] = 0; ay[e] = 0; az[e] = 0;
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

test("integrate: kinematic bodies move with their velocity (the game drives them; physics follows)", () => {
  const sim = new SimWorld();
  const e = spawnBody(sim, ShapeKind.Box, MotionType.Kinematic, 0, 0, 0);
  Velocity.lx[e] = 2;
  new IntegrateSystem().step(sim, dt);
  assert.ok(Math.abs(Transform.px[e] - 2 * dt) < 1e-6);
  // Physics syncs the body to it and leaves Transform where the game put it.
  const backend = new MockBackend();
  const sys = new PhysicsSystem(backend);
  sys.step(sim, dt);
  assert.ok(Math.abs(Transform.px[e] - 2 * dt) < 1e-6);
  assert.equal(Velocity.lx[e], 2, "velocity isn't overwritten by the backend");
});

describe("colliders: every entity is a physics body", () => {
  it("characters get a kinematic capsule on their feet; movers a kinematic box; still things a static one", () => {
    const sim = new SimWorld();
    const character = sim.spawn();
    for (const c of [Transform, Velocity, PlayerIntent]) addComponent(sim.ecs, c, character);
    const bot = sim.spawn();
    for (const c of [Transform, Velocity, Locomotion]) addComponent(sim.ecs, c, bot);
    const mover = sim.spawn();
    for (const c of [Transform, Velocity]) addComponent(sim.ecs, c, mover);
    Transform.sx[mover] = 2; Transform.sy[mover] = 1; Transform.sz[mover] = 4;
    const crate = sim.spawn();
    addComponent(sim.ecs, Transform, crate);
    const scenery = sim.spawn();
    addComponent(sim.ecs, Transform, scenery);
    addComponent(sim.ecs, AssetRef, scenery);
    const chunk = sim.spawn();
    addComponent(sim.ecs, Chunk, chunk);

    new ColliderSystem().step(sim);
    for (const e of [character, bot]) {
      assert.equal(BodyConfig.shapeKind[e], ShapeKind.Capsule);
      assert.equal(BodyConfig.motionType[e], MotionType.Kinematic);
      assert.ok(Math.abs(BodyConfig.radius[e] - CHARACTER_CAPSULE.radius) < 1e-6);
    }
    assert.equal(BodyConfig.shapeKind[mover], ShapeKind.Box);
    assert.equal(BodyConfig.motionType[mover], MotionType.Kinematic);
    assert.deepEqual([BodyConfig.halfX[mover], BodyConfig.halfY[mover], BodyConfig.halfZ[mover]], [1, 0.5, 2]);
    assert.equal(BodyConfig.motionType[crate], MotionType.Static);
    assert.ok(hasComponent(sim.ecs, Velocity, crate), "physics owns [Transform, Velocity, BodyConfig]");
    assert.ok(!hasComponent(sim.ecs, BodyConfig, scenery), "scenery's collider is its archetype's call");
    assert.ok(!hasComponent(sim.ecs, BodyConfig, chunk), "terrain is a height field, not an entity body");

    // All of them reach the physics world, keyed by wire id.
    const backend = new MockBackend();
    new PhysicsSystem(backend).step(sim, dt);
    assert.deepEqual(
      [...backend.bodies.keys()].sort(),
      [character, bot, mover, crate].map((e) => sim.wireId(e)).sort(),
    );
  });

  it("leaves a body the spawn code set alone", () => {
    const sim = new SimWorld();
    const e = spawnBody(sim, ShapeKind.Sphere, MotionType.Dynamic, 0, 5, 0);
    new ColliderSystem().step(sim);
    assert.equal(BodyConfig.shapeKind[e], ShapeKind.Sphere);
    assert.equal(BodyConfig.motionType[e], MotionType.Dynamic);
  });
});
