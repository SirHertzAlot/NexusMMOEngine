import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { EffectDefinition } from "@mmo-engine/render-fx";
import { SpellFxLayer } from "../src/render/vfx/spell-fx-layer.js";

const SPLINE_FIRE_DEF: EffectDefinition = {
  assetId: "fx.spline-fire",
  version: 1,
  kind: "oneshot",
  onOrphan: "detach",
  params: {
    bodyColor: { type: "color", default: "#ff5522" },
    secondaryColor: { type: "color", default: "#ffd166" },
    power01: { type: "float", default: 1.0, min: 0, max: 1 },
    travelSeconds: { type: "float", default: 0.55, min: 0.1, max: 3 },
  },
  modules: [
    {
      module: "CurveEmitterModule",
      params: { color: "$bodyColor", accent: "$secondaryColor", count: 140, speed: 18, radius: 0.42, spread: 0.35 },
    },
    { module: "ShellModule", params: { rimColor: "$bodyColor", power: 1.4 } },
    { module: "RingBurstModule", params: { count: 3, axis: 1, color: "$bodyColor" } },
    { module: "PoolModule", params: { count: 180, mode: 1, color: "$bodyColor" } },
  ],
  bindings: [{ kind: "spline" }],
  timing: { duration: 2.0, loop: "once", seedable: true },
  quality: { minTier: "low", slotCaps: { low: 6, medium: 12, high: 24, ultra: 32 } },
};

const SHIELD_DEF: EffectDefinition = {
  assetId: "fx.force-shield",
  version: 1,
  kind: "persistent",
  onOrphan: "fade",
  params: {
    color: { type: "color", default: "#26aeff" },
    hp01: { type: "float", default: 1.0, min: 0, max: 1 },
    hexScale: { type: "float", default: 3.0, min: 1, max: 8 },
  },
  modules: [{ module: "ShieldModule", params: { hitSlots: 8, hexScale: "$hexScale" } }],
  bindings: [{ kind: "entity" }],
  timing: { duration: -1, loop: "loop", seedable: true },
  quality: { minTier: "low", slotCaps: { low: 0, medium: 4, high: 8, ultra: 8 } },
};

describe("SpellFxLayer", () => {
  it("spawns spline CurveEmitter particles along waypoints and cleans up after duration", () => {
    const layer = new SpellFxLayer([SPLINE_FIRE_DEF], undefined, "high");
    const cam = new THREE.PerspectiveCamera();

    const handle = layer.applyFxMessage(
      {
        kind: "fx-spawn",
        fxId: "fx-spline-1",
        tick: 100,
        seq: 1,
        assetId: "fx.spline-fire",
        assetVersion: 1,
        seed: 42,
        phase: "travel",
        binding: {
          kind: "spline",
          pos: [8, 0.35, 0],
          waypoints: [
            [0, 0.35, 0],
            [4, 0.35, 2],
            [8, 0.35, 0],
          ],
        },
      },
      100,
      30,
    );

    assert.notEqual(handle, null);
    assert.equal(layer.activeInstanceCount, 1);

    layer.update(0.2, cam);
    assert.ok(layer.activeParticleCount > 0, "expected CurveEmitter particles while traveling");

    layer.update(0.45, cam);
    assert.ok(layer.activeParticleCount > 0, "expected endpoint detonation burst particles");

    layer.update(1.6, cam);
    assert.equal(layer.activeInstanceCount, 0, "expected oneshot spline FX to expire");
    layer.dispose();
  });

  it("tracks entity position, shield hit rings, and drops shield on low quality", () => {
    const layer = new SpellFxLayer([SHIELD_DEF], { "fx.force-shield": { low: 0, high: 4 } }, "high");
    const cam = new THREE.PerspectiveCamera();

    const h = layer.applyFxMessage(
      {
        kind: "fx-spawn",
        fxId: "fx-shield-7",
        tick: 10,
        seq: 1,
        assetId: "fx.force-shield",
        assetVersion: 1,
        seed: 7,
        phase: "active",
        binding: { kind: "entity", entityId: "7" },
      },
      10,
      30,
    );
    assert.notEqual(h, null);
    assert.equal(layer.activeInstanceCount, 1);

    layer.applyFxMessage(
      {
        kind: "fx-update",
        fxId: "fx-shield-7",
        tick: 11,
        seq: 2,
        phase: "hit",
        params: { hp01: 0.65 },
        hit: { pos: [0.5, 0.4, 0.7] },
      },
      11,
      30,
    );

    layer.update(0.05, cam, (wid, out) => {
      if (wid === 7n) {
        out.set(12, 1, -4);
        return true;
      }
      return false;
    });
    assert.equal(layer.activeInstanceCount, 1);

    layer.setQuality("low");
    assert.equal(layer.activeInstanceCount, 0);
    layer.dispose();
  });

  it("toggles live mouse-drag spline preview visibility", () => {
    const layer = new SpellFxLayer([SPLINE_FIRE_DEF]);
    assert.equal(layer.isPreviewVisible, false);

    layer.setPreview(
      [
        [0, 0, 0],
        [3, 0, 1],
      ],
      "#38b6ff",
    );
    assert.equal(layer.isPreviewVisible, true);

    layer.clearPreview();
    assert.equal(layer.isPreviewVisible, false);
    layer.dispose();
  });
});
