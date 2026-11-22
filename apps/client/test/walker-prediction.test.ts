/**
 * Local-player walker prediction: replaying inputs after a server snapshot
 * matches the server, and a correction is shown as a blend, not a snap.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRapierPhysicsWorld, type PhysicsWorld, WalkerPredictor } from "../src/physics/index.js";

const DT = 1 / 60;
const START = { x: 0, y: 0.9, z: 0 };
const RADIUS = 0.4;
const HALF = 0.5;
const OPTS = { blendSeconds: 0.2, snapMetres: 1 };

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe("WalkerPredictor", () => {
  let world: PhysicsWorld;
  before(async () => {
    world = await createRapierPhysicsWorld();
    world.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 60, y: 0.5, z: 60 });
  });
  after(() => world.dispose());

  it("with no divergence, a snapshot changes nothing", () => {
    const handle = world.spawnWalker(START, RADIUS, HALF);
    const p = new WalkerPredictor(world, handle, DT, OPTS, START);
    const track = [START];
    for (let t = 1; t <= 60; t++) {
      p.step({ x: 0.05, y: 0, z: 0 });
      track[t] = p.predicted;
    }
    const err = p.onSnapshot({ tick: 30, pos: track[30]! });
    assert.ok(err < 1e-4, `error ${err}`);
    world.removeWalker(handle);
  });

  it("a server knock is corrected by replay, and the drawn position stays continuous", () => {
    const handle = world.spawnWalker(START, RADIUS, HALF);
    const p = new WalkerPredictor(world, handle, DT, OPTS, START);
    const serverTrack = [START];
    for (let t = 1; t <= 60; t++) {
      // The server gets a 0.5 m shove at tick 20 that the client does not predict.
      const shove = t === 20 ? 0.5 : 0;
      p.step({ x: 0.05, y: 0, z: 0 });
      serverTrack[t] = { x: serverTrack[t - 1]!.x + 0.05 + shove, y: START.y, z: 0 };
    }
    // Snapshot for tick 30 arrives now, after the shove.
    const before = p.visual;
    const err = p.onSnapshot({ tick: 30, pos: serverTrack[30]! });
    assert.ok(err > 0.4 && err < 0.6, `expected about 0.5 m of error, got ${err}`);
    // The replayed prediction lands on the server's position after replay.
    assert.ok(dist(p.predicted, serverTrack[60]!) < 0.05, `replayed ${JSON.stringify(p.predicted)}`);
    // The drawn position does not jump at the snapshot itself.
    assert.ok(dist(p.visual, before) < 1e-3, "visual jumped on snapshot");
    // Then the offset decays back toward the prediction.
    for (let i = 0; i < 60; i++) p.decay(DT);
    assert.ok(dist(p.visual, p.predicted) < 0.01, "offset did not decay");
    world.removeWalker(handle);
  });

  it("a snapshot older than the kept history is ignored", () => {
    const handle = world.spawnWalker(START, RADIUS, HALF);
    const p = new WalkerPredictor(world, handle, DT, OPTS, START, 10);
    for (let t = 1; t <= 30; t++) p.step({ x: 0.01, y: 0, z: 0 });
    assert.ok(Number.isNaN(p.onSnapshot({ tick: 1, pos: START })));
    world.removeWalker(handle);
  });
});

describe("teleportWalker", () => {
  it("moves a walker without collision", async () => {
    const w = await createRapierPhysicsWorld();
    w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 60, y: 0.5, z: 60 });
    const h = w.spawnWalker(START, RADIUS, HALF);
    w.teleportWalker(h, { x: 10, y: 0.9, z: -5 });
    const st = w.moveWalker(h, { x: 0, y: 0, z: 0 });
    w.step(DT);
    assert.ok(dist(st, { x: 10, y: 0.9, z: -5 }) < 0.02, `walker at ${JSON.stringify(st)}`);
    w.dispose();
  });
});
