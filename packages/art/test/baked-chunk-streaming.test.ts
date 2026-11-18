/**
 * Baked Asset Store B4 chunked delivery & on-demand streaming tests.
 *
 * Proves:
 * 1. `bakeMultiChunkBundle` splits assets across `base`, `kit:*`, and `region:*` chunks
 *    and emits `index.baked.json` + per-chunk manifests/chunks + SQLite `store.sqlite`.
 * 2. Fresh client boot fetches ONLY `base` (`1` chunk) and zero region/kit chunks.
 * 3. Entering a region or requesting an asset streams only the required chunk on demand,
 *    with idempotent deduplication (`0` re-downloads across repeats or concurrent calls).
 * 4. Tampered chunk bytes fail closed on SHA-256 verification and are never mounted.
 * 5. Deterministic re-bake produces identical chunk hashes and `index.baked.json`.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BakedAssetProvider,
  BakedStoreIndexManifestSchema,
  ChunkedBakedAssetClient,
  bakedAssetHash32,
  bakeMultiChunkBundle,
  lookupAssetChunk,
  resolveRegionChunkId,
  type ChunkKind,
} from "../src/index.js";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeAssetFile(root: string, rel: string, bytes: Uint8Array | string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function makeGlbChunk(type: string, data: Uint8Array, padByte = 0): Uint8Array {
  const out = new Uint8Array(8 + pad4(data.byteLength));
  out.fill(padByte);
  new DataView(out.buffer).setUint32(0, pad4(data.byteLength), true);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function buildTriangleGlb(opts: { scale: number; color?: [number, number, number, number]; requireExtension?: string }): Uint8Array {
  const s = opts.scale;
  const positions = new Float32Array([0, 0, 0, s, 0, 0, 0, s, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);

  const posBytes = new Uint8Array(positions.buffer);
  const nrmBytes = new Uint8Array(normals.buffer);
  const uvBytes = new Uint8Array(uvs.buffer);
  const idxBytes = new Uint8Array(indices.buffer);
  const bin = new Uint8Array(posBytes.byteLength + nrmBytes.byteLength + uvBytes.byteLength + pad4(idxBytes.byteLength));
  let off = 0;
  const posOff = off; bin.set(posBytes, off); off += posBytes.byteLength;
  const nrmOff = off; bin.set(nrmBytes, off); off += nrmBytes.byteLength;
  const uvOff = off; bin.set(uvBytes, off); off += uvBytes.byteLength;
  const idxOff = off; bin.set(idxBytes, off);

  const gltf: Record<string, unknown> = {
    asset: { version: "2.0" },
    ...(opts.requireExtension ? { extensionsRequired: [opts.requireExtension], extensionsUsed: [opts.requireExtension] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: opts.color ?? [0.7, 0.5, 0.3, 1], roughnessFactor: 0.6, metallicFactor: 0.1 } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: posOff, byteLength: posBytes.byteLength },
      { buffer: 0, byteOffset: nrmOff, byteLength: nrmBytes.byteLength },
      { buffer: 0, byteOffset: uvOff, byteLength: uvBytes.byteLength },
      { buffer: 0, byteOffset: idxOff, byteLength: idxBytes.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  };

  const jsonChunk = makeGlbChunk("JSON", new TextEncoder().encode(JSON.stringify(gltf)), 0x20);
  const binChunk = makeGlbChunk("BIN\0", bin, 0x00);
  const out = new Uint8Array(12 + jsonChunk.byteLength + binChunk.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.byteLength, true);
  out.set(jsonChunk, 12);
  out.set(binChunk, 12 + jsonChunk.byteLength);
  return out;
}

describe("B4 chunked delivery & on-demand streaming", () => {
  it("boots with base chunk only, streams region chunks on demand without re-downloads, and rejects tampered chunks", async () => {
    const srcRoot = makeTempDir("b4-src-");
    const outA = makeTempDir("b4-outA-");
    const outB = makeTempDir("b4-outB-");

    writeAssetFile(srcRoot, "models/spawn_pillar.glb", buildTriangleGlb({ scale: 1.0 }));
    writeAssetFile(srcRoot, "models/r0_oak.glb", buildTriangleGlb({ scale: 2.0 }));
    writeAssetFile(srcRoot, "models/r1_ruin.glb", buildTriangleGlb({ scale: 3.0 }));
    writeAssetFile(srcRoot, "models/bad_mesh.glb", buildTriangleGlb({ scale: 1.0, requireExtension: "EXT_meshopt_compression" }));

    const manifest = {
      name: "world-bundle",
      version: "1.0.0",
      models: [
        { id: "base/spawn_pillar", file: "models/spawn_pillar.glb" },
        { id: "region00/oak", file: "models/r0_oak.glb" },
        { id: "region10/ruin", file: "models/r1_ruin.glb" },
        { id: "base/bad_mesh", file: "models/bad_mesh.glb" },
      ],
      textures: [],
    };
    const assetLicences = {
      "base/spawn_pillar": { name: "CC0 1.0", author: "Studio" },
      "region00/oak": { name: "CC BY 4.0", author: "Artist", credit: "Artist" },
      "region10/ruin": { name: "CC BY 4.0", author: "Artist", credit: "Artist" },
      "base/bad_mesh": { name: "CC0 1.0", author: "Studio" },
    };

    const assignChunk = (asset: { id: string }): ChunkKind => {
      if (asset.id.startsWith("region00/")) return "region:0_0";
      if (asset.id.startsWith("region10/")) return "region:1_0";
      return "base";
    };

    const resA = bakeMultiChunkBundle({
      assetsRoot: srcRoot,
      outDir: outA,
      target: "shipped-prototype-pack",
      manifest,
      assetLicences,
      assignChunk,
    });
    const resB = bakeMultiChunkBundle({
      assetsRoot: srcRoot,
      outDir: outB,
      target: "shipped-prototype-pack",
      manifest,
      assetLicences,
      assignChunk,
    });

    try {
      // Deterministic rebuild check across outA & outB
      assert.deepEqual(resA.index, resB.index);
      BakedStoreIndexManifestSchema.parse(JSON.parse(readFileSync(resA.indexPath, "utf8")));
      assert.equal(resA.chunks.map((c) => c.chunkRow.id).join(","), "base,region:0_0,region:1_0");
      assert.equal(resA.bakedCount, 3);
      assert.equal(resA.rejectedCount, 1);
      assert.equal(lookupAssetChunk(resA.store, "base/spawn_pillar")?.chunkId, "base");
      assert.equal(lookupAssetChunk(resA.store, "region00/oak")?.chunkId, "region:0_0");
      assert.equal(lookupAssetChunk(resA.store, "region10/ruin")?.chunkId, "region:1_0");

      // Fresh client with fetch instrumentation
      const requestedUrls: string[] = [];
      const fetchJson = async (url: string) => {
        requestedUrls.push(url);
        const rel = url.replace(/^\/baked\//, "");
        return JSON.parse(readFileSync(join(outA, rel), "utf8"));
      };
      const fetchBinary = async (url: string) => {
        requestedUrls.push(url);
        const rel = url.replace(/^\/baked\//, "");
        return new Uint8Array(readFileSync(join(outA, rel)));
      };

      const provider = new BakedAssetProvider();
      const client = new ChunkedBakedAssetClient({
        provider,
        baseUrl: "/baked/",
        fetchJson,
        fetchBinary,
      });

      // 1. Boot fetches ONLY index + base chunk (no region chunks)
      await client.boot();
      assert.deepEqual(client.loadedChunkIds(), ["base"]);
      assert.equal(client.fetchedChunkCount, 1);
      assert.ok(requestedUrls.some((u) => u.endsWith("index.baked.json")));
      assert.ok(requestedUrls.some((u) => u.includes("base.baked.json")));
      assert.ok(!requestedUrls.some((u) => u.includes("region")), "boot must not fetch region chunks");

      assert.ok(provider.assetMesh({ wireId: 1n, assetHash: bakedAssetHash32("base/spawn_pillar"), variant: 0 }));
      assert.equal(provider.assetMesh({ wireId: 2n, assetHash: bakedAssetHash32("region00/oak"), variant: 0 }), undefined);
      assert.equal(provider.assetMesh({ wireId: 3n, assetHash: bakedAssetHash32("region10/ruin"), variant: 0 }), undefined);

      // Rejected asset is tracked on base fallbackStatus
      const statuses = provider.fallbackStatus();
      assert.equal(statuses.find((s) => s.id === "base/bad_mesh")?.status, "fallback");

      // 2. Entering region (64, 64) -> region:0_0 streams ONLY region:0_0
      requestedUrls.length = 0;
      const enteredChunk = resolveRegionChunkId(64, 64, 128);
      assert.equal(enteredChunk, "region:0_0");
      await client.ensureRegion(enteredChunk);
      assert.deepEqual(client.loadedChunkIds(), ["base", "region:0_0"]);
      assert.equal(client.fetchedChunkCount, 2);
      assert.equal(requestedUrls.filter((u) => u.endsWith(".chunk")).length, 1);
      assert.ok(provider.assetMesh({ wireId: 2n, assetHash: bakedAssetHash32("region00/oak"), variant: 0 }));
      assert.equal(provider.assetMesh({ wireId: 3n, assetHash: bakedAssetHash32("region10/ruin"), variant: 0 }), undefined);

      // 3. Re-requesting loaded region performs ZERO network fetches; ensureAsset streams region:1_0 once
      requestedUrls.length = 0;
      await client.ensureRegion("0_0");
      assert.equal(requestedUrls.length, 0, "repeat request for loaded chunk must not hit network");

      const [a1, a2] = await Promise.all([
        client.ensureAsset("region10/ruin"),
        client.ensureRegion("1_0"),
      ]);
      assert.equal(a1, "region:1_0");
      assert.equal(a2.chunkId, "region:1_0");
      assert.equal(requestedUrls.filter((u) => u.endsWith(".chunk")).length, 1, "inflight calls share one download");
      assert.ok(provider.assetMesh({ wireId: 3n, assetHash: bakedAssetHash32("region10/ruin"), variant: 0 }));

      // 4. Tampered chunk fails SHA-256 verification and is never mounted
      const region0Entry = resA.index.chunks.find((c) => c.chunkId === "region:0_0")!;
      const provider2 = new BakedAssetProvider();
      const tamperedClient = new ChunkedBakedAssetClient({
        provider: provider2,
        baseUrl: "/baked/",
        fetchJson,
        fetchBinary: async (url) => {
          const bytes = await fetchBinary(url);
          if (url.endsWith(region0Entry.chunkFile) && bytes.byteLength > 0) {
            bytes[0] ^= 0xff;
          }
          return bytes;
        },
      });
      await tamperedClient.boot();
      await assert.rejects(tamperedClient.ensureRegion("0_0"), /SHA-256 mismatch/);
      assert.equal(provider2.hasChunk("region:0_0"), false);
      assert.ok(tamperedClient.failedChunks().has("region:0_0"));
      assert.equal(provider2.assetMesh({ wireId: 4n, assetHash: bakedAssetHash32("region00/oak"), variant: 0 }), undefined);
    } finally {
      resA.store.close();
      resB.store.close();
    }
  });
});
