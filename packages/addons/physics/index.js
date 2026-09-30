// @mmo-engine/addon-physics — JS boundary for the Jolt physics addon.
//
// Thin wrapper: the heavy lifting (PhysicsSystem, allocator, job
// system, entity->BodyID map, shape cache) lives natively. All bulk,
// structure-of-arrays; no per-entity N-API in the hot loop.
// Per tick: syncBodies(count, ...) -> step(dt, subSteps) -> copyResults(count, ...).
//
// Contracts:
// - Entity identity is the engine's u64 wire id (generation << 32 | slot).
//   Native BodyIDs are never exposed to JS.
// - addBodies is order-sensitive: callers MUST pass entities in a
//   deterministic order (ascending id) so the native insertion order is
//   identical across processes/runs (Jolt is deterministic given the
//   same binary and the same mutating-API call order).
// - All world ops run on the JS thread; the addon never spawns its own
//   JS-visible threads.
// - destroy() is explicit; the C++ finalizer tears the world down as a
//   backstop if the caller forgets.

'use strict';

const path = require('node:path');

const { PhysicsWorld } = require(path.join(
  __dirname,
  'build',
  'Release',
  'physics.node',
));

const ShapeKind = Object.freeze({ Box: 0, Sphere: 1, Capsule: 2 });
const MotionType = Object.freeze({ Static: 0, Kinematic: 1, Dynamic: 2 });
const SyncFlags = Object.freeze({ None: 0, Teleport: 0x01 });

function createWorld() {
  return new PhysicsWorld();
}

module.exports = {
  PhysicsWorld,
  createWorld,
  ShapeKind,
  MotionType,
  SyncFlags,
};
