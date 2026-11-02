/**
 * Corpse ragdolls for dying creatures: a corpse rests on its ground, the cap
 * evicts the oldest, a corpse expires, and the world is left clean.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRapierPhysicsWorld, RAGDOLL_PARTS, type PhysicsWorld } from "../src/physics/index.js";
import { CorpseRagdolls, type CorpseOptions } from "../src/physics/corpse-ragdolls.js";

const DT = 1 / 60;
const OPTS: CorpseOptions = { maxCorpses: 20, lifetimeSeconds: 4, groundHalf: 2 };

describe("CorpseRagdolls on Rapier", () => {
  let world: PhysicsWorld;
  before(async () => {
    world = await createRapierPhysicsWorld();
  });
  after(() => world.dispose());

  it("spawns once per key and refuses a second corpse for the same key", () => {
    const c = new CorpseRagdolls(world, OPTS);
    assert.equal(c.spawn(1, { x: 0, y: 0, z: 0 }), true);
    assert.equal(c.spawn(1, { x: 0, y: 0, z: 0 }), false);
    assert.equal(c.size, 1);
    c.dispose();
  });

  it("evicts the oldest corpse past the cap", () => {
    const c = new CorpseRagdolls(world, OPTS);
    for (let k = 1; k <= 25; k++) c.spawn(k, { x: k * 5, y: 0, z: 0 });
    assert.equal(c.size, 20);
    assert.equal(c.has(1), false);
    assert.equal(c.has(5), false);
    assert.equal(c.has(6), true);
    assert.equal(c.has(25), true);
    c.dispose();
  });

  it("removes a corpse when its lifetime is up", () => {
    const c = new CorpseRagdolls(world, { ...OPTS, lifetimeSeconds: 1 });
    c.spawn(7, { x: 40, y: 0, z: 40 });
    c.update(0.5);
    assert.equal(c.has(7), true);
    c.update(0.6);
    assert.equal(c.has(7), false);
    assert.equal(c.size, 0);
  });

  it("a corpse lands on its ground: no part falls through, and rotations are unit quaternions", () => {
    const c = new CorpseRagdolls(world, OPTS);
    const root = { x: -30, y: 0, z: -30 };
    c.spawn(9, root);
    for (let i = 0; i < 120; i++) c.update(DT); // 2 s
    const out = new Float32Array(RAGDOLL_PARTS * 7);
    assert.equal(c.pose(9, out), true);
    for (let i = 0; i < RAGDOLL_PARTS; i++) {
      const y = out[i * 7 + 1]!;
      assert.ok(Number.isFinite(y), `part ${i} y is finite`);
      assert.ok(y > root.y - 0.3, `part ${i} fell through the ground at y = ${y}`);
      const q = [out[i * 7 + 3]!, out[i * 7 + 4]!, out[i * 7 + 5]!, out[i * 7 + 6]!];
      const norm = Math.hypot(...q);
      assert.ok(Math.abs(norm - 1) < 0.01, `part ${i} quaternion norm ${norm}`);
    }
    c.dispose();
  });

  it("pose is false and leaves the buffer alone for an unknown key", () => {
    const c = new CorpseRagdolls(world, OPTS);
    const out = new Float32Array(RAGDOLL_PARTS * 7).fill(-1);
    assert.equal(c.pose(404, out), false);
    assert.ok(out.every((v) => v === -1));
    c.dispose();
  });

  it("dispose removes every corpse, and an idle update does not step the world", () => {
    const c = new CorpseRagdolls(world, OPTS);
    c.spawn(11, { x: 60, y: 0, z: 0 });
    c.spawn(12, { x: 64, y: 0, z: 0 });
    c.dispose();
    assert.equal(c.size, 0);
    c.update(DT); // no corpses: must not throw or step
    assert.equal(c.size, 0);
  });

  it("a zero cap refuses every death", () => {
    const c = new CorpseRagdolls(world, { ...OPTS, maxCorpses: 0 });
    assert.equal(c.spawn(20, { x: 0, y: 0, z: 0 }), false);
    assert.equal(c.size, 0);
  });
});
