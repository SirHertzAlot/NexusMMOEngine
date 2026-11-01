/**
 * The physics seam on Rapier: ragdolls rest on the heightfield, the heightfield
 * is read in the documented layout, and removed rigs are gone.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRapierPhysicsWorld, PHYSICS_SUBSTEPS, RAGDOLL_PARTS, type PhysicsWorld } from "../src/physics/index.js";

const DT = 1 / 60;
const CELLS = 64;
const SIZE = 64;

/** A ramp that rises along +x only: height = 0.1 * x + 5. Flat along z, so a transposed read is visible. */
function rampHeights(): Float32Array {
  const n = CELLS + 1;
  const out = new Float32Array(n * n);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    out[z * n + x] = 0.1 * (x * (SIZE / CELLS) - SIZE / 2) + 5;
  }
  return out;
}
const rampAt = (x: number) => 0.1 * x + 5;

function poseOf(world: PhysicsWorld, handle: number): Float32Array {
  const out = new Float32Array(RAGDOLL_PARTS * 3);
  world.ragdollPose(handle, out);
  return out;
}

describe("PhysicsWorld on Rapier", () => {
  let world: PhysicsWorld;

  before(async () => {
    world = await createRapierPhysicsWorld();
    world.addHeightfield(rampHeights(), CELLS, SIZE);
  });

  after(() => world.dispose());

  it("reports its backend and the engine's substep count", () => {
    assert.equal(world.backend, "rapier");
    assert.equal(PHYSICS_SUBSTEPS, 2);
  });

  it("reads the heightfield as sampled: a rig at x = +20 rests on the ramp there", () => {
    const x = 20, z = -20;
    const handle = world.spawnRagdoll({ x, y: rampAt(x) + 4, z });
    for (let f = 0; f < 240; f++) world.step(DT);
    const pose = poseOf(world, handle);
    const lowest = Math.min(...Array.from({ length: RAGDOLL_PARTS }, (_, i) => pose[i * 3 + 1]!));
    assert.ok(Number.isFinite(lowest), "pose is finite");
    // Lowest shin sits about 0.47 m under the root and the root about 0.5 m above
    // the surface: the rig is on the ramp at rampAt(x), not at the transposed height.
    assert.ok(Math.abs(lowest - rampAt(x)) < 0.6, `lowest part ${lowest.toFixed(2)} near ramp ${rampAt(x).toFixed(2)}`);
    world.removeRagdoll(handle);
  });

  it("writes every part's position, in order", () => {
    const handle = world.spawnRagdoll({ x: -10, y: rampAt(-10) + 3, z: 5 });
    world.step(DT);
    const pose = poseOf(world, handle);
    assert.equal(pose.length, RAGDOLL_PARTS * 3);
    for (const v of pose) assert.ok(Number.isFinite(v));
    world.removeRagdoll(handle);
  });

  it("removeRagdoll frees the rig, and unknown handles are ignored", () => {
    const handle = world.spawnRagdoll({ x: 0, y: 10, z: 0 });
    world.removeRagdoll(handle);
    world.removeRagdoll(handle);
    world.removeRagdoll(987654);
    const out = new Float32Array(RAGDOLL_PARTS * 3).fill(7);
    world.ragdollPose(handle, out);
    assert.ok(out.every((v) => v === 7), "a removed rig's pose is left untouched");
  });

  it("rejects a heightfield with the wrong sample count", () => {
    assert.throws(() => world.addHeightfield(new Float32Array(10), CELLS, SIZE), /samples/);
  });
});

describe("walkers on Rapier", () => {
  let world: PhysicsWorld;

  before(async () => {
    world = await createRapierPhysicsWorld();
    world.addHeightfield(rampHeights(), CELLS, SIZE);
  });

  after(() => world.dispose());

  it("walks along the ramp and stays grounded at the sampled height", () => {
    const h = world.spawnWalker({ x: -20, y: rampAt(-20) + 2, z: 0 }, 0.4, 0.5);
    let state = { x: -20, y: 0, z: 0, grounded: false };
    for (let f = 0; f < 240; f++) {
      state = world.moveWalker(h, { x: 0.05, y: -0.05, z: 0 });
      world.step(DT);
    }
    assert.ok(state.grounded, "walker is grounded on the ramp");
    // Capsule centre sits halfHeight + radius above the surface.
    assert.ok(Math.abs(state.y - (rampAt(state.x) + 0.9)) < 0.15, `centre ${state.y.toFixed(2)} at x ${state.x.toFixed(2)}`);
    world.removeWalker(h);
  });

  it("is stopped by a box in its path", () => {
    const wallX = 5;
    world.addStaticBox({ x: wallX, y: rampAt(wallX) + 1, z: 10 }, { x: 0.5, y: 1, z: 0.5 });
    const h = world.spawnWalker({ x: 0, y: rampAt(0) + 1.4, z: 10 }, 0.4, 0.5);
    let state = { x: 0, y: 0, z: 0, grounded: false };
    for (let f = 0; f < 120; f++) {
      state = world.moveWalker(h, { x: 0.1, y: 0, z: 0 });
      world.step(DT);
    }
    // The box's near face is at x = 4.5; the capsule's radius is 0.4.
    assert.ok(state.x < 4.5 - 0.4 + 0.05, `walker stopped at x ${state.x.toFixed(2)}`);
    assert.ok(state.x > 2, "walker reached the box");
    world.removeWalker(h);
  });

  it("removeWalker frees it, and unknown handles are ignored", () => {
    const h = world.spawnWalker({ x: 30, y: 10, z: 30 }, 0.4, 0.5);
    world.removeWalker(h);
    world.removeWalker(h);
    world.removeWalker(424242);
    const s = world.moveWalker(h, { x: 1, y: 0, z: 0 });
    assert.equal(s.grounded, false);
  });
});
