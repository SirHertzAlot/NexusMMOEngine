/**
 * Things stand on the ground: the terrain answers "how high is the ground
 * here" from the heights it draws, particles land on it instead of
 * sinking through, and the FX showcase stands every orb, the blade and
 * the gallery on the terrain under it (not at height 0).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { ChunkRow } from "@mmo-engine/protocol";
import { TerrainRenderer } from "../src/render/terrain/terrain-renderer.js";

const chunkId = (cx: number, cz: number): bigint => (BigInt.asUintN(32, BigInt(cx)) << 32n) | BigInt.asUintN(32, BigInt(cz));
const chunk = (cx: number, cz: number, heights: Float32Array | null): ChunkRow => ({ wireId: 0n, chunkId: chunkId(cx, cz), seed: 1n, lod: 0, heights });

describe("grounding", () => {
  it("the terrain gives its height where it's loaded, and nothing where it isn't", () => {
    const r = new TerrainRenderer(16);
    // A slope: height = x-sample index, 16 samples over 16 m.
    r.ensureChunk(1n, chunk(1, -1, Float32Array.from({ length: 256 }, (_, i) => i % 16)));
    assert.ok(Math.abs(r.heightAt(16 + 8, -8)! - 7.5) < 1e-5, "mid-chunk, between samples");
    assert.ok(Math.abs(r.heightAt(16, -16)! - 0) < 1e-5);
    assert.equal(r.heightAt(0, 0), null, "no chunk here");
    r.ensureChunk(2n, chunk(0, 0, null));
    assert.equal(r.heightAt(4, 4), null, "a flat stand-in isn't the ground yet");
  });

  it("particles land on the ground instead of falling through it", async () => {
    const { PARTICLE_PRESETS, QuarksFx } = await import("../src/render/vfx/quarks-fx.js");
    const fx = new QuarksFx();
    fx.setGround(() => 5);
    const scene = new THREE.Scene();
    const owner = new THREE.Object3D();
    owner.position.set(0, 5.5, 0);
    scene.add(fx.renderer, owner);
    // Heavy snow: falls fast, lives long.
    const h = fx.attach({ ...PARTICLE_PRESETS.snow, lift: -30, life: [5, 5], rate: 200, orbit: 0, wander: 0 }, owner);
    scene.updateMatrixWorld();
    for (let i = 0; i < 90; i++) fx.update(1 / 30);
    const ys = h.system.particles.slice(0, h.system.particleNum).map((p) => p.position.y);
    assert.ok(ys.length > 20, `particles alive (${ys.length})`);
    // Caught within a frame of reaching the surface (a frame at landing speed: < 0.3 m), never through it.
    assert.ok(Math.min(...ys) > 4.7, `none below the ground (lowest ${Math.min(...ys)})`);
    fx.dispose();
  });

  it("the gallery stands each entity on the ground under it", async () => {
    const { PrefabGallery } = await import("../src/render/prefab/gallery.js");
    const { QuarksFx } = await import("../src/render/vfx/quarks-fx.js");
    const fx = new QuarksFx();
    const gallery = new PrefabGallery(fx, () => new THREE.Object3D());
    gallery.group.position.set(100, 0, 0);
    // Ground rises to the east: y = 40 + x / 2.
    gallery.settle((x) => 40 + x / 2);
    assert.ok(gallery.group.children.length >= 6);
    for (const root of gallery.group.children) {
      const p = new THREE.Vector3();
      gallery.group.updateMatrixWorld(true);
      root.getWorldPosition(p);
      assert.ok(Math.abs(p.y - (40 + p.x / 2)) < 1e-6, `on the ground at x=${p.x}`);
    }
    gallery.dispose();
    fx.dispose();
  });
});
