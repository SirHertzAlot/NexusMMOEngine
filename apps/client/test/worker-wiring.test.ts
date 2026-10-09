import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PcgRpcClient } from "@mmo-engine/picg";
import { ensureBoundsTreeAsync } from "../src/render/bvh.js";
import { PcgMeshes, pcgGeometry } from "../src/render/pcg-meshes.js";
import { bvhHandler } from "../src/workers/handlers/bvh.js";
import { pcgHandler } from "../src/workers/handlers/pcg.js";

const grid = (n: number) => {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.set([i, 0, j], (j * (n + 1) + i) * 3);
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  return g;
};

describe("ensureBoundsTreeAsync", () => {
  const workers: any = { request: (_t: string, p: any) => bvhHandler.handle(p) };

  it("gives a big geometry a working tree, built from copies of its arrays", async () => {
    const g = grid(8);
    const before = g.getAttribute("position").array;
    await ensureBoundsTreeAsync(g, workers);
    assert.ok(g.boundsTree);
    assert.equal(g.getAttribute("position").array, before);
    const ray = new THREE.Ray(new THREE.Vector3(3.5, 2, 4.5), new THREE.Vector3(0, -1, 0));
    assert.equal(g.boundsTree!.raycastFirst(ray, THREE.DoubleSide)?.distance, 2);
  });

  it("leaves a small geometry alone, and survives a failing worker", async () => {
    const small = grid(2);
    await ensureBoundsTreeAsync(small, workers);
    assert.equal(small.boundsTree, undefined);
    const big = grid(8);
    await ensureBoundsTreeAsync(big, { request: async () => { throw new Error("down"); } } as any);
    assert.equal(big.boundsTree, undefined);
  });
});

/** A one-triangle PCGM (v2, with colours). */
function triangleBytes(): ArrayBuffer {
  const buf = new ArrayBuffer(20 + 36 + 12 + 48);
  const v = new DataView(buf);
  let o = 0;
  const u32 = (x: number) => { v.setUint32(o, x, true); o += 4; };
  const f32 = (x: number) => { v.setFloat32(o, x, true); o += 4; };
  u32(0x4d474350); u32(2); u32(3); u32(3); u32(2);
  [0, 0, 0, 1, 0, 0, 0, 3, 0].forEach(f32);
  [0, 1, 2].forEach(u32);
  for (let i = 0; i < 3; i++) { f32(1); f32(0.5); f32(0); f32(1); }
  return buf;
}

describe("PcgMeshes with workers", () => {
  it("decodes through the worker to the same geometry as inline", async () => {
    const asked: string[] = [];
    const workers: any = { request: async (t: string, p: any) => (asked.push(t), pcgHandler.handle(p)) };
    const fake: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/rpc/Pcg/ListAssets")) return new Response(JSON.stringify({ assets: [{ id: "oak", assetHash: 7, displayName: "Oak", graph: "g", variants: 1, revision: 3 }] }));
      if (url.endsWith("/rpc/Pcg/GetAssetMesh")) return new Response(JSON.stringify({ mesh: { assetHash: 7, variantIndex: 0, revision: 3, url: "/m", vertexCount: 3, triangleCount: 1 } }));
      return new Response(triangleBytes());
    };
    const meshes = new PcgMeshes(new PcgRpcClient("http://region", () => "tok", fake), () => {}, () => 0, workers);
    meshes.model(7, 0);
    await new Promise((r) => setTimeout(r, 10));
    meshes.model(7, 0);
    await new Promise((r) => setTimeout(r, 10));
    const g = meshes.model(7, 0)!.geometry;
    const inline = pcgGeometry(triangleBytes());
    assert.deepEqual(asked, ["pcg"]);
    assert.deepEqual(g.getAttribute("color").array, inline.getAttribute("color").array);
    assert.deepEqual(g.getAttribute("position").array, inline.getAttribute("position").array);
    meshes.dispose();
  });
});
