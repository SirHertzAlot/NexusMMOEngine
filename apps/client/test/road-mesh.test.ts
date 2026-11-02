/**
 * Road surface mesh (SG2b client side): a draped ribbon becomes a strip of triangles whose top
 * faces point up, lifted just above the terrain, and a malformed ribbon draws nothing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROAD_LIFT_M, roadStrip } from "../src/render/roads/road-mesh.js";

/** A flat 4 m wide road along +x, sampled at 0, 1, 2 m. */
const flat = {
  left: [0, 0, 2, 1, 0, 2, 2, 0, 2],
  right: [0, 0, -2, 1, 0, -2, 2, 0, -2],
};

describe("road strip", () => {
  it("makes two vertices per sample and two triangles per segment", () => {
    const s = roadStrip(flat);
    assert.equal(s.positions.length, 3 * 6);
    assert.equal(s.indices.length, 6 * 2);
  });

  it("lifts the surface just above the terrain on both rails", () => {
    const s = roadStrip(flat);
    for (let v = 0; v < 6; v++) assert.ok(Math.abs(s.positions[v * 3 + 1] - ROAD_LIFT_M) < 1e-6);
  });

  it("winds every triangle so its top face points up", () => {
    const s = roadStrip(flat);
    const p = (v: number) => [s.positions[v * 3], s.positions[v * 3 + 1], s.positions[v * 3 + 2]];
    for (let t = 0; t < s.indices.length; t += 3) {
      const [a, b, c] = [p(s.indices[t]), p(s.indices[t + 1]), p(s.indices[t + 2])];
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      assert.ok(ny > 0, `triangle at ${t} faces down`);
    }
  });

  it("follows a draped slope: each vertex keeps its own height", () => {
    const s = roadStrip({ left: [0, 0, 2, 1, 1, 2], right: [0, 0, -2, 1, 1, -2] }, 0);
    assert.equal(s.positions[1], 0); // left sample 0 height
    assert.equal(s.positions[4], 1); // left sample 1 height, not the first one's
  });

  it("draws nothing for a ribbon with fewer than two samples or rails of unequal length", () => {
    assert.equal(roadStrip({ left: [0, 0, 0], right: [0, 0, 0] }).indices.length, 0);
    assert.equal(roadStrip({ left: [0, 0, 0, 1, 0, 0], right: [0, 0, 0] }).indices.length, 0);
  });
});
