/**
 * Cooked PCG models on the client: InstancedProps moves a prop from its
 * placeholder into its asset's model batch when the mesh arrives, and
 * PcgMeshes fetches each (asset, variant index, revision) once through the
 * Pcg webrpc client and decodes it into geometry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { BodyConfigRow, TransformRow } from "@mmo-engine/protocol";
import { PcgRpcClient } from "@mmo-engine/picg";
import { InstancedProps, type PropModels } from "../src/render/instanced-props.js";
import { PcgMeshes, pcgGeometry } from "../src/render/pcg-meshes.js";

const at = (wireId: bigint, x: number): TransformRow => ({ wireId, px: x, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 });
const body = (wireId: bigint): BodyConfigRow => ({
  wireId, shapeKind: 0, halfX: 0.5, halfY: 2, halfZ: 0.5, radius: 0.5, mass: 0, friction: 0.5, restitution: 0, motionType: 0, layer: 0,
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

describe("InstancedProps with cooked models", () => {
  it("draws placeholders until a model is ready, then moves the prop into the model's batch", () => {
    let ready: THREE.BufferGeometry | null = null;
    const models: PropModels = { model: (hash) => (hash === 7 && ready ? { key: "7:0:1", geometry: ready } : null) };
    const props = new InstancedProps(models);
    props.add(1n, at(1n, 5), body(1n), new THREE.Color(1, 0, 0), { assetHash: 7, variant: 4 });
    props.add(2n, at(2n, 9), null, new THREE.Color(0, 1, 0), { assetHash: 8, variant: 0 });
    assert.equal(props.cookedCount, 0);
    ready = pcgGeometry(triangleBytes());
    props.modelsChanged();
    assert.equal(props.cookedCount, 1, "asset 7 is cooked; asset 8 stays a placeholder");
    const batch = props.group.children.find((m) => m.name === "props model:7:0:1") as THREE.InstancedMesh;
    assert.ok(batch && batch.count === 1);
    const m = new THREE.Matrix4();
    batch.getMatrixAt(0, m);
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    assert.deepEqual([s.x, s.y, s.z], [1, 1, 1], "a model is drawn at its Transform, not scaled to the body");
    const c = new THREE.Color();
    batch.getColorAt(0, c);
    assert.deepEqual([c.r, c.g, c.b], [1, 1, 1], "its own vertex colours show untinted");
    props.dispose();
  });
});

describe("pcgGeometry", () => {
  it("builds indexed geometry with linear vertex colours", () => {
    const g = pcgGeometry(triangleBytes());
    assert.equal(g.getAttribute("position").count, 3);
    assert.equal(g.getIndex()!.count, 3);
    const color = g.getAttribute("color");
    assert.equal(color.itemSize, 3);
    assert.ok(Math.abs(color.getY(0) - new THREE.Color().setRGB(1, 0.5, 0, THREE.SRGBColorSpace).g) < 1e-6);
    assert.ok(g.getAttribute("normal"), "normals computed when the mesh has none");
  });
});

describe("PcgMeshes", () => {
  it("lists assets, then fetches each shape once and reports it ready", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace("http://region", "")} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`);
      if (url.endsWith("/rpc/Pcg/ListAssets")) {
        return new Response(JSON.stringify({ assets: [{ id: "oak", assetHash: 7, displayName: "Oak", graph: "g", variants: 4, revision: 3 }] }));
      }
      if (url.endsWith("/rpc/Pcg/GetAssetMesh")) {
        const args = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ mesh: { assetHash: 7, variantIndex: args.variant, revision: 3, url: `/pcg/mesh/7/${args.variant}/3`, vertexCount: 3, triangleCount: 1 } }));
      }
      return new Response(triangleBytes());
    };
    let changes = 0;
    const meshes = new PcgMeshes(new PcgRpcClient("http://region", () => "tok", fake), () => changes++);
    assert.equal(meshes.model(7, 5), null, "nothing yet: starts the listing");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(changes, 1, "listing done");
    assert.equal(meshes.model(7, 5), null, "starts the mesh fetch");
    assert.equal(meshes.model(7, 1), null, "same shape (5 % 4 = 1): no second fetch");
    assert.equal(meshes.model(99, 0), null, "not a PCG asset");
    await new Promise((r) => setTimeout(r, 10));
    const model = meshes.model(7, 9);
    assert.ok(model, "ready");
    assert.equal(model.key, "7:1:3");
    assert.deepEqual(calls, [
      "POST /rpc/Pcg/ListAssets Bearer tok",
      "POST /rpc/Pcg/GetAssetMesh Bearer tok",
      "GET /pcg/mesh/7/1/3 Bearer tok",
    ]);
    meshes.dispose();
  });
});
