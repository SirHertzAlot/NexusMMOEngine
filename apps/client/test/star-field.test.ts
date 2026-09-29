/**
 * The night sky: seeded (every player sees the same stars), concentrated
 * in the Milky Way bands, turning once a day about the pole, and shown
 * only when the sun is down.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildStars, DEFAULT_STAR_FIELD, skyRotation, StarField, starVisibility } from "../src/render/sky/star-field.js";
import { DaySky } from "../src/render/sky/day-sky.js";

const small = { ...DEFAULT_STAR_FIELD, bandCount: 3000, fieldCount: 1000 };

describe("buildStars", () => {
  it("gives the same sky for the same seed and a different one for another", () => {
    const a = buildStars(small);
    const b = buildStars(small);
    const c = buildStars({ ...small, seed: 7 });
    assert.equal(a.count, 7000);
    assert.deepEqual(a.directions, b.directions);
    assert.deepEqual(a.colors, b.colors);
    assert.notDeepEqual(a.directions, c.directions);
  });

  it("puts unit directions, bounded sizes, and most band stars near the galactic plane", () => {
    const s = buildStars(small);
    for (let i = 0; i < s.count; i++) {
      const len = Math.hypot(s.directions[i * 3], s.directions[i * 3 + 1], s.directions[i * 3 + 2]);
      assert.ok(Math.abs(len - 1) < 1e-5);
      assert.ok(s.sizes[i] > 0 && s.sizes[i] <= DEFAULT_STAR_FIELD.maxPixels);
    }
    // Undo the galactic tilt: the band's latitude should be small.
    const untilt = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.43, 0, -0.47)).invert();
    const v = new THREE.Vector3();
    let near = 0;
    for (let i = 0; i < small.bandCount; i++) {
      v.fromArray(s.directions, i * 3).applyMatrix4(untilt);
      if (Math.abs(Math.asin(v.y)) < 0.2) near++;
    }
    assert.ok(near / small.bandCount > 0.9, `band stars near the plane: ${near}/${small.bandCount}`);
  });
});

describe("the sky's turn and visibility", () => {
  it("keeps the pole still and turns once a day", () => {
    const pole = new THREE.Vector3(0, Math.sin((40 * Math.PI) / 180), -Math.cos((40 * Math.PI) / 180));
    const moved = pole.clone().applyMatrix3(skyRotation(0.37));
    assert.ok(moved.distanceTo(pole) < 1e-9, "the pole doesn't move");
    const east = new THREE.Vector3(1, 0, 0);
    assert.ok(east.clone().applyMatrix3(skyRotation(0.25)).distanceTo(east) > 0.5, "a quarter day turns the sky");
    assert.ok(east.clone().applyMatrix3(skyRotation(1)).distanceTo(east) < 1e-9, "a whole day comes round");
  });

  it("hides the stars by day and shows them at night", () => {
    assert.equal(starVisibility(0.9), 0);
    assert.equal(starVisibility(-0.5), 1);
    const sky = new DaySky();
    sky.update(0.5, null);
    assert.equal(sky.stars.mesh.visible, false, "noon: no stars");
    sky.update(0, null);
    assert.equal(sky.stars.mesh.visible, true, "midnight: stars");
    assert.ok(sky.stars.uniforms.uNight.value > 0.99);
    sky.dispose();
  });

  it("takes the frame size and clock for its point size and twinkle", () => {
    const stars = new StarField(small);
    stars.setFrame(800, 600, 2, 12.5);
    assert.deepEqual(stars.uniforms.uResolution.value.toArray(), [1600, 1200]);
    assert.equal(stars.uniforms.uTime.value, 12.5);
    stars.dispose();
  });
});
