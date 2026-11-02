/**
 * Ground pick (roadmap E4): a view ray is walked to the terrain height field.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groundPoint } from "../src/render/ground-pick.js";

describe("groundPoint", () => {
  it("meets flat ground where the ray lands", () => {
    const p = groundPoint({ ox: 0, oy: 20, oz: 0, dx: 1, dy: -1, dz: 0 }, { heightAt: () => 10 }, 20);
    assert.ok(p);
    assert.ok(Math.abs(p.x - 10) < 1e-6, `x ${p.x}`);
    assert.ok(Math.abs(p.z) < 1e-6);
  });

  it("follows a slope to where the ray meets the surface", () => {
    // Ground y = 0.1 x; the ray is y = 50 - x, so they meet at x = 50 / 1.1.
    const p = groundPoint({ ox: 0, oy: 50, oz: 0, dx: 1, dy: -1, dz: 0 }, { heightAt: (x) => 0.1 * x }, 50);
    assert.ok(p);
    assert.ok(Math.abs(p.x - 50 / 1.1) < 0.1, `x ${p.x}`);
  });

  it("refuses a ray that points at the sky, or ground that is not streamed", () => {
    assert.equal(groundPoint({ ox: 0, oy: 5, oz: 0, dx: 0, dy: 1, dz: 0 }, { heightAt: () => 0 }, 5), null);
    assert.equal(groundPoint({ ox: 0, oy: 20, oz: 0, dx: 1, dy: -1, dz: 0 }, { heightAt: () => null }, 20), null);
  });
});
