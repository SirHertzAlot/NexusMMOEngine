/**
 * Road legs (SG11): a spawned slab draped over the terrain, then the strip.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROAD_LIFT_M, ROAD_STEP_M, legRibbon, roadStrip, type RoadLeg } from "../src/render/roads/road-mesh.js";

const leg = (o: Partial<RoadLeg> = {}): RoadLeg => ({ x: 100, y: 10, z: 200, yaw: 0, width: 6, length: 20, thickness: 0.1, ...o });

describe("legRibbon", () => {
  it("runs along its yaw: +z at 0, +x at 90 degrees, with the rails half a width either side", () => {
    const a = legRibbon(leg(), () => 10);
    assert.equal(a.left.length, a.right.length);
    // yaw 0: the leg runs along z from 190 to 210; the rails sit at x 100 +/- 3
    assert.ok(Math.abs(a.left[2]! - 190) < 1e-9 && Math.abs(a.left[a.left.length - 1]! - 210) < 1e-9);
    assert.ok(Math.abs(Math.abs(a.left[0]! - a.right[0]!) - 6) < 1e-9);
    const b = legRibbon(leg({ yaw: Math.PI / 2 }), () => 10);
    assert.ok(Math.abs(b.left[0]! - 90) < 1e-9 && Math.abs(b.left[b.left.length - 3]! - 110) < 1e-9, "along x");
    assert.ok(Math.abs(Math.abs(b.left[2]! - b.right[2]!) - 6) < 1e-9, "rails apart in z");
  });

  it("samples at most a step apart, both ends included, and follows a slope", () => {
    const r = legRibbon(leg({ length: 21 }), (_x, z) => (z - 190) * 0.5);
    const n = r.left.length / 3;
    assert.equal(n, Math.ceil(21 / ROAD_STEP_M) + 1);
    for (let i = 1; i < n; i++) assert.ok(Math.abs(r.left[i * 3 + 2]! - r.left[(i - 1) * 3 + 2]!) <= ROAD_STEP_M + 1e-9);
    // 21 m long at a 0.5 slope: the far end stands 10.5 m above the near end
    assert.ok(Math.abs(r.left[(n - 1) * 3 + 1]! - r.left[1]! - 10.5) < 1e-9, "the road climbs with the ground");
    assert.equal(r.draped, true);
  });

  it("falls back to the slab's top where no terrain is loaded, and says so", () => {
    const r = legRibbon(leg(), () => null);
    assert.equal(r.draped, false);
    for (let i = 1; i < r.left.length; i += 3) assert.ok(Math.abs(r.left[i]! - 10.1) < 1e-9);
    const half = legRibbon(leg(), (_x, z) => (z < 200 ? 12 : null));
    assert.equal(half.draped, false, "partly loaded is still not draped");
  });
});

describe("a draped leg as a strip", () => {
  it("lifts the surface off the ground and builds two triangles a segment", () => {
    const r = legRibbon(leg({ length: 6 }), () => 5);
    const strip = roadStrip(r);
    const n = r.left.length / 3;
    assert.equal(strip.positions.length, n * 6, "two vertices of three floats per sample");
    assert.equal(strip.indices.length, (n - 1) * 6);
    assert.ok(Math.abs(strip.positions[1]! - (5 + ROAD_LIFT_M)) < 1e-6);
  });
});
