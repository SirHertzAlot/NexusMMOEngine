/**
 * CollapseWatch (DE2 / DE5): pure tests for release crumble, falling dust trail, and landing impact bursts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CollapseWatch } from "../src/render/collapse-fx.js";

const tf = (px: number, py: number, pz: number) => ({ wireId: 2n, px, py, pz, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 });
const body = { wireId: 2n, shapeKind: 0, motionType: 0, layer: 0, radius: 0, halfX: 1, halfY: 1, halfZ: 0.5, mass: 10, friction: 0.5, restitution: 0 };
const vel = (lx: number, ly: number, lz: number) => ({ wireId: 2n, lx, ly, lz, ax: 0, ay: 0, az: 0 });

describe("CollapseWatch (DE2 / DE5)", () => {
  it("ignores entities that were never static", () => {
    const w = new CollapseWatch();
    assert.equal(w.observe(1n, tf(0, 5, 0), body, false, vel(0, -3, 0), 0, 0), null);
    assert.equal(w.size, 0);
  });

  it("emits release, trail while falling, and impact once settled on terrain", () => {
    const w = new CollapseWatch();
    // Standing static on second floor at y = 5 (base = 4).
    assert.equal(w.observe(2n, tf(10, 5, 10), body, true, undefined, 1.0, 0), null);
    // Released by CollapseSystem: drops > 0.08m and becomes dynamic.
    const rel = w.observe(2n, tf(10, 4.8, 10), body, false, vel(0, -2, 0), 1.05, 0);
    assert.ok(rel?.release, "release burst emitted");

    // Trailing dust while falling fast (>= 0.14s later).
    const trail = w.observe(2n, tf(10, 3.0, 10), body, false, vel(0, -6, 0), 1.25, 0);
    assert.ok(trail?.trail, "trail dust emitted mid-fall");

    // Lands at ground (y - hy <= groundY + 0.35 -> y = 1.1) and decelerates.
    const impact = w.observe(2n, tf(10, 1.1, 10), body, false, vel(0, -0.2, 0), 1.4, 0);
    assert.ok(impact?.impact, "impact dust + debris emitted once");

    // Subsequent settled ticks produce nothing further.
    assert.equal(w.observe(2n, tf(10, 1.1, 10), body, false, vel(0, 0, 0), 1.6, 0), null);
  });
});
