/**
 * Weather and particles: the weather is decided the same way on every
 * client (biome + tick), fades in and out, and splashes burst and clean up.
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";
import { biomeAt, weatherAt, type WeatherRules } from "../src/render/fx/weather.js";

// The FX draw their textures on a 2D canvas: give Node one that does nothing.
before(() => {
  // nebula reads window.console and window.WebGL.
  (globalThis as { window?: unknown }).window ??= globalThis;
  // A canvas whose 2D context does nothing (and knows its canvas, as nebula's atlas asks).
  const canvas = (): object => {
    const c: Record<string, unknown> = { width: 0, height: 0 };
    const ctx: object = new Proxy(function () {}, {
      get: (_t, key) => (key === "canvas" ? c : ctx),
      apply: () => ctx,
    });
    c.getContext = () => ctx;
    c.remove = () => {};
    return c;
  };
  (globalThis as { document?: unknown }).document ??= { createElement: canvas };
});

const rules: WeatherRules = {
  biomes: { tundra: { kind: "snow", chance: 0.5 }, desert: { kind: "rain", chance: 0 }, glacier: { kind: "snow", chance: 1 } },
  spellMinutes: 5,
};
const SPELL = 30 * 60 * 5; // ticks in one spell at 30 Hz

describe("weatherAt", () => {
  it("is the same for everyone at the same tick, and steady within a spell", () => {
    for (let spell = 0; spell < 20; spell++) {
      const a = weatherAt(rules, "tundra", spell * SPELL, 30);
      assert.deepEqual(weatherAt(rules, "tundra", spell * SPELL + SPELL - 1, 30), a, "the whole spell");
    }
  });

  it("falls in about `chance` of the spells", () => {
    let on = 0;
    for (let spell = 0; spell < 400; spell++) on += weatherAt(rules, "tundra", spell * SPELL, 30).intensity;
    assert.ok(on > 150 && on < 250, `${on} of 400 spells snowed`);
    assert.equal(weatherAt(rules, "glacier", 7 * SPELL, 30).intensity, 1, "chance 1: always");
    assert.equal(weatherAt(rules, "desert", 7 * SPELL, 30).intensity, 0, "chance 0: never");
  });

  it("is clear where no rule applies", () => {
    assert.deepEqual(weatherAt(rules, "plains", 0, 30), { kind: null, intensity: 0 });
    assert.deepEqual(weatherAt(rules, null, 0, 30), { kind: null, intensity: 0 });
  });
});

describe("biomeAt", () => {
  const map: WorldMap = {
    cell: 16, width: 2, depth: 2, originX: 0, originZ: 0,
    heights: new Float32Array(4), biome: Uint8Array.from([0, 1, 1, 0]), biomes: ["tundra", "desert"], river: new Uint8Array(4),
  };
  it("reads the nearest map cell, null outside the map", () => {
    assert.equal(biomeAt(map, 0, 0), "tundra");
    assert.equal(biomeAt(map, 17, 2), "desert");
    assert.equal(biomeAt(map, -100, 0), null);
  });
});

describe("ParticleFx", () => {
  it("fades the weather in and out, and splashes burst and clean up", async () => {
    const { ParticleFx } = await import("../src/render/fx/particle-fx.js");
    const fx = new ParticleFx(new THREE.PerspectiveCamera());
    const cam = new THREE.Vector3(0, 10, 0);
    for (let i = 0; i < 40; i++) fx.update(0.1, cam, { kind: "snow", intensity: 1 });
    assert.ok(fx.levels().snow > 0.45 && fx.levels().snow < 0.55, `4 s into an 8 s fade: ${fx.levels().snow}`);
    assert.equal(fx.levels().rain, 0);
    assert.ok(fx.count > 100, `snow is falling: ${fx.count} flakes`);
    for (let i = 0; i < 100; i++) fx.update(0.1, cam, { kind: null, intensity: 0 });
    assert.equal(fx.levels().snow, 0, "faded out");

    assert.equal(fx.splash(new THREE.Vector3()), true);
    assert.equal(fx.splash(new THREE.Vector3()), false, "rate-limited");
    for (let i = 0; i < 100; i++) fx.update(0.1, cam, { kind: null, intensity: 0 });
    assert.equal(fx.count, 0, "every flake and droplet gone");
    fx.dispose();
  });
});
