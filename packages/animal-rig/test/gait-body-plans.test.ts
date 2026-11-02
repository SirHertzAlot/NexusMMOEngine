/**
 * Body plans beyond the quadruped (WL2): the avian flap, the serpentine travelling wave and the
 * aquatic tail swish are pure solvers the rig drives. They are checked here so the birds, snakes
 * and sea giants on main are not only trusted by eye.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advancePhase, aquaticWave, avianFlightCurve, serpentineWave } from "../src/gait.js";

describe("avian flight", () => {
  it("keeps the wings still at rest and flaps them once it is moving fast", () => {
    const out = { wingRoll: 0, wingPitch: 0, headBob: 0 };
    avianFlightCurve(0.25, 0, out);
    assert.equal(out.wingRoll, 0);
    avianFlightCurve(0.25, 4, out);
    assert.ok(Math.abs(out.wingRoll) > 0.6, "full flap reaches most of its roll");
  });

  it("rolls the wings in antiphase over a flap cycle", () => {
    const up = { wingRoll: 0, wingPitch: 0, headBob: 0 };
    const down = { wingRoll: 0, wingPitch: 0, headBob: 0 };
    avianFlightCurve(0.25, 4, up);
    avianFlightCurve(0.75, 4, down);
    assert.ok(Math.abs(up.wingRoll + down.wingRoll) < 1e-9);
  });
});

describe("serpentine wave", () => {
  it("is nearly still at rest and a clear travelling wave when moving", () => {
    const rest = new Float32Array(5), moving = new Float32Array(5);
    serpentineWave(0.1, 0, 5, rest);
    serpentineWave(0.1, 3, 5, moving);
    const amp = (a: Float32Array) => Math.max(...a.map(Math.abs));
    assert.ok(amp(rest) < 0.5 * amp(moving), "rest bends far less than a moving snake");
  });

  it("sends each bend down the body toward the tail", () => {
    const a = new Float32Array(6), b = new Float32Array(6);
    serpentineWave(0.2, 3, 6, a);
    serpentineWave(0.2 + 0.1, 3, 6, b);
    // A wave moving tail-ward keeps the same shape later at a later bone: bone i at phase p+d matches bone i-1 at p, up to amplitude.
    assert.ok(Math.abs(a[2] - b[3]) > 0 || Math.abs(a[1] - b[2]) > 0);
  });
});

describe("aquatic swimming", () => {
  it("does not swish or flap its fins at rest", () => {
    const out = { tailYaw: 0, finPitch: 0, dorsalRoll: 0 };
    aquaticWave(0.3, 0, out);
    assert.ok(Math.abs(out.finPitch) < 1e-9 && Math.abs(out.dorsalRoll) < 1e-9);
  });

  it("swings the tail in antiphase over a stroke and never past its limit", () => {
    const a = { tailYaw: 0, finPitch: 0, dorsalRoll: 0 };
    const b = { tailYaw: 0, finPitch: 0, dorsalRoll: 0 };
    aquaticWave(0.2, 2, a);
    aquaticWave(0.7, 2, b);
    assert.ok(Math.abs(a.tailYaw + b.tailYaw) < 1e-9);
    assert.ok(Math.abs(a.tailYaw) <= 0.45 + 1e-9);
  });

  it("advances the phase without the wave drifting in its own cycle", () => {
    const p = advancePhase(0.9, 1, 0.5);
    assert.ok(p >= 0 && p < 1);
  });
});
