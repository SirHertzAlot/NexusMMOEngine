/** VFX helpers: the preview emits what the client would under a tier, colours round-trip, the toon band cuts light from shadow. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveParticles, type TiersDoc, type VfxDoc } from "@mmo-engine/art";
import { ParticlePreview, emissionRate, hexToLinear, linearToHex, previewLife, toonColour } from "../src/vfx-model.js";

const read = <T>(rel: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../content/${rel}`, import.meta.url)), "utf8")) as T;

describe("particle preview", () => {
  const vfx = read<VfxDoc>("vfx/effects.json");
  const tiers = read<TiersDoc>("vfx/tiers.json");
  const settle = (p: ParticlePreview): number => {
    for (let i = 0; i < 600; i++) p.step(1 / 30);
    return p.dots.length;
  };

  it("emission is the tier's multiplier, held under its live-particle cap", () => {
    assert.equal(emissionRate(100, 2, { particles: 0.5, cap: 1000 }), 50);
    assert.equal(emissionRate(100, 2, { particles: 1.5, cap: 100 }), 50);
  });

  it("a settled effect holds about rate x multiplier x life particles, never more than the cap", () => {
    const e = vfx.effects.embers;
    const kind = { kind: "effect", effect: e } as const;
    const t = tiers.tiers.high;
    const live = settle(new ParticlePreview(kind, { particles: t.particles, cap: t.effectBudget }));
    const expect = liveParticles(e.rate, e.life, t.particles);
    assert.ok(Math.abs(live - expect) <= expect * 0.15 + 2, `${live} vs ${expect}`);
    const capped = settle(new ParticlePreview({ kind: "effect", effect: { ...e, rate: 3000 } }, { particles: 1, cap: 100 }));
    assert.ok(capped <= 105, `${capped} under a cap of 100`);
  });

  it("the low tier draws fewer particles than ultra", () => {
    const kind = { kind: "weather", weather: vfx.weather.rain } as const;
    const low = settle(new ParticlePreview(kind, { particles: tiers.tiers.low.particles, cap: tiers.tiers.low.weatherBudget }));
    const ultra = settle(new ParticlePreview(kind, { particles: tiers.tiers.ultra.particles, cap: tiers.tiers.ultra.weatherBudget }));
    assert.ok(low < ultra);
  });

  it("is deterministic", () => {
    const a = new ParticlePreview({ kind: "splash", splash: vfx.splash }, { particles: 1, cap: 1000 }, 3);
    const b = new ParticlePreview({ kind: "splash", splash: vfx.splash }, { particles: 1, cap: 1000 }, 3);
    for (let i = 0; i < 20; i++) {
      a.step(0.05);
      b.step(0.05);
    }
    assert.deepEqual(a.dots, b.dots);
    assert.equal(previewLife({ kind: "splash", splash: vfx.splash }), vfx.splash.life);
  });
});

describe("colour and toon", () => {
  it("linear colours round-trip through hex", () => {
    for (const hex of ["#000000", "#ffffff", "#7f3fbf", "#e8a37a"]) assert.equal(linearToHex(hexToLinear(hex)), hex);
    assert.deepEqual(hexToLinear("#ffffff"), [1, 1, 1]);
  });
  it("the band cuts the light: lit side is the base colour, the dark side the ramp's shadow", () => {
    const base = [0.8, 0.6, 0.4] as const;
    const ramp: [[number, number, number], [number, number, number]] = [[0.5, 0.5, 0.5], [0.9, 0.9, 0.9]];
    const toon = { band: [0.42, 0.45] as [number, number], rim: 0, rimPower: 6 };
    assert.deepEqual(toonColour(1, 1, [...base], ramp, toon), [0.8, 0.6, 0.4]);
    const dark = toonColour(-1, 1, [...base], ramp, toon);
    assert.ok(dark.every((v, i) => Math.abs(v - base[i] * 0.5) < 1e-9));
    const moved = toonColour(0, 1, [...base], ramp, { ...toon, band: [0.2, 0.25] });
    assert.deepEqual(moved, [0.8, 0.6, 0.4], "a lower band edge lights the terminator");
    assert.ok(toonColour(0.5, 0.1, [...base], ramp, { ...toon, rim: 0.5 })[0] > toonColour(0.5, 0.1, [...base], ramp, toon)[0], "rim brightens grazing angles");
  });
});
