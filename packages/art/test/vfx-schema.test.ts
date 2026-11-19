import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VfxEffect,
  parseVfxEffect,
  resolveEmitterRenderSettings,
  resolveFlipbookFrames,
  VfxSpawnShape,
  VfxForce,
} from "../src/vfx-schema.js";
import { vfxToQuarks } from "../src/vfx-convert.js";
import { loadParticleBudgets } from "../src/particle-budgets.js";

const validEffect = {
  id: "fireball",
  name: "Fireball",
  version: 1,
  emitters: [
    {
      name: "flames",
      rate: 50,
      bursts: [],
      duration: 2,
      looping: false,
      maxParticles: 100,
      spawnShape: { kind: "sphere", radius: 0.5 },
      speed: 5,
      direction: { x: 0, y: 1, z: 0 },
      spread: 0.3,
      lifetime: 1.5,
      size: { points: [{ t: 0, value: 0.5 }, { t: 1, value: 0.1 }] },
      color: {
        stops: [
          { t: 0, color: { r: 1, g: 0.5, b: 0, a: 1 } },
          { t: 1, color: { r: 0.5, g: 0, b: 0, a: 0 } },
        ],
      },
      forces: [{ kind: "gravity", acceleration: { x: 0, y: -9.8, z: 0 } }],
      position: { x: 0, y: 0, z: 0 },
    },
  ],
  blendMode: "additive",
  authoredTier: "medium",
};

describe("VfxEffect schema", () => {
  it("accepts a valid effect", () => {
    const effect = parseVfxEffect(validEffect);
    assert.equal(effect.id, "fireball");
    assert.equal(effect.emitters.length, 1);
  });

  it("rejects invalid effect IDs", () => {
    assert.throws(() => parseVfxEffect({ ...validEffect, id: "Fire Ball!" }));
  });

  it("rejects empty emitters", () => {
    assert.throws(() => parseVfxEffect({ ...validEffect, emitters: [] }));
  });

  it("applies defaults", () => {
    const minimal = {
      id: "test",
      name: "Test",
      emitters: [
        {
          name: "e1",
          maxParticles: 10,
          spawnShape: { kind: "point" },
          speed: 1,
          lifetime: 1,
          size: 1,
          color: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
    };
    const effect = parseVfxEffect(minimal);
    assert.equal(effect.version, 1);
    assert.equal(effect.blendMode, "normal");
    assert.equal(effect.authoredTier, "medium");
    assert.equal(effect.emitters[0].looping, true);
    assert.equal(effect.emitters[0].rate, 0);
  });

  it("validates all spawn shapes", () => {
    const shapes = [
      { kind: "point" },
      { kind: "sphere", radius: 1 },
      { kind: "box", halfExtents: { x: 1, y: 1, z: 1 } },
      { kind: "cone", angle: 0.5, radius: 1, height: 2 },
      { kind: "disc", radius: 1 },
    ];
    for (const shape of shapes) {
      assert.doesNotThrow(() => VfxSpawnShape.parse(shape));
    }
  });

  it("rejects invalid spawn shape params", () => {
    assert.throws(() => VfxSpawnShape.parse({ kind: "sphere", radius: -1 }));
    assert.throws(() => VfxSpawnShape.parse({ kind: "cone", angle: 5, radius: 1, height: 1 }));
  });

  it("validates all force types", () => {
    const forces = [
      { kind: "gravity", acceleration: { x: 0, y: -9.8, z: 0 } },
      { kind: "drag", coefficient: 0.5 },
      { kind: "turbulence", intensity: 1, frequency: 2 },
      { kind: "attractor", target: { x: 0, y: 0, z: 0 }, strength: 5 },
    ];
    for (const force of forces) {
      assert.doesNotThrow(() => VfxForce.parse(force));
    }
  });

  it("validates curve points are in [0,1]", () => {
    const bad = {
      ...validEffect,
      emitters: [
        {
          ...validEffect.emitters[0],
          size: { points: [{ t: 0, value: 1 }, { t: 1.5, value: 0 }] },
        },
      ],
    };
    assert.throws(() => parseVfxEffect(bad));
  });

  it("validates color channels are in [0,1]", () => {
    const bad = {
      ...validEffect,
      emitters: [
        {
          ...validEffect.emitters[0],
          color: { r: 2, g: 0, b: 0, a: 1 },
        },
      ],
    };
    assert.throws(() => parseVfxEffect(bad));
  });

  it("supports v2/Version A per-emitter texture, blendMode, nearest sampling, and flipbook metadata", () => {
    const v2 = parseVfxEffect({
      id: "pfb-flipbook-test",
      name: "Pixel Flipbook Smoke + Fire",
      version: 2,
      blendMode: "additive",
      texture: "vfx/pixel-fireball-sheet",
      textureSampling: "nearest",
      emitters: [
        {
          name: "core",
          maxParticles: 1,
          rate: 1,
          duration: 1,
          looping: true,
          spawnShape: { kind: "point" },
          speed: 0,
          lifetime: 1.0,
          size: 0.5,
          color: { r: 1, g: 1, b: 1, a: 1 },
          flipbook: { columns: 4, rows: 5, frames: [4, 5, 6, 7], fps: 12, loop: "loop" },
        },
        {
          name: "smoke",
          maxParticles: 8,
          rate: 4,
          duration: 1,
          looping: false,
          spawnShape: { kind: "sphere", radius: 0.2 },
          speed: 0.5,
          lifetime: 0.8,
          size: 0.6,
          color: { r: 0.4, g: 0.35, b: 0.45, a: 0.7 },
          blendMode: "normal",
          texture: "vfx/pixel-smoke-sheet",
          flipbook: { columns: 4, rows: 5, frameRange: [16, 19], fps: 12, loop: "once" },
        },
      ],
    });
    assert.equal(v2.version, 2);
    assert.deepEqual(resolveFlipbookFrames(v2.emitters[0].flipbook!), [4, 5, 6, 7]);
    assert.deepEqual(resolveFlipbookFrames(v2.emitters[1].flipbook!), [16, 17, 18, 19]);
    assert.deepEqual(resolveEmitterRenderSettings(v2, v2.emitters[0]), {
      blendMode: "additive",
      texture: "vfx/pixel-fireball-sheet",
      textureSampling: "nearest",
      flipbook: v2.emitters[0].flipbook,
    });
    assert.deepEqual(resolveEmitterRenderSettings(v2, v2.emitters[1]), {
      blendMode: "normal",
      texture: "vfx/pixel-smoke-sheet",
      textureSampling: "nearest",
      flipbook: v2.emitters[1].flipbook,
    });

    const systems = vfxToQuarks(v2);
    assert.equal(systems.length, 2);
    assert.equal(systems[0].uTileCount, 4);
    assert.equal(systems[0].vTileCount, 5);
    assert.ok(systems[0].behaviors.some((b) => b.type === "FrameOverLife"));
  });

  it("rejects out-of-range flipbook frame indices and dual frames/frameRange", () => {
    assert.throws(() =>
      parseVfxEffect({
        ...validEffect,
        emitters: [
          {
            ...validEffect.emitters[0],
            flipbook: { columns: 4, rows: 4, frames: [16], fps: 12 },
          },
        ],
      }),
    );
    assert.throws(() =>
      parseVfxEffect({
        ...validEffect,
        emitters: [
          {
            ...validEffect.emitters[0],
            flipbook: { columns: 4, rows: 4, frames: [0], frameRange: [0, 3], fps: 12 },
          },
        ],
      }),
    );
  });

  it("validates ported pixel-fireball suite, low-tier reduction (7 emitters / 298 particles), and KR worldbuilding ambient VFX", () => {
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
    const budgets = loadParticleBudgets(
      JSON.parse(readFileSync(resolve(repoRoot, "content/vfx/budgets.json"), "utf8")),
    );
    const load = (file: string) =>
      parseVfxEffect(JSON.parse(readFileSync(resolve(repoRoot, "content/vfx", file), "utf8")));

    const proj = load("pfb-projectile.json");
    const impact = load("pfb-impact.json");
    const smoke = load("pfb-smoke.json");
    const suite = [proj, impact, smoke];
    const totalEmitters = suite.reduce((n, e) => n + e.emitters.length, 0);
    const totalParticles = suite.reduce(
      (n, e) => n + e.emitters.reduce((m, em) => m + em.maxParticles, 0),
      0,
    );
    assert.equal(totalEmitters, 9);
    assert.equal(totalParticles, 382);
    assert.ok(totalEmitters <= budgets.tiers.medium.maxEmitters);
    assert.ok(totalParticles <= budgets.tiers.medium.maxParticles);
    assert.ok(totalEmitters > budgets.tiers.low.maxEmitters);

    // Spec §2 low-tier reduction: drop pfb-smoke + drop impact.tongues -> 7 emitters / 298 particles.
    const reducedImpactEmitters = impact.emitters.filter((em) => em.name !== "tongues");
    const reducedEmitters = proj.emitters.length + reducedImpactEmitters.length;
    const reducedParticles = [...proj.emitters, ...reducedImpactEmitters].reduce(
      (m, em) => m + em.maxParticles,
      0,
    );
    assert.equal(reducedEmitters, 7);
    assert.equal(reducedParticles, 298);
    assert.ok(reducedEmitters <= budgets.tiers.low.maxEmitters);
    assert.ok(reducedParticles <= budgets.tiers.low.maxParticles);

    const motes = load("life-motes.json");
    const bleed = load("corruption-bleed.json");
    assert.equal(bleed.version, 2);
    for (const fx of [proj, impact, smoke, motes, bleed]) {
      assert.doesNotThrow(() => vfxToQuarks(fx));
    }
  });
});
