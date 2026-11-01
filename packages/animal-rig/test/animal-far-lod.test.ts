/**
 * Animal far LOD (WL2): the switch to the instanced stand-in has hysteresis, so an animal on the
 * boundary does not flip between its posed mesh and the batch every frame.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANIMAL_LOD_RADIUS } from "../src/animal-rig.js";
import { ANIMAL_FAR_HYSTERESIS, animalIsFar } from "../src/far-lod.js";

describe("animal far LOD", () => {
  it("a near animal turns far only past the radius plus the band", () => {
    assert.equal(animalIsFar(false, ANIMAL_LOD_RADIUS), false);
    assert.equal(animalIsFar(false, ANIMAL_LOD_RADIUS + ANIMAL_FAR_HYSTERESIS), false);
    assert.equal(animalIsFar(false, ANIMAL_LOD_RADIUS + ANIMAL_FAR_HYSTERESIS + 0.01), true);
  });

  it("a far animal comes back only inside the radius minus the band", () => {
    assert.equal(animalIsFar(true, ANIMAL_LOD_RADIUS), true);
    assert.equal(animalIsFar(true, ANIMAL_LOD_RADIUS - ANIMAL_FAR_HYSTERESIS), true);
    assert.equal(animalIsFar(true, ANIMAL_LOD_RADIUS - ANIMAL_FAR_HYSTERESIS - 0.01), false);
  });

  it("an animal on the boundary keeps whichever state it had (no flicker)", () => {
    const boundary = ANIMAL_LOD_RADIUS;
    let far = false;
    for (let i = 0; i < 10; i++) far = animalIsFar(far, boundary);
    assert.equal(far, false);
    far = true;
    for (let i = 0; i < 10; i++) far = animalIsFar(far, boundary);
    assert.equal(far, true);
  });

  it("a walk away and back crosses the band once each way", () => {
    let far = false;
    const path = [10, 30, 44, 46, 48, 52, 50, 44, 42, 40];
    const states = path.map((d) => (far = animalIsFar(far, d)));
    assert.deepEqual(states, [false, false, false, false, false, true, true, true, true, false]);
  });
});
