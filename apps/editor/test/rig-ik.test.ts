/** The pure IK solvers: two-bone (reach, clamp, pole, joint limits) and FABRIK (convergence, bone lengths, bend limit). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fabrik, newTwoBone, twoBoneIK, type Vec3 } from "../src/rig-ik.js";

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const finite = (r: { mid: Vec3; end: Vec3 }): void => {
  for (const c of [r.mid.x, r.mid.y, r.mid.z, r.end.x, r.end.y, r.end.z]) assert.ok(Number.isFinite(c));
};

describe("twoBoneIK", () => {
  it("reaches a target within range and keeps both bone lengths", () => {
    const r = twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, 0.2, 0.3), v(0, 0, 1), 0, Math.PI, newTwoBone());
    assert.equal(r.reached, true);
    near(dist(r.end, v(0, 0.2, 0.3)), 0, 1e-9);
    near(dist(v(0, 1, 0), r.mid), 0.5);
    near(dist(r.mid, r.end), 0.5);
  });
  it("clamps an unreachable target to a straight, fully extended limb pointing at it", () => {
    const r = twoBoneIK(v(0, 1, 0), 0.5, 0.4, v(0, -5, 0), v(0, 0, 1), 0, Math.PI, newTwoBone());
    assert.equal(r.reached, false);
    near(r.end.y, 1 - 0.9, 1e-6);
    near(dist(v(0, 1, 0), r.mid), 0.5);
    near(dist(r.mid, r.end), 0.4);
  });
  it("the pole decides which way the knee points, and only that way", () => {
    const fwd = twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, 0.3, 0), v(0, 0, 1), 0, Math.PI, newTwoBone());
    assert.ok(fwd.mid.z > 0.1);
    near(fwd.mid.x, 0);
    const back = twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, 0.3, 0), v(0, 0, -1), 0, Math.PI, newTwoBone());
    assert.ok(back.mid.z < -0.1);
  });
  it("a pole along the limb axis still gives a finite answer", () => {
    const r = twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, 0.3, 0), v(0, 1, 0), 0, Math.PI, newTwoBone());
    finite(r);
    near(dist(v(0, 1, 0), r.mid), 0.5);
  });
  it("joint limits: the interior angle never leaves [min, max]", () => {
    const min = (40 * Math.PI) / 180;
    const max = (150 * Math.PI) / 180;
    // Target so close the knee would fold to ~0 degrees: stopped at min.
    const tight = twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, 0.99, 0.01), v(0, 0, 1), min, max, newTwoBone());
    assert.equal(tight.reached, false);
    near(tight.interior, min, 1e-6);
    // Target at full stretch: stopped at max (the leg never locks straight).
    const far = twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, -3, 0), v(0, 0, 1), min, max, newTwoBone());
    near(far.interior, max, 1e-6);
    near(dist(v(0, 1, 0), far.mid), 0.5);
    near(dist(far.mid, far.end), 0.5);
    // In between: untouched.
    const ok = twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, 0.3, 0), v(0, 0, 1), min, max, newTwoBone());
    assert.equal(ok.reached, true);
  });
  it("a target on the root does not produce NaN", () => {
    finite(twoBoneIK(v(0, 1, 0), 0.5, 0.5, v(0, 1, 0), v(0, 0, 1), 0, Math.PI, newTwoBone()));
  });
  it("unequal bones: the knee sits where the circles meet", () => {
    const r = twoBoneIK(v(0, 0, 0), 0.7, 0.3, v(0.6, 0, 0), v(0, 1, 0), 0, Math.PI, newTwoBone());
    near(dist(v(0, 0, 0), r.mid), 0.7);
    near(dist(r.mid, v(0.6, 0, 0)), 0.3);
    assert.ok(r.mid.y > 0);
  });
});

const chain = (n: number, len: number): { pts: Float64Array; lens: Float64Array } => {
  const pts = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) pts[i * 3 + 1] = -i * len; // hanging down from the root
  return { pts, lens: new Float64Array(n - 1).fill(len) };
};
const segLen = (p: Float64Array, i: number): number => Math.hypot(p[i * 3 + 3] - p[i * 3], p[i * 3 + 4] - p[i * 3 + 1], p[i * 3 + 5] - p[i * 3 + 2]);

describe("fabrik", () => {
  it("converges on a reachable target with the root pinned and every length kept", () => {
    const { pts, lens } = chain(6, 0.2);
    const r = fabrik(pts, lens, v(0.4, -0.5, 0.2), { iterations: 32, tolerance: 1e-4 });
    assert.equal(r.reached, true);
    assert.ok(r.error < 1e-3);
    near(pts[0], 0);
    near(pts[1], 0);
    near(pts[2], 0);
    for (let i = 0; i < 5; i++) near(segLen(pts, i), 0.2, 1e-9);
  });
  it("an unreachable target gives a straight chain pointing at it", () => {
    const { pts, lens } = chain(4, 0.25);
    const r = fabrik(pts, lens, v(0, 0, 5), { iterations: 16, tolerance: 1e-4 });
    assert.equal(r.reached, false);
    near(pts[9], 0, 1e-9);
    near(pts[10], 0, 1e-9);
    near(pts[11], 0.75, 1e-9);
    for (let i = 0; i < 3; i++) near(segLen(pts, i), 0.25, 1e-9);
  });
  it("a bend limit holds at every joint while lengths stay exact", () => {
    const { pts, lens } = chain(7, 0.2);
    const max = (25 * Math.PI) / 180;
    fabrik(pts, lens, v(0.9, -0.1, 0.4), { iterations: 24, tolerance: 1e-4, maxBend: max });
    for (let i = 1; i < 6; i++) {
      const a = [pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]];
      const b = [pts[i * 3 + 3] - pts[i * 3], pts[i * 3 + 4] - pts[i * 3 + 1], pts[i * 3 + 5] - pts[i * 3 + 2]];
      const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
      assert.ok(Math.acos(Math.min(1, c)) <= max + 1e-6, `joint ${i} bends ${Math.acos(c)}`);
    }
    for (let i = 0; i < 6; i++) near(segLen(pts, i), 0.2, 1e-9);
  });
  it("a target on the root and a two-point chain stay finite", () => {
    const { pts, lens } = chain(2, 0.3);
    fabrik(pts, lens, v(0, 0, 0), { iterations: 8, tolerance: 1e-4 });
    for (const c of pts) assert.ok(Number.isFinite(c));
    near(segLen(pts, 0), 0.3, 1e-9);
  });
});
