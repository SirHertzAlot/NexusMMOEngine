import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as THREE from "three";
import { z } from "zod";
import type { BodyConfigRow, ChunkRow } from "@mmo-engine/protocol";
import { ManifestAssetProvider, placeholderColor } from "../src/provider.js";

function makeBody(overrides: Partial<BodyConfigRow> = {}): BodyConfigRow {
  return {
    wireId: 7n,
    shapeKind: 0,
    halfX: 0.5,
    halfY: 1,
    halfZ: 0.5,
    radius: 0.5,
    mass: 1,
    motionType: 0,
    layer: 0,
    friction: 0.5,
    restitution: 0,
    ...overrides,
  };
}

function makeChunk(cx: number, cz: number, heights: Float32Array | null = null): ChunkRow {
  const lo = cz < 0 ? 0x100000000 + cz : cz;
  return { wireId: 1n, chunkId: (BigInt(cx) << 32n) | BigInt(lo), seed: 0n, lod: 0, heights };
}

/** Minimal JSON-only GLB (empty scene): parseable with no DOM needed. */
function makeMinimalGlb(): Buffer {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{}],
  });
  const jsonBytes = Buffer.from(json, "utf8");
  const total = 12 + 8 + jsonBytes.length;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0x46546c67, 0); // "glTF"
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(total, 8);
  buf.writeUInt32LE(jsonBytes.length, 12);
  buf.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  jsonBytes.copy(buf, 20);
  return buf;
}

/** Serves one model; everything else 404s (exercises the fallback path). */
async function startPackServer(glb: Buffer): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/models/prop.glb") {
      res.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": glb.length });
      res.end(glb);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/` };
}

// ShapeKind.Sphere === 1 (see @mmo-engine/schema); forShape matches String(shapeKind).
const MANIFEST = {
  name: "test-pack",
  version: "1.0.0",
  models: [
    { id: "prop", file: "models/prop.glb", forShape: "1" },
    { id: "ghost", file: "models/ghost.glb" },
  ],
  textures: [{ id: "terrain", file: "textures/terrain.png", forTerrain: true }],
};

describe("ManifestAssetProvider", () => {
  it("loads a served model, reports status, and serves clones from bodyMesh", async (t) => {
    const { server, baseUrl } = await startPackServer(makeMinimalGlb());
    t.after(() => server.close());
    const provider = new ManifestAssetProvider({ baseUrl, manifest: MANIFEST });

    await provider.loadAssetPack(baseUrl);
    // Second call: loaded entries are skipped, nothing blows up.
    await provider.loadAssetPack(baseUrl);

    const status = new Map(provider.fallbackStatus().map((s) => [s.id, s]));
    assert.equal(status.get("prop")?.status, "loaded");
    assert.equal(status.get("ghost")?.status, "fallback");
    assert.match(status.get("ghost")?.diagnostic ?? "", /ghost/);
    assert.equal(status.get("terrain")?.status, "fallback");

    // ShapeKind 1 (Sphere) maps to the loaded "prop" model via forShape "1".
    const a = provider.bodyMesh(makeBody({ shapeKind: 1 }));
    const b = provider.bodyMesh(makeBody({ shapeKind: 1 }));
    assert.ok(a instanceof THREE.Object3D);
    assert.equal(a.type, "Group"); // the glTF scene, not a placeholder Mesh
    assert.notEqual(a, b); // clones: distinct nodes...

    // ...but a body with no forShape mapping gets a procedural placeholder.
    const placeholder = provider.bodyMesh(makeBody({ shapeKind: 0 }));
    assert.equal(placeholder.type, "Mesh");
  });

  it("uses a sphere placeholder for Sphere bodies without a mapped model", () => {
    const provider = new ManifestAssetProvider({ baseUrl: "http://127.0.0.1:1/", manifest: MANIFEST });
    const mesh = provider.bodyMesh(makeBody({ shapeKind: 1, radius: 2 })) as THREE.Mesh;
    assert.equal(mesh.geometry.type, "SphereGeometry");
    const box = provider.bodyMesh(makeBody({ shapeKind: 0 })) as THREE.Mesh;
    assert.equal(box.geometry.type, "BoxGeometry");
  });

  it("colors placeholders deterministically from the wire id", () => {
    const provider = new ManifestAssetProvider({ baseUrl: "http://127.0.0.1:1/", manifest: MANIFEST });
    const colorOf = (wireId: bigint): number =>
      ((provider.bodyMesh(makeBody({ wireId })) as THREE.Mesh).material as THREE.MeshStandardMaterial)
        .color.getHex();
    assert.equal(colorOf(42n), colorOf(42n));
    assert.equal(colorOf(42n), placeholderColor(42n).getHex());
  });

  it("terrainMesh displaces vertices from chunk heights (null heights stay flat)", () => {
    const provider = new ManifestAssetProvider({ baseUrl: "http://127.0.0.1:1/", manifest: MANIFEST });
    const heights = new Float32Array(256);
    for (let v = 0; v < 256; v++) heights[v] = v * 0.1 - 5;
    const mesh = provider.terrainMesh(makeChunk(0, 0, heights), 16) as THREE.Mesh;
    const pos = (mesh.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
    assert.equal(pos.count, 256);
    for (let v = 0; v < 256; v++) {
      assert.ok(Math.abs(pos.getY(v) - heights[v]) < 1e-6, `vertex ${v}`);
    }
    // Vertex 0 sits at the chunk's (x0, z0) corner: sample (0,0).
    // 16 samples span the full 16-unit chunk (seamless tiling).
    assert.equal(pos.getX(0), -8);
    assert.equal(pos.getZ(0), -8);

    const flat = provider.terrainMesh(makeChunk(0, 0), 16) as THREE.Mesh;
    const flatPos = (flat.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
    // rotateX(-π/2) leaves ~1e-16 residue on the plane's Y — compare loosely.
    for (let v = 0; v < 256; v++) assert.ok(Math.abs(flatPos.getY(v)) < 1e-9);
  });

  it("terrainMesh returns a chunk-positioned plane (plain material without a terrain texture)", () => {
    const provider = new ManifestAssetProvider({ baseUrl: "http://127.0.0.1:1/", manifest: MANIFEST });
    const mesh = provider.terrainMesh(makeChunk(2, -3), 16) as THREE.Mesh;
    assert.ok(mesh instanceof THREE.Object3D);
    assert.equal(mesh.geometry.type, "PlaneGeometry");
    // 16 samples span the full 16-unit chunk (seamless tiling, no gaps):
    // the mesh is centered at cx*16 + 8 so sample (i,j) sits at
    // (cx*16+i*16/15, cz*16+j*16/15).
    assert.equal(mesh.position.x, 2 * 16 + 8);
    assert.equal(mesh.position.z, -3 * 16 + 8);
    assert.equal((mesh.material as THREE.MeshStandardMaterial).map, null);
  });

  it("unreachable pack URL: resolves without throwing, everything falls back", async () => {
    const provider = new ManifestAssetProvider({ baseUrl: "http://127.0.0.1:1/", manifest: MANIFEST });
    // Connection refused fails fast; must never reject the whole pack.
    await provider.loadAssetPack("http://127.0.0.1:1/");

    const statuses = provider.fallbackStatus();
    assert.equal(statuses.length, 3);
    assert.ok(statuses.every((s) => s.status === "fallback"));
    assert.ok(statuses.every((s) => typeof s.diagnostic === "string" && s.diagnostic.length > 0));

    // Placeholders still work: the game renders with zero art.
    assert.ok(provider.bodyMesh(makeBody()) instanceof THREE.Object3D);
    assert.ok(provider.terrainMesh(makeChunk(0, 0), 16) instanceof THREE.Object3D);
  });

  it("constructor rejects a manifest with an unsafe path", () => {
    assert.throws(
      () =>
        new ManifestAssetProvider({
          baseUrl: "http://127.0.0.1:1/",
          manifest: {
            name: "evil",
            version: "1.0.0",
            models: [{ id: "e", file: "../evil.glb" }],
            textures: [],
          },
        }),
      z.ZodError,
    );
  });
});
