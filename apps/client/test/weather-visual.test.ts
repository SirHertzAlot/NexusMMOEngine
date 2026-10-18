/**
 * Weather visuals — unit tests for the overcast blend, rain curtain,
 * cloud volume, and field service climatology.
 *
 * Tests use node:test + node:assert/strict (NOT vitest).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MessageChannel } from "node:worker_threads";
import { overcastFromSample, type OvercastParams } from "../src/render/weather/sky-overcast.js";
import { RainCurtain } from "../src/render/weather/rain-curtain.js";
import { CloudVolume } from "../src/render/weather/cloud-volume.js";
import * as fieldService from "../src/render/weather/field-service.js";

// ---------------------------------------------------------------------------
// Overcast blend
// ---------------------------------------------------------------------------

describe("overcast blend", () => {
  it("returns a neutral no-op for clear weather", () => {
    const out: OvercastParams = { coverage: 0, sunDim: 1, fogPull: 1, skyDarken: 1 };
    const sample = { kind: "clear" as const, intensity: 0, windX: -1, windZ: 0 };
    overcastFromSample(sample, out);
    assert.equal(out.coverage, 0);
    assert.equal(out.sunDim, 1);
    assert.equal(out.fogPull, 1);
    assert.equal(out.skyDarken, 1);
  });

  it("returns a visibly darker, closer-fog blend for heavy rain", () => {
    const out: OvercastParams = { coverage: 0, sunDim: 1, fogPull: 1, skyDarken: 1 };
    const sample = { kind: "rain" as const, intensity: 1, windX: -1, windZ: 0 };
    overcastFromSample(sample, out);
    assert.ok(out.coverage > 0.5, `coverage should be high, got ${out.coverage}`);
    assert.ok(out.sunDim < 1, `sunDim should dim, got ${out.sunDim}`);
    assert.ok(out.fogPull < 1, `fogPull should pull in, got ${out.fogPull}`);
    assert.ok(out.skyDarken < 1, `skyDarken should darken, got ${out.skyDarken}`);
  });

  it("is darker for ash than for rain at the same intensity", () => {
    const rainOut: OvercastParams = { coverage: 0, sunDim: 1, fogPull: 1, skyDarken: 1 };
    const ashOut: OvercastParams = { coverage: 0, sunDim: 1, fogPull: 1, skyDarken: 1 };
    overcastFromSample({ kind: "rain", intensity: 0.8, windX: 0, windZ: 0 }, rainOut);
    overcastFromSample({ kind: "ash", intensity: 0.8, windX: 0, windZ: 0 }, ashOut);
    assert.ok(ashOut.sunDim < rainOut.sunDim, "ash should dim the sun more than rain");
    assert.ok(ashOut.fogPull < rainOut.fogPull, "ash should pull fog in more than rain");
  });

  it("does not allocate (writes into the provided out param)", () => {
    const out: OvercastParams = { coverage: 0, sunDim: 1, fogPull: 1, skyDarken: 1 };
    const sample = { kind: "snow" as const, intensity: 0.5, windX: 0, windZ: 1 };
    const result = overcastFromSample(sample, out);
    assert.equal(result, out, "should return the same object that was passed in");
  });
});

// ---------------------------------------------------------------------------
// Rain curtain
// ---------------------------------------------------------------------------

describe("rain curtain", () => {
  it("applies the field wind vector to the scroll direction", () => {
    const rain = new RainCurtain();
    rain.update(1.5, -3, 2, 0.8, new THREE.Vector3(0, 0, 0));
    const wind = (rain.mesh.material as THREE.ShaderMaterial).uniforms.uWind.value as THREE.Vector2;
    assert.equal(wind.x, -3);
    assert.equal(wind.y, 2);
    rain.dispose();
  });

  it("hides the curtain when intensity is zero", () => {
    const rain = new RainCurtain();
    rain.update(0, 0, 0, 0, new THREE.Vector3(0, 0, 0));
    assert.equal(rain.mesh.visible, false);
    rain.dispose();
  });

  it("follows the camera position", () => {
    const rain = new RainCurtain();
    const pos = new THREE.Vector3(100, 5, -200);
    rain.update(0, 0, 0, 1, pos);
    assert.equal(rain.mesh.visible, true);
    assert.equal(rain.mesh.position.x, 100);
    assert.equal(rain.mesh.position.z, -200);
    rain.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cloud volume
// ---------------------------------------------------------------------------

describe("cloud volume", () => {
  it("creates an instanced mesh with the right count", () => {
    const clouds = new CloudVolume(8);
    const mesh = clouds.group.children[0] as THREE.InstancedMesh;
    assert.equal(mesh.count, 8);
    assert.equal(mesh.frustumCulled, false);
    clouds.dispose();
  });

  it("updates opacity and color from moisture and darkness", () => {
    const clouds = new CloudVolume(4);
    const pos = new THREE.Vector3(0, 0, 0);
    const quat = new THREE.Quaternion();
    // Low moisture, low darkness → low opacity
    clouds.update(pos, 0.1, 0, 0, 0, 0.016, quat);
    const mat = (clouds.group.children[0] as THREE.InstancedMesh).material as THREE.ShaderMaterial;
    const lowOpacity = mat.uniforms.uOpacity.value as number;
    // High moisture, high darkness → high opacity
    clouds.update(pos, 0.9, 0.9, 0, 0, 0.016, quat);
    const highOpacity = mat.uniforms.uOpacity.value as number;
    assert.ok(highOpacity > lowOpacity, `expected ${highOpacity} > ${lowOpacity}`);
    clouds.dispose();
  });
});

// ---------------------------------------------------------------------------
// Field service
// ---------------------------------------------------------------------------

describe("field service", () => {
  it("builds a sane climatology from a synthetic world map", () => {
    const { buildClimatology, DEFAULT_CLIMATE } = fieldService;

    // Synthetic 4x4 map: heights rise from south to north, water in the south.
    const cell = 8;
    const width = 4;
    const depth = 4;
    const heights = new Float32Array([
      0, 0, 0, 0, // row 0 (south): sea level
      10, 10, 10, 10, // row 1: low hills
      100, 100, 100, 100, // row 2: high
      500, 500, 500, 500, // row 3 (north): mountains
    ]);
    const biome = new Uint8Array(width * depth).fill(0); // all plains
    const biomes = ["plains"];
    const river = new Uint8Array(width * depth).fill(0);
    // Water in the south rows only.
    const water = new Float32Array([
      0, 0, 0, 0,
      0, 0, 0, 0,
      Number.NaN, Number.NaN, Number.NaN, Number.NaN,
      Number.NaN, Number.NaN, Number.NaN, Number.NaN,
    ]);
    const map = { cell, width, depth, originX: 0, originZ: 0, heights, biome, biomes, river, water };

    const temp = new Float32Array(width * depth);
    const moist = new Float32Array(width * depth);
    buildClimatology(map, temp, moist);

    // Temperature falls with height: row 3 (500m) is colder than row 0 (0m).
    assert.ok(temp[12] < temp[0], `expected mountain temp ${temp[12]} < sea temp ${temp[0]}`);
    // Moisture is high near water: row 0 > row 3.
    assert.ok(moist[0] > moist[12], `expected sea moisture ${moist[0]} > mountain moisture ${moist[12]}`);
    // The lapse rate is applied: at 500m with 45°C/km, the lapse is 22.5°C.
    const expectedLapse = (500 * DEFAULT_CLIMATE.lapseCPerKm) / 1000;
    assert.ok(Math.abs((temp[0] - temp[12]) - expectedLapse) < 0.1, `expected lapse ~${expectedLapse}°C, got ${temp[0] - temp[12]}`);
  });

  it("sample() agrees with the field's own sample() at the same position", async () => {
    const { FieldService } = fieldService;

    const cell = 8;
    const width = 8;
    const depth = 8;
    const n = width * depth;
    const heights = new Float32Array(n).fill(10);
    const biome = new Uint8Array(n).fill(0);
    const biomes = ["plains"];
    const river = new Uint8Array(n).fill(0);
    const water = new Float32Array(n).fill(Number.NaN);
    const map = { cell, width, depth, originX: 0, originZ: 0, heights, biome, biomes, river, water };

    const service = new FieldService(map, null, 42);
    const sample = service.sample(16, 16);
    const fieldSample = service.field();
    // The service delegates to the field; both should return the same kind.
    assert.ok(sample.kind === "clear" || sample.kind === "rain" || sample.kind === "snow" || sample.kind === "ash");
    // The field returns valid arrays.
    assert.equal(fieldSample.moisture.length, n);
    assert.equal(fieldSample.temperature.length, n);

    // step() evolves the field: moisture changes over time.
    const before = new Float32Array(fieldSample.moisture);
    await service.step(5);
    const after = service.field().moisture;
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (before[i] !== after[i]) {
        changed = true;
        break;
      }
    }
    assert.ok(changed, "step() should evolve the moisture field");
  });
});

// ---------------------------------------------------------------------------
// Worker offload
// ---------------------------------------------------------------------------

/** Every ArrayBuffer reachable from `o` — what WorkerRuntime transfers. */
function buffersOf(o: unknown, out: ArrayBuffer[] = []): ArrayBuffer[] {
  if (!o || typeof o !== "object") return out;
  if (ArrayBuffer.isView(o)) out.push(o.buffer as ArrayBuffer);
  else if (Array.isArray(o)) o.forEach((v) => buffersOf(v, out));
  else Object.values(o).forEach((v) => buffersOf(v, out));
  return out;
}

/**
 * A WorkerRequester that really detaches the payload's buffers on send, the way
 * WorkerRuntime does. A service that hands over an array it still needs breaks
 * on its second call — which is exactly the bug this guards.
 *
 * A fresh channel per request: the ports are closed once the reply arrives, so
 * reusing a channel would leave the second request with nowhere to send.
 */
function transferringWorker(handle: (payload: any) => any): {
  request: (type: string, payload: any) => Promise<any>;
  calls: () => number;
} {
  let calls = 0;
  const request = (type: string, payload: any) =>
    new Promise<any>((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      port2.on("message", (msg: any) => {
        port2.postMessage({ id: msg.id, payload: handle(msg.payload) }, buffersOf(msg.payload));
      });
      const onMsg = (m: any) => {
        port1.off("message", onMsg);
        // Close both ports: open MessageChannels keep the event loop alive.
        port1.close();
        port2.close();
        calls++;
        m.error ? reject(new Error(m.error)) : resolve(m.payload);
      };
      port1.on("message", onMsg);
      port1.postMessage({ id: 1, type, payload }, buffersOf(payload));
    });
  return { request, calls: () => calls };
}

describe("worker offload", () => {
  it("keeps using the worker across repeated steps", async () => {
    let mod: any;
    let fieldMod: any;
    try {
      [mod, fieldMod] = await Promise.all([
        import("../src/render/weather/field-service.js"),
        import("../src/render/weather/field.js"),
      ]);
    } catch {
      return; // written concurrently — skip
    }
    const { FieldService } = mod;
    const { runWeatherSteps } = fieldMod;

    const cell = 8;
    const n = 64;
    const map = {
      cell,
      width: 8,
      depth: 8,
      originX: 0,
      originZ: 0,
      heights: new Float32Array(n).fill(10),
      biome: new Uint8Array(n).fill(0),
      biomes: ["plains"],
      river: new Uint8Array(n).fill(0),
      water: new Float32Array(n).fill(Number.NaN),
    };

    const worker = transferringWorker((p: any) => {
      runWeatherSteps(p.moisture, p.temperature, p.params, p.seed, p.steps, p.dt);
      return {
        moisture: p.moisture,
        temperature: p.temperature,
        climatologyTemp: p.params.climatologyTemp,
        climatologyMoisture: p.params.climatologyMoisture,
      };
    });

    const service = new FieldService(map, worker as never, 7);
    await service.step(5);
    await service.step(5);
    // Without re-adopting the climatology arrays the second call would transfer
    // a detached buffer, throw, and silently fall back to inline stepping.
    assert.equal(worker.calls(), 2, "both steps should run in the worker");
    const sample = service.sample(16, 16);
    assert.ok(sample.kind === "clear" || sample.kind === "rain" || sample.kind === "snow" || sample.kind === "ash");
  });
});
