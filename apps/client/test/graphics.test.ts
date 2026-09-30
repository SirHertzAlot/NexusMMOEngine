/**
 * The graphics pass: quality presets from the GPU tier and the governor's
 * steps; BVH raycasting agreeing with three's own; the quarks effects the
 * composer's signals name; and the physical sky's frame (our world on the
 * ellipsoid).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { QUALITY_PRESETS, QUALITY_TIERS, stepTier, tierForGpu } from "../src/render/quality.js";

// three's own raycast, before any test installs the BVH one.
const plainRaycast = THREE.Mesh.prototype.raycast;

describe("quality", () => {
  it("picks a preset for the GPU", () => {
    assert.equal(tierForGpu({ tier: 3, type: "BENCHMARK", fps: 90 }), "high");
    assert.equal(tierForGpu({ tier: 3, type: "BENCHMARK", fps: 144 }), "ultra");
    assert.equal(tierForGpu({ tier: 3, type: "BENCHMARK", fps: 144, isMobile: true }), "high", "no ultra on phones");
    assert.equal(tierForGpu({ tier: 2, type: "BENCHMARK" }), "medium");
    assert.equal(tierForGpu({ tier: 2, type: "BENCHMARK", isMobile: true }), "low");
    assert.equal(tierForGpu({ tier: 1, type: "BENCHMARK" }), "low");
    assert.equal(tierForGpu({ tier: 3, type: "BENCHMARK", fps: 144 }, true), "low", "software rendering");
    assert.equal(tierForGpu({ tier: 0, type: "BLOCKLISTED" }), "low");
    assert.equal(tierForGpu({ tier: 1, type: "FALLBACK" }), "medium", "unknown GPUs start in the middle");
    assert.equal(tierForGpu({ tier: 0, type: "BENCHMARK_FETCH_FAILED" }), "medium");
  });

  it("steps within the ladder, never above the cap", () => {
    assert.equal(stepTier("high", -1), "medium");
    assert.equal(stepTier("low", -1), null);
    assert.equal(stepTier("medium", 1, "high"), "high");
    assert.equal(stepTier("high", 1, "high"), null, "the player's (or the GPU's) preset is the ceiling");
  });

  it("does more at each preset", () => {
    const presets = QUALITY_TIERS.map((t) => QUALITY_PRESETS[t]);
    for (let i = 1; i < presets.length; i++) {
      assert.ok(presets[i].particles > presets[i - 1].particles, `${presets[i].tier}: more particles`);
      assert.ok(presets[i].dpr[1] >= presets[i - 1].dpr[1], `${presets[i].tier}: resolution`);
      assert.ok(presets[i].msaa >= presets[i - 1].msaa);
    }
    assert.equal(QUALITY_PRESETS.low.effects, false, "low draws straight to the screen");
    assert.equal(QUALITY_PRESETS.low.ao, false);
    assert.equal(QUALITY_PRESETS.high.sky, "physical");
  });
});

describe("BVH raycasting", () => {
  it("builds trees only for geometry worth it, and hits what three's raycast hits", async () => {
    const { ensureBoundsTree, installBvh } = await import("../src/render/bvh.js");
    assert.equal(ensureBoundsTree(new THREE.BoxGeometry()), false, "12 triangles: not worth a tree");
    const knot = new THREE.TorusKnotGeometry(1, 0.3, 200, 32);
    const mesh = new THREE.Mesh(knot, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld();
    const rays: THREE.Raycaster[] = [];
    for (let i = 0; i < 40; i++) {
      const from = new THREE.Vector3(Math.cos(i) * 5, Math.sin(i * 1.7) * 3, Math.sin(i) * 5);
      rays.push(new THREE.Raycaster(from, from.clone().multiplyScalar(-1).add(new THREE.Vector3(Math.sin(i * 3) * 0.4, 0, 0)).normalize()));
    }
    const hit = (r: THREE.Raycaster): number | null => {
      const out: THREE.Intersection[] = [];
      mesh.raycast(r, out);
      return out.length ? Math.min(...out.map((h) => h.distance)) : null;
    };
    mesh.raycast = plainRaycast;
    const expected = rays.map(hit);
    installBvh();
    mesh.raycast = THREE.Mesh.prototype.raycast;
    assert.notEqual(THREE.Mesh.prototype.raycast, plainRaycast, "installed");
    assert.equal(ensureBoundsTree(knot), true);
    assert.ok(knot.boundsTree);
    rays.forEach((r, i) => {
      const got = hit(r);
      if (expected[i] === null) assert.equal(got, null, `ray ${i} misses`);
      else assert.ok(got !== null && Math.abs(got - expected[i]!) < 1e-4, `ray ${i}: ${got} vs ${expected[i]}`);
    });
    assert.ok(expected.filter((d) => d !== null).length > 10, "most rays hit");
  });
});

describe("quarks effects", () => {
  it("start the composer's signals, scale by budget, and clean up", async () => {
    const { PARTICLE_PRESETS, QuarksFx } = await import("../src/render/vfx/quarks-fx.js");
    const fx = new QuarksFx();
    const owner = new THREE.Object3D();
    for (const effect of ["embers", "snow", "sparks", "spores", "motes", "smoke", "void-wisps", "glimmer"]) {
      assert.ok(PARTICLE_PRESETS[effect], `${effect} has a preset`);
      assert.ok(fx.attachSignal({ kind: "particles", id: effect, params: { effect } }, owner), `${effect} starts`);
    }
    const aura = fx.attachSignal({ kind: "aura", id: "aura-fire", params: { color: "#ff6a1a", radius: 1.2 } }, owner);
    assert.ok(aura);
    assert.equal(fx.attachSignal({ kind: "runes", id: "runes-fire", params: {} }, owner), null, "runes aren't particles");
    assert.equal(fx.attachSignal({ kind: "particles", id: "confetti", params: {} }, owner), null, "unknown effects are skipped");
    const trail = fx.attachTrail(owner);
    assert.equal(fx.systems, 10);
    assert.equal(owner.children.length, 10, "emitters follow their owner");
    fx.setBudget(0.5);
    const rate = (aura!.system.emissionOverTime as unknown as { value: number }).value;
    fx.setBudget(1);
    assert.equal((aura!.system.emissionOverTime as unknown as { value: number }).value, rate * 2, "the budget scales emission");
    fx.update(1 / 30);
    aura!.dispose();
    trail.dispose();
    assert.equal(fx.systems, 8);
    fx.dispose();
    assert.equal(fx.systems, 0);
    assert.equal(owner.children.length, 0);
  });
});

describe("physical sky frame", () => {
  it("puts our world on the ellipsoid: up is up, north is north, the origin on the surface", async () => {
    const { worldToECEF } = await import("../src/render/sky/physical-sky.js");
    const lat = 42, lon = 12;
    const m = worldToECEF(lat, lon);
    const origin = new THREE.Vector3().applyMatrix4(m);
    assert.ok(Math.abs(origin.length() - 6_368_000) < 20_000, `on the surface (${origin.length()})`);
    const φ = THREE.MathUtils.degToRad(lat), λ = THREE.MathUtils.degToRad(lon);
    const upGeodetic = new THREE.Vector3(Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ));
    const up = new THREE.Vector3(0, 1, 0).transformDirection(m);
    assert.ok(up.dot(upGeodetic) > 0.9999, "+y is the local vertical");
    const north = new THREE.Vector3(0, 0, -1).transformDirection(m);
    assert.ok(north.dot(new THREE.Vector3(0, 0, 1)) > 0, "−z points toward the north pole");
    assert.ok(Math.abs(north.dot(upGeodetic)) < 1e-6, "north is level");
    const east = new THREE.Vector3(1, 0, 0).transformDirection(m);
    assert.ok(east.clone().cross(north).dot(up) > 0.9999, "east × north = up: right-handed");
  });
});
