/**
 * scatter-spawn tests (PCG slice 4: region chunk-load integration).
 *
 * - scatterSeedU32 is deterministic and stays in u32 range.
 * - scatterChunkToECS wires spawn records to ECS entities: Transform
 *   (position/yaw->quaternion/scale), AssetRef (fnv1a32/variant),
 *   Health for breakable archetypes, Velocity+BodyConfig for colliders.
 * - The engine depends only on the ScatterBinding interface: a stub
 *   binding proves the seam without native code.
 * - With the real native binding + forest content, two runs are
 *   identical and points rest on the terrain (not y=0).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { hasComponent } from "bitecs";
import {
  AssetRef,
  BodyConfig,
  Health,
  MotionType,
  ShapeKind,
  SimWorld,
  Transform,
  Velocity,
  loadScatterContent,
  makeScatterBinding,
  scatterChunkToECS,
  scatterSeedU32,
} from "../../src/index.js";
import type { ScatterBinding, ScatterContent } from "../../src/index.js";
import type { SpawnRecord } from "@mmo-engine/scatter";
import { fnv1a32 } from "@mmo-engine/scatter";

function flatHeights(n: number, h = 3): Float32Array {
  return new Float32Array(n).fill(h);
}

function stubContent(): ScatterContent {
  return loadScatterContent();
}

/** Stub binding: proves the wrapper depends only on the interface. */
function stubBinding(records: SpawnRecord[]): ScatterBinding {
  return {
    scatterChunk: (args) => {
      assert.ok(args.heights instanceof Float64Array);
      assert.ok(args.gridN * args.gridN === args.heights.length);
      return records;
    },
  };
}

function oakRecord(): SpawnRecord {
  return {
    x: 4, y: 3, z: 5, yaw: Math.PI / 2, pitch: 0, roll: 0,
    sx: 1, sy: 2, sz: 1, asset: "oak",
    variantSeed: 0x12345678, seed: 42, attrs: {},
  };
}

function birchRecord(): SpawnRecord {
  return {
    x: 8, y: 3, z: 9, yaw: 0, pitch: 0, roll: 0,
    sx: 1, sy: 1, sz: 1, asset: "birch",
    variantSeed: 0xabcdef, seed: 43, attrs: {},
  };
}

test("scatterSeedU32 is deterministic and in u32 range", () => {
  const a = scatterSeedU32(0xabcdef0123456789n);
  const b = scatterSeedU32(0xabcdef0123456789n);
  assert.equal(a, b);
  assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xffffffff);
  assert.notEqual(a, scatterSeedU32(0xabcdef0123456788n));
});

test("scatterChunkToECS: Transform + AssetRef wiring", () => {
  const world = new SimWorld();
  const eids = scatterChunkToECS(world, stubBinding([birchRecord()]), stubContent(), {
    worldSeed: 99n, cx: 0, cz: 0, heights: flatHeights(256),
  });
  assert.equal(eids.length, 1);
  const eid = eids[0];
  assert.ok(hasComponent(world.ecs, Transform, eid));
  assert.equal(Transform.px[eid], 8);
  assert.equal(Transform.py[eid], 3);
  assert.equal(Transform.pz[eid], 9);
  // yaw = 0 -> identity quaternion (0, 0, 0, 1), unit length.
  const ql = Transform.qx[eid] ** 2 + Transform.qy[eid] ** 2 +
    Transform.qz[eid] ** 2 + Transform.qw[eid] ** 2;
  assert.ok(Math.abs(ql - 1) < 1e-6);
  assert.ok(Math.abs(Transform.qw[eid] - 1) < 1e-6);
  assert.equal(Transform.sx[eid], 1);
  assert.equal(Transform.sy[eid], 1);
  assert.equal(Transform.sz[eid], 1);
  assert.ok(hasComponent(world.ecs, AssetRef, eid));
  assert.equal(AssetRef.assetHash[eid], fnv1a32("birch"));
  assert.equal(AssetRef.variant[eid], (0xabcdef >>> 16) & 0xffff);
});

test("scatterChunkToECS: oak gets Health (breakable) + static BodyConfig", () => {
  const world = new SimWorld();
  const eids = scatterChunkToECS(world, stubBinding([oakRecord()]), stubContent(), {
    worldSeed: 99n, cx: 0, cz: 0, heights: flatHeights(256),
  });
  const eid = eids[0];
  // yaw = PI/2 -> quaternion (0, sin(pi/4), 0, cos(pi/4)): yaw-only rotation.
  assert.ok(Math.abs(Transform.qy[eid] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(Transform.qw[eid] - Math.SQRT1_2) < 1e-6);
  // Breakable: health.max from the spawn table archetype.
  assert.ok(hasComponent(world.ecs, Health, eid));
  assert.equal(Health.max[eid], 100);
  assert.equal(Health.current[eid], 100);
  // Static collider: PhysicsSystem's [Transform, Velocity, BodyConfig].
  assert.ok(hasComponent(world.ecs, Velocity, eid));
  assert.ok(hasComponent(world.ecs, BodyConfig, eid));
  assert.equal(BodyConfig.shapeKind[eid], ShapeKind.Box);
  assert.equal(BodyConfig.halfX[eid], 0.5);
  assert.equal(BodyConfig.halfY[eid], 2.0);
  assert.equal(BodyConfig.halfZ[eid], 0.5);
  assert.equal(BodyConfig.motionType[eid], MotionType.Static);
  assert.equal(BodyConfig.layer[eid], 0);
});

test("scatterChunkToECS: birch has neither Health nor BodyConfig", () => {
  const world = new SimWorld();
  const eids = scatterChunkToECS(world, stubBinding([birchRecord()]), stubContent(), {
    worldSeed: 99n, cx: 0, cz: 0, heights: flatHeights(256),
  });
  const eid = eids[0];
  assert.ok(!hasComponent(world.ecs, Health, eid));
  assert.ok(!hasComponent(world.ecs, BodyConfig, eid));
  assert.ok(!hasComponent(world.ecs, Velocity, eid));
});

test("scatterChunkToECS: rejects non-square heightmaps", () => {
  const world = new SimWorld();
  assert.throws(
    () => scatterChunkToECS(world, stubBinding([]), stubContent(), {
      worldSeed: 1n, cx: 0, cz: 0, heights: new Float32Array(150),
    }),
    /square/,
  );
});

test("real binding: deterministic across runs, points rest on terrain", () => {
  const binding = makeScatterBinding();
  const content = loadScatterContent();
  // Gentle sloped heightfield: h = 0.1x + 0.05z (well within the forest
  // plan's slope filter, but non-flat so the terrain snap is provable).
  const side = 16;
  const heights = new Float32Array(side * side);
  const step = 16 / (side - 1);
  const hAt = (x: number, z: number) => 0.1 * x + 0.05 * z;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      heights[j * side + i] = hAt(i * step, j * step);
    }
  }
  const opts = { worldSeed: 1234n, cx: 0, cz: 0, heights, chunkWorldSize: 16 };
  const run = () => {
    const w = new SimWorld();
    return scatterChunkToECS(w, binding, content, opts).map((eid) => ({
      x: Transform.px[eid], y: Transform.py[eid], z: Transform.pz[eid],
      h: AssetRef.assetHash[eid],
    }));
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.ok(a.length > 0, "forest plan spawns on this terrain");
  for (const p of a) {
    // y snaps to the bilinear heightfield (h = 0.1x + 0.05z on this ramp),
    // not the old y=0 bug.
    assert.ok(Math.abs(p.y - hAt(p.x, p.z)) < 0.05, `y=${p.y} off terrain`);
  }
});
