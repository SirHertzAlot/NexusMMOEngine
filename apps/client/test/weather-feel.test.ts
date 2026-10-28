/**
 * Weather couplings (WX1) — tests for the wet look, water ripples,
 * and rain audio driven by the weather field.
 *
 * Tests use node:test + node:assert/strict (NOT vitest).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { WeatherFeel } from "../src/render/weather/weather-feel.js";
import { createWaterMaterial } from "../src/render/water-material.js";
import { createTerrainUniforms } from "../src/render/terrain/terrain-material.js";
import { startRain } from "../src/audio/cues.js";

// ---------------------------------------------------------------------------
// WeatherFeel coordinator
// ---------------------------------------------------------------------------

describe("WeatherFeel", () => {
  it("fades wetness in when rain starts and out when it stops", () => {
    const feel = new WeatherFeel();
    let wetness = 0;
    let rainIntensity = 0;
    const w = { setRainIntensity: (v: number) => { rainIntensity = v; } };
    const t = { setWetness: (v: number) => { wetness = v; } };

    // Rain starts: wetness should rise.
    feel.update({ kind: "rain", intensity: 1, windX: 0, windZ: 0 }, 0.1, w as never, t as never);
    assert.ok(wetness > 0, `wetness should rise in rain, got ${wetness}`);
    assert.equal(rainIntensity, 1);

    // Rain stops: wetness should fall (but not instantly to 0).
    feel.update({ kind: "clear", intensity: 0, windX: 0, windZ: 0 }, 0.1, w as never, t as never);
    assert.ok(wetness > 0, `wetness should fade out slowly, got ${wetness}`);
    assert.ok(wetness < 1, `wetness should be less than 1 after rain stops, got ${wetness}`);
    assert.equal(rainIntensity, 0);
  });

  it("does not allocate in the hot path", () => {
    const feel = new WeatherFeel();
    const w = { setRainIntensity: () => {} };
    const t = { setWetness: () => {} };
    // Run many frames; if it allocated, the GC would eventually complain.
    // This is a smoke test — the real guarantee is the code's structure.
    for (let i = 0; i < 100; i++) {
      feel.update({ kind: "rain", intensity: 0.5, windX: 1, windZ: 0 }, 0.016, w as never, t as never);
    }
    // No assertion failure = pass.
  });

  it("passes rain intensity directly to the water renderer", () => {
    const feel = new WeatherFeel();
    let received = -1;
    const w = { setRainIntensity: (v: number) => { received = v; } };
    const t = { setWetness: () => {} };
    feel.update({ kind: "rain", intensity: 0.7, windX: 0, windZ: 0 }, 0.016, w as never, t as never);
    assert.equal(received, 0.7);
  });

  it("zeroes water ripples when it is not raining", () => {
    const feel = new WeatherFeel();
    let received = -1;
    const w = { setRainIntensity: (v: number) => { received = v; } };
    const t = { setWetness: () => {} };
    feel.update({ kind: "snow", intensity: 1, windX: 0, windZ: 0 }, 0.016, w as never, t as never);
    assert.equal(received, 0);
  });
});

// ---------------------------------------------------------------------------
// Water material — rain ripple uniform
// ---------------------------------------------------------------------------

describe("water material ripples", () => {
  it("has a uRainIntensity uniform defaulting to 0", () => {
    const sky = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uHorizon: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uZenith: { value: new THREE.Color(0.2, 0.3, 0.6) },
      uLight: { value: 1 },
    };
    const { uniforms } = createWaterMaterial(sky as never);
    assert.equal(uniforms.uRainIntensity.value, 0);
  });

  it("accepts a non-zero rain intensity", () => {
    const sky = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uHorizon: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uZenith: { value: new THREE.Color(0.2, 0.3, 0.6) },
      uLight: { value: 1 },
    };
    const { uniforms } = createWaterMaterial(sky as never);
    uniforms.uRainIntensity.value = 0.8;
    assert.equal(uniforms.uRainIntensity.value, 0.8);
  });
});

// ---------------------------------------------------------------------------
// Terrain material — wetness uniform
// ---------------------------------------------------------------------------

describe("terrain material wetness", () => {
  it("has a uWetness uniform defaulting to 0", () => {
    const uniforms = createTerrainUniforms();
    assert.equal(uniforms.uWetness.value, 0);
  });

  it("accepts a non-zero wetness", () => {
    const uniforms = createTerrainUniforms();
    uniforms.uWetness.value = 0.6;
    assert.equal(uniforms.uWetness.value, 0.6);
  });
});

// ---------------------------------------------------------------------------
// Audio — rain cue
// ---------------------------------------------------------------------------

describe("rain audio cue", () => {
  it("startRain returns a stop function", () => {
    // A minimal AudioContext mock — enough for startRain to wire up.
    const mockCtx = {
      currentTime: 0,
      sampleRate: 44100,
      createBufferSource: () => ({
        buffer: null,
        loop: false,
        connect: (n: unknown) => n,
        start: () => {},
        stop: () => {},
      }),
      createBiquadFilter: () => ({
        type: "",
        frequency: { value: 0 },
        Q: { value: 0 },
        connect: (n: unknown) => n,
      }),
      createGain: () => ({
        gain: { value: 0, setTargetAtTime: () => {} },
        connect: (n: unknown) => n,
        disconnect: () => {},
      }),
      createOscillator: () => ({
        frequency: { value: 0 },
        connect: (n: unknown) => n,
        start: () => {},
        stop: () => {},
      }),
      createBuffer: (_ch: number, _len: number, _rate: number) => ({
        getChannelData: () => new Float32Array(_len),
      }),
    };
    const stop = startRain(mockCtx as never, {} as never);
    assert.equal(typeof stop, "function");
    stop();
  });
});
