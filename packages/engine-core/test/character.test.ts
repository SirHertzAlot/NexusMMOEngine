import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  CharacterSystem,
  GRAVITY,
  IntentSystem,
  IntegrateSystem,
  JUMP_SPEED,
  makeProcgenChunkSource,
  PlayerIntent,
  SimWorld,
  terrainHeightAt,
  Transform,
  Velocity,
  type ChunkDataSource,
} from "../src/index.js";

/** Flat elevated ground at height 2 everywhere. */
const flatSource: ChunkDataSource = {
  chunkSamples: 256,
  generateChunk: (_seed, _cx, _cz, _lod, out) => out.fill(2),
};

function makePlayer(py: number): { sim: SimWorld; eid: number } {
  const sim = new SimWorld();
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, PlayerIntent, eid);
  Transform.px[eid] = 4;
  Transform.py[eid] = py;
  Transform.pz[eid] = 4;
  return { sim, eid };
}

const DT = 1 / 30;

test("jump fires on rising edge while grounded", () => {
  const { sim, eid } = makePlayer(2); // exactly on the ground
  const sys = new CharacterSystem({ chunkSource: flatSource, worldSeed: 1n });
  PlayerIntent.jump[eid] = 1;
  sys.step(sim, DT);
  assert.equal(Velocity.ly[eid], JUMP_SPEED);
});

test("holding jump does not multi-jump mid-air (rising edge)", () => {
  const { sim, eid } = makePlayer(2);
  const sys = new CharacterSystem({ chunkSource: flatSource, worldSeed: 1n });
  PlayerIntent.jump[eid] = 1;
  sys.step(sim, DT); // jumps
  assert.equal(Velocity.ly[eid], JUMP_SPEED);
  Transform.py[eid] = 5; // now airborne, still holding
  sys.step(sim, DT);
  assert.ok(Velocity.ly[eid] < JUMP_SPEED); // gravity, not a re-jump
});

test("airborne entities accelerate downward", () => {
  const { sim, eid } = makePlayer(10);
  const sys = new CharacterSystem({ chunkSource: flatSource, worldSeed: 1n });
  sys.step(sim, DT);
  assert.ok(Math.abs(Velocity.ly[eid] - -GRAVITY * DT) < 1e-6);
  sys.step(sim, DT);
  assert.ok(Math.abs(Velocity.ly[eid] - -2 * GRAVITY * DT) < 1e-6);
});

test("grounded entities snap to terrain and kill downward velocity", () => {
  const { sim, eid } = makePlayer(1.5); // below ground (2), within snap
  Velocity.ly[eid] = -5;
  const sys = new CharacterSystem({ chunkSource: flatSource, worldSeed: 1n });
  sys.step(sim, DT);
  assert.equal(Velocity.ly[eid], 0);
  assert.equal(Transform.py[eid], 2);
});

test("full tick order: intent -> integrate -> character jumps and lands", () => {
  const { sim, eid } = makePlayer(2);
  const systems = [
    new IntentSystem(),
    new IntegrateSystem(),
    new CharacterSystem({ chunkSource: flatSource, worldSeed: 1n }),
  ];
  // Walk forward one tick: horizontal velocity applied, stays grounded.
  PlayerIntent.mx[eid] = 1;
  for (const s of systems) s.step(sim, DT);
  assert.ok(Transform.px[eid] > 4);
  assert.equal(Transform.py[eid], 2);

  // Jump, then simulate until landing: must return to ground, never below.
  PlayerIntent.mx[eid] = 0;
  PlayerIntent.jump[eid] = 1;
  for (const s of systems) s.step(sim, DT);
  PlayerIntent.jump[eid] = 0;
  let minY = Infinity;
  for (let t = 0; t < 120; t++) {
    for (const s of systems) s.step(sim, DT);
    minY = Math.min(minY, Transform.py[eid]);
  }
  assert.ok(minY >= 2 - 1e-6, `sank below ground: ${minY}`);
  assert.ok(Math.abs(Transform.py[eid] - 2) < 1e-6, "did not land back");
  assert.equal(Velocity.ly[eid], 0);
});

test("without a chunk source the ground is y=0", () => {
  const { sim, eid } = makePlayer(0);
  const sys = new CharacterSystem({});
  PlayerIntent.jump[eid] = 1;
  sys.step(sim, DT);
  assert.equal(Velocity.ly[eid], JUMP_SPEED);
});

// ---- terrain surface: grounding matches the rendered mesh ----------------

/** Heightfield where sample (i, j) = i + 10*j: every cell is a known plane pair. */
function rampHeights(): Float32Array {
  const h = new Float32Array(256);
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) h[j * 16 + i] = i + 10 * j;
  return h;
}

test("terrainHeightAt hits every sample exactly at its vertex", () => {
  const h = rampHeights();
  for (const [i, j] of [[0, 0], [15, 0], [0, 15], [15, 15], [7, 9]]) {
    const lx = (i * 16) / 15;
    const lz = (j * 16) / 15;
    assert.ok(Math.abs(terrainHeightAt(h, lx, lz, 16) - h[j * 16 + i]) < 1e-9, `vertex (${i},${j})`);
  }
});

test("terrainHeightAt interpolates on PlaneGeometry's anti-diagonal triangles", () => {
  // One cell with a fold only visible if the right diagonal is used:
  // h00 = 0, h10 = 0, h01 = 0, h11 = 4. PlaneGeometry splits along
  // (i, j+1)-(i+1, j), so the (0,0) triangle is flat and only the far
  // triangle rises toward h11.
  const h = new Float32Array(256);
  h[1 * 16 + 1] = 4;
  const at = (fx: number, fz: number): number =>
    terrainHeightAt(h, (fx * 16) / 15, (fz * 16) / 15, 16);
  assert.ok(Math.abs(at(0.25, 0.25)) < 1e-9, "near triangle stays flat");
  assert.ok(Math.abs(at(0.5, 0.5)) < 1e-9, "on the shared diagonal: flat");
  // Far triangle: h = h11 + (1-fx)(h01-h11) + (1-fz)(h10-h11) = 4(fx+fz-1).
  assert.ok(Math.abs(at(0.75, 0.75) - 2) < 1e-9, "far triangle rises");
  assert.ok(Math.abs(at(1, 1) - 4) < 1e-9);
  // Nearest-sample grounding (the old behaviour) would report 4 at (0.75, 0.75).
});

test("terrainHeightAt clamps outside the chunk to its edge", () => {
  const h = rampHeights();
  assert.equal(terrainHeightAt(h, -3, 0, 16), h[0]);
  assert.equal(terrainHeightAt(h, 99, 99, 16), h[255]);
});

test("grounding is continuous across chunk borders with real terrain", () => {
  const source = makeProcgenChunkSource();
  const { sim, eid } = makePlayer(100);
  const sys = new CharacterSystem({ chunkSource: source, worldSeed: 1234n });
  const groundAt = (x: number, z: number): number => {
    Transform.px[eid] = x;
    Transform.pz[eid] = z;
    Transform.py[eid] = -100; // below ground: snaps up to the surface
    Velocity.ly[eid] = 0;
    sys.step(sim, DT);
    return Transform.py[eid];
  };
  for (const border of [16, 32, -16]) {
    for (const z of [3.3, 8, 12.9]) {
      const west = groundAt(border - 1e-4, z);
      const east = groundAt(border + 1e-4, z);
      assert.ok(Math.abs(west - east) < 1e-2, `x=${border} z=${z}: ${west} vs ${east}`);
      const north = groundAt(z, border - 1e-4);
      const south = groundAt(z, border + 1e-4);
      assert.ok(Math.abs(north - south) < 1e-2, `z=${border} x=${z}: ${north} vs ${south}`);
    }
  }
});

test("players in different chunks don't regenerate heightfields every tick", () => {
  let calls = 0;
  const counting: ChunkDataSource = {
    chunkSamples: 256,
    generateChunk: (_s, cx, _cz, _l, out) => {
      calls++;
      out.fill(cx);
    },
  };
  const sim = new SimWorld();
  const eids: number[] = [];
  for (let k = 0; k < 4; k++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Velocity, e);
    addComponent(sim.ecs, PlayerIntent, e);
    Transform.px[e] = 8 + 16 * k; // one player per chunk
    Transform.pz[e] = 8;
    Transform.py[e] = k;
    eids.push(e);
  }
  const sys = new CharacterSystem({ chunkSource: counting, worldSeed: 1n });
  for (let t = 0; t < 30; t++) sys.step(sim, DT);
  assert.equal(calls, 4, "one generation per chunk, not per player per tick");
  for (let k = 0; k < 4; k++) assert.equal(Transform.py[eids[k]], k);
});
