import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VfxEffect,
  parseVfxEffect,
  VfxSpawnShape,
  VfxForce,
} from "../src/vfx-schema.js";

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
});
