// manifold + Clipper2 through the addon: cell outlines, polygon Booleans and
// offsets, and CSG solids with tags, in the engine's y-up frame.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const geo = require("../index.js");

/** Rings as arrays of [x, z]. */
function rings(p) {
  const out = [];
  let at = 0;
  for (const n of p.rings) {
    const ring = [];
    for (let i = 0; i < n; i++, at++) ring.push([p.points[at * 2], p.points[at * 2 + 1]]);
    out.push(ring);
  }
  return out;
}

/** Signed area seen from above (counter-clockwise positive): shoelace in (x, -z). */
function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * -z1 - x1 * -z0;
  }
  return a / 2;
}

function poly(...ringList) {
  const pts = ringList.flat(2);
  return { points: Float64Array.from(pts), rings: Uint32Array.from(ringList.map((r) => r.length)) };
}

/** A counter-clockwise (seen from above) square. */
const square = (x0, z0, s) => [[x0, z0 + s], [x0 + s, z0 + s], [x0 + s, z0], [x0, z0]];

function bounds(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  return { min, max };
}

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe("addon-geometry", () => {
  it("reports its libraries", () => {
    assert.match(geo.version(), /^manifold 3\.5\.4, Clipper2 2\.0\.1/);
  });

  describe("cellsToPolygons", () => {
    it("merges cells into one outline, counter-clockwise seen from above", () => {
      // ###
      // #..
      const mask = Uint8Array.from([1, 1, 1, 1, 0, 0]);
      const p = geo.cellsToPolygons(mask, 3, 2, { cell: 2 });
      const rs = rings(p);
      assert.equal(rs.length, 1);
      assert.equal(rs[0].length, 6, "an L has six corners (collinear points simplified away)");
      assert.ok(close(p.area, 16));
      assert.ok(signedArea(rs[0]) > 0, "outer ring counter-clockwise");
      // z runs down the rows: the L's foot is at z 2..4, x 0..2.
      const zs = rs[0].map(([, z]) => z);
      // -0 and 0 are the same position; the addon builds with -ffast-math, which can yield -0.
      assert.ok(Math.min(...zs) === 0);
      assert.ok(Math.max(...zs) === 4);
      assert.ok(rs[0].some(([x, z]) => x === 2 && z === 4), "the foot's corner");
    });

    it("keeps holes, clockwise", () => {
      const mask = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
      const p = geo.cellsToPolygons(mask, 3, 3);
      const rs = rings(p);
      assert.equal(rs.length, 2);
      assert.ok(close(p.area, 8));
      const signs = rs.map(signedArea).sort((a, b) => a - b);
      assert.ok(close(signs[0], -1) && close(signs[1], 9), `outer +9, hole -1 (got ${signs})`);
    });

    it("picks one value, grows outlines, and is empty for an empty mask", () => {
      const mask = Uint8Array.from([1, 2, 2, 0]);
      assert.ok(close(geo.cellsToPolygons(mask, 2, 2, { value: 2 }).area, 2));
      assert.ok(close(geo.cellsToPolygons(mask, 2, 2).area, 3));
      const grown = geo.cellsToPolygons(Uint8Array.from([1]), 1, 1, { offset: 0.5, join: "miter" });
      assert.ok(close(grown.area, 4), `a unit cell grown by 0.5 is 2 x 2 (got ${grown.area})`);
      const none = geo.cellsToPolygons(new Uint8Array(4), 2, 2);
      assert.equal(none.rings.length, 0);
      assert.equal(none.area, 0);
    });

    it("refuses bad input", () => {
      assert.throws(() => geo.cellsToPolygons(new Uint8Array(5), 2, 2), /width x height/);
      assert.throws(() => geo.cellsToPolygons([1, 1], 2, 1), /Uint8Array/);
      assert.throws(() => geo.cellsToPolygons(new Uint8Array(1), 1, 1, { cell: 0 }), /positive/);
      assert.throws(() => geo.cellsToPolygons(new Uint8Array(1), 1, 1, { join: "wobbly" }), /join/);
    });
  });

  describe("polygon Booleans and offsets", () => {
    const a = poly(square(0, 0, 2));
    const b = poly(square(1, 1, 2));
    it("unions, subtracts and intersects", () => {
      assert.ok(close(geo.polygonBoolean("union", a, b).area, 7));
      assert.ok(close(geo.polygonBoolean("difference", a, b).area, 3));
      assert.ok(close(geo.polygonBoolean("intersection", a, b).area, 1));
    });
    it("takes rings either way round", () => {
      const cw = poly([...square(0, 0, 2)].reverse());
      assert.ok(close(geo.polygonBoolean("union", cw, b).area, 7));
    });
    it("shrinks and grows", () => {
      assert.ok(close(geo.polygonOffset(a, -0.5).area, 1));
      const round = geo.polygonOffset(a, 1, { join: "round", segments: 256 }).area;
      assert.ok(close(round, 4 + 4 * 2 + Math.PI, 0.01), `2 x 2 grown round by 1 (got ${round})`);
    });
    it("refuses bad polygons and operations", () => {
      assert.throws(() => geo.polygonBoolean("xor", a, b), /union, difference or intersection/);
      assert.throws(() => geo.polygonBoolean("union", { points: new Float64Array(3), rings: Uint32Array.of(1) }, b), /odd length/);
      assert.throws(() => geo.polygonBoolean("union", { points: new Float64Array(4), rings: Uint32Array.of(3) }, b), /rings hold 3 points/);
      assert.throws(() => geo.polygonBoolean("union", { points: [0, 0], rings: Uint32Array.of(1) }, b), /Float64Array/);
    });
  });

  describe("solid", () => {
    it("builds boxes where they are asked for", () => {
      const r = geo.solid({ op: "box", min: [1, 2, 3], max: [4, 6, 8] });
      assert.ok(close(r.volume, 3 * 4 * 5));
      const { min, max } = bounds(r.positions);
      assert.deepEqual(min, [1, 2, 3]);
      assert.deepEqual(max, [4, 6, 8]);
      assert.equal(r.genus, 0);
      assert.equal(r.tags.length, r.indices.length / 3);
    });

    it("extrudes x-z polygons upward from y0, without mirroring z", () => {
      const l = geo.cellsToPolygons(Uint8Array.from([1, 1, 1, 1, 0, 0]), 3, 2, { cell: 2 });
      const r = geo.solid({ op: "extrude", polygons: l, y0: -1, height: 3 });
      assert.ok(close(r.volume, 16 * 3));
      const { min, max } = bounds(r.positions);
      // -0 and 0 are the same position; normalise so the comparison is not sign-sensitive.
      assert.deepEqual(min.map((v) => v + 0), [0, -1, 0]);
      assert.deepEqual(max.map((v) => v + 0), [6, 2, 4]);
      // The L's foot is at x 0..2, z 2..4: a vertex there, none at x 4..6, z 4.
      const has = (x, z) => {
        for (let i = 0; i < r.positions.length; i += 3) if (r.positions[i] === x && r.positions[i + 2] === z) return true;
        return false;
      };
      assert.ok(has(2, 4) && !has(6, 4));
    });

    it("carves, and each face keeps the tag of the input it came from", () => {
      // A cup: a 4 x 4 x 4 block with a 2 x 3 x 2 hole cut down from its top.
      const r = geo.solid({
        op: "difference",
        of: [
          { op: "box", min: [0, 0, 0], max: [4, 4, 4], tag: 1 },
          { op: "box", min: [1, 1, 1], max: [3, 5, 3], tag: 2 },
        ],
      });
      assert.ok(close(r.volume, 64 - 2 * 3 * 2));
      assert.equal(r.genus, 0);
      const counts = new Map();
      for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      assert.deepEqual([...counts.keys()].sort(), [1, 2]);
      // The cut's faces point into the hole (the cavity), e.g. its floor at y 1 faces up.
      const p = r.positions, idx = r.indices;
      let floorUp = 0;
      for (let t = 0; t < r.tags.length; t++) {
        if (r.tags[t] !== 2) continue;
        const [a, b, c] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
        if (p[a * 3 + 1] !== 1 || p[b * 3 + 1] !== 1 || p[c * 3 + 1] !== 1) continue;
        const ux = p[b * 3] - p[a * 3], uz = p[b * 3 + 2] - p[a * 3 + 2];
        const vx = p[c * 3] - p[a * 3], vz = p[c * 3 + 2] - p[a * 3 + 2];
        const ny = uz * vx - ux * vz;
        assert.ok(ny > 0, "the hole's floor faces up");
        floorUp++;
      }
      assert.ok(floorUp >= 2, "the hole's floor is there");
    });

    it("unions, intersects, translates, and re-tags a subtree", () => {
      const two = [
        { op: "box", min: [0, 0, 0], max: [2, 2, 2] },
        { op: "box", min: [1, 1, 1], max: [3, 3, 3] },
      ];
      assert.ok(close(geo.solid({ op: "union", of: two }).volume, 15));
      assert.ok(close(geo.solid({ op: "intersection", of: two }).volume, 1));
      const moved = geo.solid({ op: "translate", by: [10, 0, -5], of: two[0] });
      assert.deepEqual(bounds(moved.positions).min, [10, 0, -5]);
      const retagged = geo.solid({ op: "union", of: [{ ...two[0], tag: 3 }, { ...two[1], tag: 4 }], tag: 9 });
      assert.ok(retagged.tags.every((t) => t === 9));
    });

    it("is deterministic", () => {
      const tree = {
        op: "difference",
        of: [
          { op: "box", min: [0, 0, 0], max: [10, 5, 10], tag: 1 },
          { op: "extrude", polygons: geo.cellsToPolygons(Uint8Array.from([1, 1, 0, 1]), 2, 2, { cell: 3 }), y0: 1, height: 3, tag: 2 },
        ],
      };
      const a = geo.solid(tree), b = geo.solid(tree);
      assert.deepEqual(Buffer.from(a.positions.buffer), Buffer.from(b.positions.buffer));
      assert.deepEqual(Buffer.from(a.indices.buffer), Buffer.from(b.indices.buffer));
      assert.deepEqual(a.tags, b.tags);
    });

    it("refuses bad trees", () => {
      assert.throws(() => geo.solid({ op: "sphere" }), /unknown op `sphere`/);
      assert.throws(() => geo.solid({ op: "box", min: [0, 0, 0], max: [1, 0, 1] }), /empty/);
      assert.throws(() => geo.solid({ op: "box", min: [0, 0], max: [1, 1, 1] }), /\[x, y, z\]/);
      assert.throws(() => geo.solid({ op: "union", of: [] }), /non-empty/);
      assert.throws(() => geo.solid({ op: "extrude", polygons: poly(square(0, 0, 1)), height: 0 }), /positive/);
      assert.throws(() => geo.solid(null), /object/);
    });
  });
});
