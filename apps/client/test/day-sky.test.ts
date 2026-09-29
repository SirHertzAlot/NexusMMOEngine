/**
 * Time of day and the sky: the sun rises in the east, stands in the south
 * at noon and sets in the west; the light and haze follow it; at night the
 * direct light is a dim moon and the world stays readable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DaySky } from "../src/render/sky/day-sky.js";
import { evaluateTimeOfDay, sunDirection } from "../src/render/sky/time-of-day.js";

describe("evaluateTimeOfDay", () => {
  it("puts the sun east at dawn, high in the south at noon, west at dusk, below at midnight", () => {
    const dawn = sunDirection(evaluateTimeOfDay(0.28));
    const noon = sunDirection(evaluateTimeOfDay(0.5));
    const dusk = sunDirection(evaluateTimeOfDay(0.72));
    const midnight = sunDirection(evaluateTimeOfDay(0));
    assert.ok(dawn.x > 0.9 && dawn.y > 0, "dawn: east (+x), just above the horizon");
    assert.ok(noon.z > 0 && noon.y > 0.85, "noon: high, toward the south (+z)");
    assert.ok(dusk.x < -0.9 && dusk.y > 0, "dusk: west (-x)");
    assert.ok(midnight.y < 0, "midnight: below the horizon");
    for (const d of [dawn, noon, dusk, midnight]) assert.ok(Math.abs(d.length() - 1) < 1e-9);
  });

  it("interpolates between keyframes and wraps around the day", () => {
    const a = evaluateTimeOfDay(0.44);
    assert.ok(a.sunElevation > 30 && a.sunElevation < 65, "between morning and noon");
    assert.deepEqual(evaluateTimeOfDay(1.5), evaluateTimeOfDay(0.5));
    assert.deepEqual(evaluateTimeOfDay(-0.5), evaluateTimeOfDay(0.5));
  });
});

describe("DaySky", () => {
  it("lights the day from the sun and tints the haze", () => {
    const sky = new DaySky();
    const fog = new THREE.Fog(0xffffff, 1, 2);
    sky.update(0.5, fog);
    assert.ok(sky.sunLight.position.y > 0, "the sun shines from above");
    assert.ok(Math.abs(sky.sunLight.intensity - 1.6) < 1e-6, "noon matches the old fixed sunlight");
    assert.ok(Math.abs(sky.skyLight.intensity - 0.9) < 1e-6, "and the old sky light");
    assert.deepEqual(fog.color.toArray(), [0.55, 0.62, 0.75], "the haze takes the noon fog colour");
    sky.dispose();
  });

  it("at night the direct light is a dim moon from above, not the sun from below", () => {
    const sky = new DaySky();
    sky.update(0, null);
    assert.ok(sky.sunLight.position.y > 0, "moonlight comes from above");
    assert.ok(sky.sunLight.intensity > 0 && sky.sunLight.intensity < 0.5);
    assert.ok(sky.skyLight.intensity >= 0.3, "the world stays readable");
    sky.dispose();
  });
});
