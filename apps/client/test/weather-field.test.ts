/**
 * Weather field (roadmap WX1): the coarse runtime moisture/temperature
 * simulation — determinism, advection, orographic lift, the anti-drift
 * relaxation, the precipitation threshold, sampling, and the force() override.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WeatherField, type WeatherFieldParams } from "../src/render/weather/field.js";

/** Build params with a uniform climatology; override per test. */
function makeParams(overrides: Partial<WeatherFieldParams> = {}): WeatherFieldParams {
  const size = 32;
  const n = size * size;
  return {
    cell: 250,
    size,
    originX: 0,
    originZ: 0,
    windX: 1,
    windZ: 0,
    dryDistance: 20000,
    orographic: 0.001,
    recycling: 0.3,
    climatologyTemp: new Float32Array(n).fill(20),
    climatologyMoisture: new Float32Array(n).fill(0.3),
    ...overrides,
  };
}

function arraysEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("WeatherField", () => {
  it("is deterministic for the same seed and step count", () => {
    const params = makeParams();
    const a = new WeatherField(params, 12345);
    const b = new WeatherField(params, 12345);
    for (let i = 0; i < 50; i++) {
      a.step(1);
      b.step(1);
    }
    assert.ok(arraysEqual(a.field().moisture, b.field().moisture), "moisture fields differ");
    assert.ok(arraysEqual(a.field().temperature, b.field().temperature), "temperature fields differ");
  });

  it("advects moisture downwind", () => {
    const params = makeParams();
    const f = new WeatherField(params, 42);
    // Uniform background, then a blob upwind (west — the wind blows +X).
    const m = f.field().moisture;
    m.fill(0.3);
    for (let z = 0; z < 32; z++) for (let x = 4; x <= 8; x++) m[z * 32 + x] = 0.95;
    // 10 m/s * 30 s = 300 m = 1.2 cells/step; 10 steps ≈ 12 cells of travel.
    for (let i = 0; i < 10; i++) f.step(30);
    // Centroid of the excess-over-background must have moved downwind (+X).
    const after = f.field().moisture;
    let sumX = 0;
    let sumW = 0;
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 32; x++) {
        const w = after[z * 32 + x] - 0.3;
        if (w > 0) {
          sumX += x * w;
          sumW += w;
        }
      }
    }
    const centroidX = sumX / sumW;
    assert.ok(centroidX > 10, `blob should move downwind, centroid x = ${centroidX}`);
  });

  it("wrings more rain out on the windward side than the lee", () => {
    const size = 32;
    const n = size * size;
    // Warm (20 °C) upwind → cold (15 °C) downwind. Via the lapse rate, cold =
    // high, so the +X wind climbs toward the east and wrings moisture out.
    const climatologyTemp = new Float32Array(n);
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) climatologyTemp[z * size + x] = 20 - (5 * x) / (size - 1);
    }
    // Water upwind (west), dry land downwind — moist air flows off the water.
    const climatologyMoisture = new Float32Array(n);
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) climatologyMoisture[z * size + x] = x < 8 ? 0.9 : 0.2;
    }

    const run = (orographic: number): Float32Array => {
      const f = new WeatherField(makeParams({ climatologyTemp, climatologyMoisture, orographic }), 7);
      for (let i = 0; i < 30; i++) f.step(30);
      return f.field().moisture;
    };
    const withOro = run(0.002);
    const withoutOro = run(0);

    const regionMean = (m: Float32Array, x0: number, x1: number): number => {
      let s = 0;
      let c = 0;
      for (let z = 0; z < size; z++) for (let x = x0; x <= x1; x++) { s += m[z * size + x]; c++; }
      return s / c;
    };
    const windward = (m: Float32Array) => regionMean(m, 8, 14);
    const lee = (m: Float32Array) => regionMean(m, 22, 28);

    // The rain shadow exists with orographic lift on...
    assert.ok(
      windward(withOro) > lee(withOro),
      `windward (${windward(withOro).toFixed(3)}) should be wetter than lee (${lee(withOro).toFixed(3)})`,
    );
    // ...and the orographic term wrings out EXTRA rain on the windward side:
    // the extra moisture it removes (vs. the flat-land-only run) must be larger
    // where the air is climbing with a full load of moisture than on the dry lee.
    const extraWindward = windward(withoutOro) - windward(withOro);
    const extraLee = lee(withoutOro) - lee(withOro);
    assert.ok(
      extraWindward > extraLee,
      `orographic should wring more rain windward: ${extraWindward.toFixed(3)} vs lee ${extraLee.toFixed(3)}`,
    );
  });

  it("stays bounded over 10,000 steps (relaxation prevents drift)", () => {
    const f = new WeatherField(makeParams(), 99);
    // Perturb far from equilibrium: bone dry.
    f.field().moisture.fill(0);
    for (let i = 0; i < 10000; i++) f.step(1);
    const m = f.field().moisture;
    const t = f.field().temperature;
    let sum = 0;
    for (let i = 0; i < m.length; i++) {
      assert.ok(Number.isFinite(m[i]), `moisture[${i}] is not finite`);
      assert.ok(m[i] >= 0 && m[i] <= 1, `moisture[${i}] = ${m[i]} out of [0,1]`);
      assert.ok(Number.isFinite(t[i]), `temperature[${i}] is not finite`);
      sum += m[i];
    }
    const mean = sum / m.length;
    // Recovered toward the climatology (0.3), not saturated at 1.
    assert.ok(mean > 0.1 && mean < 0.9, `mean moisture ${mean.toFixed(3)} should stay bounded`);
  });

  it("reports rain/snow by temperature above the threshold, clear below", () => {
    const size = 8;
    const n = size * size;
    // Warm + wet → rain.
    const warm = new WeatherField(
      makeParams({ size, climatologyTemp: new Float32Array(n).fill(20), climatologyMoisture: new Float32Array(n).fill(0.9) }),
      1,
    );
    for (let i = 0; i < 20; i++) warm.step(10);
    const sWarm = warm.sample(0, 0);
    assert.equal(sWarm.kind, "rain");
    assert.ok(sWarm.intensity > 0);

    // Cold + wet → snow.
    const cold = new WeatherField(
      makeParams({ size, climatologyTemp: new Float32Array(n).fill(-10), climatologyMoisture: new Float32Array(n).fill(0.9) }),
      1,
    );
    for (let i = 0; i < 20; i++) cold.step(10);
    const sCold = cold.sample(0, 0);
    assert.equal(sCold.kind, "snow");
    assert.ok(sCold.intensity > 0);

    // Dry → clear.
    const dry = new WeatherField(
      makeParams({ size, climatologyTemp: new Float32Array(n).fill(20), climatologyMoisture: new Float32Array(n).fill(0.1) }),
      1,
    );
    for (let i = 0; i < 20; i++) dry.step(10);
    const sDry = dry.sample(0, 0);
    assert.equal(sDry.kind, "clear");
    assert.equal(sDry.intensity, 0);
  });

  it("samples the field at a known position", () => {
    const size = 8;
    const n = size * size;
    const params = makeParams({
      size,
      climatologyTemp: new Float32Array(n).fill(20),
      climatologyMoisture: new Float32Array(n).fill(0.9),
    });
    const f = new WeatherField(params, 5);
    for (let i = 0; i < 10; i++) f.step(10);
    // Cell (3, 2)'s centre is at origin + (3.5, 2.5) * cell.
    const s = f.sample(3.5 * params.cell, 2.5 * params.cell);
    assert.equal(s.kind, "rain");
    assert.ok(s.intensity > 0);
    assert.equal(s.windX, params.windX);
    assert.equal(s.windZ, params.windZ);
    // Out of bounds clamps to the edge cell (also wet here).
    const edge = f.sample(-1000, -1000);
    assert.equal(edge.kind, "rain");
  });

  it("force() overrides the sampled kind and intensity", () => {
    const params = makeParams();
    const f = new WeatherField(params, 3);
    // Natural state is clear (dry land, moisture 0.3 < threshold).
    assert.equal(f.sample(0, 0).kind, "clear");
    f.force("ash", 0.7);
    const s = f.sample(123, 456);
    assert.equal(s.kind, "ash");
    assert.equal(s.intensity, 0.7);
    assert.equal(s.windX, params.windX);
    assert.equal(s.windZ, params.windZ);
  });

  it("matches the stateless worker task step-for-step", async () => {
    const params = makeParams();
    const seed = 2024;
    const steps = 25;
    const dt = 2;
    // Main-thread path.
    const f = new WeatherField(params, seed);
    for (let i = 0; i < steps; i++) f.step(dt);
    // Worker path: same arrays in, same number of steps.
    const { weatherHandler } = await import("../src/workers/handlers/weather.js");
    const moisture = new Float32Array(params.climatologyMoisture);
    const temperature = new Float32Array(params.climatologyTemp);
    const result = await weatherHandler.handle({ moisture, temperature, params, seed, steps, dt });
    assert.ok(arraysEqual(result.moisture, f.field().moisture), "worker moisture differs from field");
    assert.ok(arraysEqual(result.temperature, f.field().temperature), "worker temperature differs from field");
    // The climatology arrays come back for the main thread's next call.
    assert.equal(result.climatologyTemp.length, params.climatologyTemp.length);
    assert.equal(result.climatologyMoisture.length, params.climatologyMoisture.length);
  });
});
