/**
 * Client terrain: chunk meshes split cells on the server's diagonal and
 * light seamlessly across borders; the renderer tracks chunks, hides the
 * far horizon exactly where chunks are loaded, and colours ground by biome.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { ChunkRow, WorldMap } from "@mmo-engine/protocol";
import { BIOME_GROUND, DEFAULT_GROUND, groundColors, snowLine } from "../src/render/terrain/ground.js";
import { buildChunkGeometry, chunkNormals, SIDE, SKIRT_DEPTH } from "../src/render/terrain/terrain-mesh.js";
import { createTerrainMaterial, createTerrainUniforms } from "../src/render/terrain/terrain-material.js";
import { FAR_DROP_MARGIN, farGeometry, TerrainRenderer } from "../src/render/terrain/terrain-renderer.js";

const SIZE = 16;
const STEP = SIZE / 15;
/** A smooth world-space surface, so neighbouring tiles agree on shared samples. */
const surface = (gx: number, gz: number): number => Math.fround(3 * Math.sin(gx * 0.21) + 2 * Math.cos(gz * 0.17 + 1));
const tile = (cx: number, cz: number): Float32Array =>
  Float32Array.from({ length: 256 }, (_, i) => surface(cx * 15 + (i % 16), cz * 15 + Math.floor(i / 16)));

const chunkId = (cx: number, cz: number): bigint =>
  ((BigInt(cx) & 0xffffffffn) << 32n) | (BigInt(cz) & 0xffffffffn);
const row = (cx: number, cz: number, heights: Float32Array | null): ChunkRow => ({
  wireId: 0n,
  chunkId: chunkId(cx, cz),
  seed: 1n,
  lod: 0,
  heights,
});

describe("chunk geometry", () => {
  it("splits cells along (i+1, j)-(i, j+1) and faces up", () => {
    const g = buildChunkGeometry(tile(0, 0), SIZE);
    const idx = g.getIndex()!.array;
    assert.deepEqual([...idx.slice(0, 6)], [0, 16, 1, 17, 1, 16]);
    const pos = g.getAttribute("position");
    const a = new THREE.Vector3().fromBufferAttribute(pos, idx[0]);
    const b = new THREE.Vector3().fromBufferAttribute(pos, idx[1]);
    const c = new THREE.Vector3().fromBufferAttribute(pos, idx[2]);
    const n = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a));
    assert.ok(n.y > 0, "front face points up");
    assert.equal(pos.getX(15), 16, "the tile spans the chunk edge to edge");
  });

  it("hangs inward-facing skirts below all four edges", () => {
    const g = buildChunkGeometry(tile(0, 0), SIZE);
    const pos = g.getAttribute("position");
    assert.equal(pos.count, 256 + 64);
    const idx = g.getIndex()!.array;
    const centre = new THREE.Vector3(8, 0, 8);
    let skirts = 0;
    for (let t = 15 * 15 * 6; t < idx.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, idx[t + k]));
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      const out = a.clone().add(b).add(c).divideScalar(3).sub(centre).setY(0);
      assert.ok(n.dot(out) < 0, `skirt triangle ${t / 3} faces into the tile`);
      assert.ok(Math.abs(n.y) < 1e-6, "vertical");
      skirts++;
    }
    assert.equal(skirts, 4 * 15 * 2);
    assert.ok(Math.abs(pos.getY(256) - (pos.getY(0) - SKIRT_DEPTH)) < 1e-4, "hangs SKIRT_DEPTH below its edge");
  });

  it("normals agree on a shared border when the neighbour is known", () => {
    const [left, right] = [tile(0, 0), tile(1, 0)];
    const nl = new Float32Array(768);
    const nr = new Float32Array(768);
    chunkNormals(left, (dx, dz) => (dx === 1 && dz === 0 ? right : null), STEP, nl);
    chunkNormals(right, (dx, dz) => (dx === -1 && dz === 0 ? left : null), STEP, nr);
    for (let j = 1; j < SIDE - 1; j++) {
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(nl[3 * (j * 16 + 15) + k] - nr[3 * (j * 16) + k]) < 1e-6, `row ${j}`);
      }
    }
    // Central difference inside a tile ~ the analytic slope.
    const i = 7;
    const j = 7;
    const dhdx = (surface(i + 1, j) - surface(i - 1, j)) / (2 * STEP);
    assert.ok(Math.abs(nl[3 * (j * 16 + i)] - -dhdx / Math.hypot(dhdx, 1, (surface(i, j + 1) - surface(i, j - 1)) / (2 * STEP))) < 1e-5);
  });
});

describe("TerrainRenderer", () => {
  const map = (): WorldMap => {
    const width = 20;
    const depth = 20;
    return {
      cell: 16, width, depth, originX: -160, originZ: -160,
      heights: Float32Array.from({ length: width * depth }, (_, i) => (i % width) * 12),
      biome: Uint8Array.from({ length: width * depth }, (_, i) => (i < 200 ? 0 : 1)),
      biomes: ["desert", "plains"],
      river: new Uint8Array(width * depth),
    };
  };
  const bounds = { minCx: -10, minCz: -10, maxCx: 9, maxCz: 9 };

  it("tracks chunks by wire id, upgrades a flat stand-in once, and masks the horizon under them", () => {
    const t = new TerrainRenderer(SIZE);
    t.setWorld({ map: map(), bounds });
    assert.ok(t.hasFar);
    t.ensureChunk(10n, row(2, -3, null));
    assert.equal(t.chunkCount, 1);
    assert.equal(t.maskedAt(2, -3), false, "a flat stand-in doesn't hide the horizon");
    t.ensureChunk(10n, row(2, -3, tile(2, -3)));
    assert.equal(t.maskedAt(2, -3), true, "real heights do");
    const before = t.normalsOf(2, -3);
    t.ensureChunk(10n, row(2, -3, tile(2, -3))); // every frame: no rebuild
    assert.equal(t.normalsOf(2, -3), before);
    t.ensureChunk(11n, row(3, -3, tile(3, -3)));
    assert.deepEqual([...t.chunkWireIds()].sort(), [10n, 11n]);
    t.removeChunk(10n);
    assert.equal(t.chunkCount, 1);
    assert.equal(t.maskedAt(2, -3), false);
    t.removeChunk(10n); // idempotent
    t.dispose();
  });

  it("recomputes a chunk's border normals when its neighbour arrives", () => {
    const t = new TerrainRenderer(SIZE);
    t.ensureChunk(1n, row(0, 0, tile(0, 0)));
    const oneSided = Float32Array.from(t.normalsOf(0, 0)!);
    t.ensureChunk(2n, row(1, 0, tile(1, 0)));
    const left = t.normalsOf(0, 0)!;
    const right = t.normalsOf(1, 0)!;
    const border = 3 * (7 * 16 + 15);
    assert.notEqual(left[border], oneSided[border], "border normal refined");
    assert.ok(Math.abs(left[border] - right[3 * (7 * 16)]) < 1e-6, "and equal on both sides");
    t.dispose();
  });

  it("a legacy world (no map) draws chunks only", () => {
    const t = new TerrainRenderer(SIZE);
    t.setWorld(null);
    t.ensureChunk(1n, row(0, 0, tile(0, 0)));
    assert.equal(t.hasFar, false);
    assert.equal(t.maskedAt(0, 0), false);
    t.dispose();
  });

  it("the far mesh has a vertex per map cell at its world position", () => {
    const m = map();
    const g = farGeometry(m);
    const pos = g.getAttribute("position");
    assert.equal(pos.count, m.width * m.depth);
    const k = 3 * m.width + 5;
    assert.deepEqual([pos.getX(k), pos.getY(k), pos.getZ(k)], [-160 + 5 * 16, 5 * 12, -160 + 3 * 16]);
    // Near the camera it sinks to its neighbourhood's low point (heights rise 12 m per cell in u).
    assert.equal(g.getAttribute("aDrop").getX(k), 12 + FAR_DROP_MARGIN);
  });
});

describe("ground colours and material", () => {
  it("colours cells by biome and darkens rivers toward mud", () => {
    const m: WorldMap = {
      cell: 16, width: 3, depth: 1, originX: 0, originZ: 0,
      heights: new Float32Array(3), biome: Uint8Array.of(0, 1, 5), biomes: ["desert", "mystery"],
      river: Uint8Array.of(0, 0, 1),
    };
    const c = groundColors(m);
    assert.deepEqual([...c.slice(0, 3)], [...BIOME_GROUND.desert]);
    assert.deepEqual([...c.slice(4, 7)], [...DEFAULT_GROUND], "unknown biome id");
    assert.ok(c[8] < DEFAULT_GROUND[0] + 1 && c[9] < DEFAULT_GROUND[1], "river cell muddier");
    assert.equal(snowLine(100), Infinity);
    assert.ok(snowLine(285) > 150 && snowLine(285) < 285);
  });

  it("injects the terrain shader, sharing live uniforms", () => {
    const uniforms = createTerrainUniforms();
    for (const far of [false, true]) {
      const material = createTerrainMaterial(uniforms, far);
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: "#include <common>\n#include <begin_vertex>",
        fragmentShader: "#include <common>\n#include <color_fragment>",
      } as unknown as THREE.WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
      assert.match(shader.fragmentShader, /tTriplanar/);
      assert.match(shader.vertexShader, /vTerrainPos =/);
      assert.equal(shader.uniforms.uSnowLine, uniforms.uSnowLine, "same uniform object");
      assert.equal(Boolean(material.defines?.TERRAIN_FAR !== undefined), far);
      assert.equal(material.transparent, false, "opaque");
      material.dispose();
    }
  });
});
