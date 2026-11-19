/**
 * B1 headless client integration: `EntityLayer` renders baked SoA meshes through
 * `BakedAssetProvider` behind `AssetProvider` and preserves `PlaceholderAssets` fallback
 * for unbaked / rejected assets.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as THREE from "three";
import { bakeClipStore, bakeKitGeometry } from "@mmo-engine/art";
import type { BodyConfigRow, TransformRow } from "@mmo-engine/protocol";
import { Interpolator, MirrorState } from "@mmo-engine/mirror";
import { BakedAssetProvider, PlaceholderAssets, bakedAssetHash32 } from "../src/render/assets.js";
import { AnimationLibrary, CharacterAnimator } from "../src/render/character/character-animator.js";
import { EntityLayer } from "../src/render/entity-layer.js";
import { TerrainRenderer } from "../src/render/terrain/terrain-renderer.js";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

before(() => {
  const noop: object = new Proxy(function () {}, {
    get: (_t, key) => (key === "width" || key === "height" ? 64 : noop),
    apply: () => noop,
  });
  (globalThis as { document?: unknown }).document ??= {
    createElement: () => ({ width: 0, height: 0, getContext: () => noop }),
  };
});

/** Minimal valid glTF 2.0 binary with 6 vertices (distinct from 24-vert BoxGeometry fallback). */
function makePyramidGlb(): Buffer {
  const pos = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 1.5, 0.5,
  ]);
  const idx = new Uint16Array([0, 1, 2, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  const binBuf = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binBuf.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 12, type: "SCALAR" },
    ],
  };
  const jRaw = Buffer.from(JSON.stringify(gltf), "utf8");
  const jPad = Buffer.concat([jRaw, Buffer.alloc((4 - (jRaw.length % 4)) % 4, 0x20)]);
  const out = Buffer.alloc(12 + 8 + jPad.length + 8 + binBuf.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jPad.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jPad.copy(out, 20);
  out.writeUInt32LE(binBuf.length, 20 + jPad.length);
  out.writeUInt32LE(0x004e4942, 24 + jPad.length);
  binBuf.copy(out, 28 + jPad.length);
  return out;
}

describe("B1 headless client integration with BakedAssetProvider", () => {
  it("loads baked kit into EntityLayer behind AssetProvider and preserves placeholder fallback", async () => {
    const src = makeTempDir("b1-cli-src-");
    const out = makeTempDir("b1-cli-out-");
    const glbPath = join(src, "models", "pyramid.glb");
    mkdirSync(dirname(glbPath), { recursive: true });
    writeFileSync(glbPath, makePyramidGlb());

    const baked = bakeKitGeometry({
      assetsRoot: src,
      outDir: out,
      kit: "demo",
      target: "shipped-prototype-pack",
      manifest: {
        name: "demo",
        version: "1.0.0",
        models: [{ id: "demo/pyramid", file: "models/pyramid.glb" }],
        textures: [],
      },
      assetLicences: { "demo/pyramid": { name: "CC BY 4.0", author: "Test" } },
    });

    try {
      const files = new Map<string, Uint8Array>([
        [baked.manifest.chunkFile, readFileSync(baked.chunkPath)],
      ]);
      const provider = new BakedAssetProvider({
        baseUrl: "/baked/",
        manifestFile: "demo.baked.json",
        placeholder: new PlaceholderAssets(),
        fetchJson: async () => baked.manifest,
        fetchBinary: async (url) => {
          const rel = url.replace(/^\/baked\//, "");
          const buf = files.get(rel);
          if (!buf) throw new Error(`404 ${rel}`);
          return buf;
        },
      });
      await provider.loadAssetPack("/baked/");

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera();
      const layer = new EntityLayer(scene, camera, provider, new TerrainRenderer(16));
      scene.add(layer.group);

      const tr = (wireId: bigint, x: number): TransformRow => ({
        wireId, px: x, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1,
      });
      const dynBody = (wireId: bigint): BodyConfigRow => ({
        wireId, shapeKind: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5, radius: 0.5,
        mass: 1, friction: 0.5, restitution: 0, motionType: 2, layer: 1,
      });

      const state = new MirrorState();
      const interp = new Interpolator();
      // Entity 100n: backed by baked SoA pyramid (4 verts)
      state.entities.set(100n, {
        wireId: 100n,
        transform: tr(100n, 4),
        body: dynBody(100n),
        asset: { wireId: 100n, assetHash: bakedAssetHash32("demo/pyramid"), variant: 0 },
      });
      // Entity 101n: missing/unbaked AssetRef -> falls back to PlaceholderAssets BoxGeometry (24 verts)
      state.entities.set(101n, {
        wireId: 101n,
        transform: tr(101n, -4),
        body: dynBody(101n),
        asset: { wireId: 101n, assetHash: bakedAssetHash32("demo/missing"), variant: 0 },
      });
      interp.push(1, [tr(100n, 4), tr(101n, -4)]);
      layer.sync(state, interp, 1, null);

      const meshes = layer.group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      assert.equal(meshes.length, 2);
      const vertCounts = meshes.map((m) => m.geometry.attributes.position.count).sort((a, b) => a - b);
      assert.deepEqual(vertCounts, [4, 24], "4-vert baked pyramid + 24-vert placeholder box");

      layer.dispose();
      provider.dispose();
    } finally {
      baked.store.close();
    }
  });

  it("plays B2 baked clips through the existing AnimationLibrary and CharacterAnimator intake", () => {
    const src = makeTempDir("b2-cli-src-");
    const out = makeTempDir("b2-cli-out-");
    const glbPath = join(src, "anim.glb");

    // Minimal 1-bone animated GLB rotating Spine_01 around Y by 0.6 rad
    const times = new Float32Array([0, 0.5, 1.0]);
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    const quats = new Float32Array([q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w, q0.x, q0.y, q0.z, q0.w]);
    const binBuf = Buffer.concat([Buffer.from(times.buffer), Buffer.from(quats.buffer)]);
    const gltf = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: "Hips", children: [1] }, { name: "Spine_01" }],
      animations: [
        {
          name: "Vault_Over",
          samplers: [{ input: 0, output: 1, interpolation: "LINEAR" }],
          channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }],
        },
      ],
      buffers: [{ byteLength: binBuf.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: times.byteLength },
        { buffer: 0, byteOffset: times.byteLength, byteLength: quats.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "SCALAR" },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC4" },
      ],
    };
    const jRaw = Buffer.from(JSON.stringify(gltf), "utf8");
    const jPad = Buffer.concat([jRaw, Buffer.alloc((4 - (jRaw.length % 4)) % 4, 0x20)]);
    const glb = Buffer.alloc(12 + 8 + jPad.length + 8 + binBuf.length);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(jPad.length, 12);
    glb.writeUInt32LE(0x4e4f534a, 16);
    jPad.copy(glb, 20);
    glb.writeUInt32LE(binBuf.length, 20 + jPad.length);
    glb.writeUInt32LE(0x004e4942, 24 + jPad.length);
    binBuf.copy(glb, 28 + jPad.length);
    writeFileSync(glbPath, glb);

    const res = bakeClipStore({
      assetsRoot: src,
      outDir: out,
      kit: "demo-clips",
      target: "shipped-prototype-pack",
      sources: [{ id: "cc0-demo", file: "anim.glb", license: "CC0 1.0" }],
    });

    try {
      const lib = AnimationLibrary.fromBakedManifest(res.manifest, readFileSync(res.chunkPath));
      assert.deepEqual(lib.names, ["Vault_Over"]);

      const root = new THREE.Group();
      const hips = new THREE.Bone();
      hips.name = "Hips";
      const spine = new THREE.Bone();
      spine.name = "Spine_01";
      hips.add(spine);
      root.add(hips);

      const animator = new CharacterAnimator(root, lib);
      assert.equal(animator.play("Vault_Over", { loop: false, fadeIn: 0 }), true);
      animator.update(0.5, { speed: 0, vy: 0, mode: 0 });
      assert.ok(Math.abs(spine.quaternion.y - q1.y) < 1e-2, `spine rotated to ~${q1.y.toFixed(3)}, got ${spine.quaternion.y.toFixed(3)}`);
      animator.dispose();
    } finally {
      res.store.close();
    }
  });
});
