/** Shared bodies: buffered snapshots drawn behind the clock, lerp and slerp, no extrapolation. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SnapshotInterpolator, slerp, type BodySnapshot, type Quat } from "../src/physics/snapshot-interpolator.js";

const ID: Quat = { x: 0, y: 0, z: 0, w: 1 };
const TICK = 0.05; // 20 Hz
const snap = (tick: number, x: number, quat: Quat = ID): BodySnapshot => ({ tick, pos: { x, y: 0, z: 0 }, quat });
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

describe("SnapshotInterpolator", () => {
  it("returns null before any snapshot", () => {
    const si = new SnapshotInterpolator({ tickSeconds: TICK, delaySeconds: 0.1 });
    assert.equal(si.sample(5), null);
  });

  it("draws the body delaySeconds behind the clock, lerping between snapshots", () => {
    const si = new SnapshotInterpolator({ tickSeconds: TICK, delaySeconds: 0.1 });
    si.push(snap(0, 0));
    si.push(snap(2, 2)); // 0.10 s in server time
    // now = 0.2 -> target 0.1 s, the second snapshot's time
    near(si.sample(0.2)!.pos.x, 2);
    // now = 0.15 -> target 0.05 s, halfway between tick 0 and tick 2
    near(si.sample(0.15)!.pos.x, 1);
  });

  it("holds the nearest snapshot outside the buffer, never extrapolating", () => {
    const si = new SnapshotInterpolator({ tickSeconds: TICK, delaySeconds: 0 });
    si.push(snap(10, 5));
    si.push(snap(12, 7));
    near(si.sample(0)!.pos.x, 5); // before the oldest: hold it
    near(si.sample(100)!.pos.x, 7); // after the newest: hold it
  });

  it("ignores a late or duplicate snapshot", () => {
    const si = new SnapshotInterpolator({ tickSeconds: TICK, delaySeconds: 0 });
    assert.equal(si.push(snap(5, 1)), true);
    assert.equal(si.push(snap(5, 9)), false);
    assert.equal(si.push(snap(4, 9)), false);
    assert.equal(si.size, 1);
  });

  it("drops the oldest snapshot past the capacity", () => {
    const si = new SnapshotInterpolator({ tickSeconds: TICK, delaySeconds: 0, capacity: 3 });
    for (let t = 0; t < 6; t++) si.push(snap(t, t));
    assert.equal(si.size, 3);
    near(si.sample(0)!.pos.x, 3); // oldest kept is tick 3
  });

  it("slerps rotation along the shortest arc, with unit output", () => {
    const si = new SnapshotInterpolator({ tickSeconds: 1, delaySeconds: 0 });
    const half = Math.SQRT1_2;
    si.push(snap(0, 0, ID));
    si.push(snap(1, 0, { x: 0, y: half, z: 0, w: half })); // 90 degrees about y
    const mid = si.sample(0.5)!.quat;
    near(Math.hypot(mid.x, mid.y, mid.z, mid.w), 1);
    near(mid.y, Math.sin(Math.PI / 8), 1e-6); // 45 degrees about y, half angle
    // The same rotation written as its negative must give the same result.
    const alt = slerp(ID, { x: 0, y: -half, z: 0, w: -half }, 0.5);
    near(alt.y, mid.y, 1e-6);
    near(alt.w, mid.w, 1e-6);
  });

  it("holds the newest snapshot when every tick time is zero (no division by zero)", () => {
    const si = new SnapshotInterpolator({ tickSeconds: 0, delaySeconds: 0 });
    si.push(snap(0, 1));
    si.push(snap(1, 3));
    const p = si.sample(0.5);
    assert.ok(p && Number.isFinite(p.pos.x));
    near(p.pos.x, 3);
  });
});
