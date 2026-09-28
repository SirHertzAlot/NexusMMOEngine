/**
 * Interpolator: tick interpolation math.
 *
 * The mirror renders at rAF between 30 Hz authoritative ticks:
 * alpha 0 = previous tick, alpha 1 = current tick, clamped to [0, 1].
 * Rotation uses normalized lerp (nlerp); single-tick entities and
 * unknown ids never extrapolate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Interpolator } from "../src/interpolate.js";
import { transformRow } from "./fixtures.js";

const E = 0x2001n;

function pushAt(i: Interpolator, tick: number, px: number): void {
  i.push(tick, [transformRow(E, px)]);
}

describe("Interpolator.sample", () => {
  it("interpolates position linearly between ticks", () => {
    const i = new Interpolator();
    pushAt(i, 1, 0);
    pushAt(i, 2, 10);

    assert.equal(i.sample(E, 0)?.px, 0);
    assert.equal(i.sample(E, 0.5)?.px, 5);
    assert.equal(i.sample(E, 1)?.px, 10);
  });

  it("clamps alpha to [0, 1] (no extrapolation past the authority)", () => {
    const i = new Interpolator();
    pushAt(i, 1, 0);
    pushAt(i, 2, 10);

    assert.equal(i.sample(E, -0.5)?.px, 0);
    assert.equal(i.sample(E, 2)?.px, 10);
  });

  it("samples the latest row for entities seen in a single tick", () => {
    const i = new Interpolator();
    pushAt(i, 5, 42);

    assert.equal(i.sample(E, 0)?.px, 42);
    assert.equal(i.sample(E, 0.7)?.px, 42);
    assert.equal(i.sample(E, 1)?.px, 42);
  });

  it("returns undefined for unknown entities", () => {
    const i = new Interpolator();
    assert.equal(i.sample(0x9999n, 0.5), undefined);
  });

  it("nlerp keeps quaternions normalized", () => {
    const i = new Interpolator();
    const a = transformRow(E, 0);
    const b = transformRow(E, 0);
    // 90 degrees around Y: (0, sin45, 0, cos45)
    b.qy = Math.SQRT1_2;
    b.qw = Math.SQRT1_2;
    i.push(1, [a]);
    i.push(2, [b]);

    const mid = i.sample(E, 0.5)!;
    const len = Math.hypot(mid.qx, mid.qy, mid.qz, mid.qw);
    assert.ok(Math.abs(len - 1) < 1e-9, `quaternion not unit: ${len}`);
    assert.ok(mid.qy > 0 && mid.qy < Math.SQRT1_2);
    assert.equal(i.sample(E, 0)?.qw, 1);
  });

  it("remove() drops interpolation history", () => {
    const i = new Interpolator();
    pushAt(i, 1, 0);
    pushAt(i, 2, 10);
    i.remove(E);
    assert.equal(i.sample(E, 0.5), undefined);
  });

  it("clear() resets all history (fresh snapshot / reconnect)", () => {
    const i = new Interpolator();
    pushAt(i, 1, 0);
    pushAt(i, 2, 10);
    i.clear();
    assert.equal(i.sample(E, 0.5), undefined);
  });
});
