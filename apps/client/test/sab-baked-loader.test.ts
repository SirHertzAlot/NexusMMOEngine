/**
 * Baked Asset Store B3 client SAB placement & B3+B4 streaming integration tests.
 *
 * Covers:
 * 1. `bakedPlaceHandler` decoding baked `.chunk` SoA records into `SabArena`
 *    with slice deduplication and overflow detection.
 * 2. Zero-copy verification: `THREE.BufferGeometry` vertex & index attributes
 *    view the `SharedArrayBuffer` directly (`array.buffer === sab`).
 * 3. `SabBakedLoader` SAB path vs main-thread fallback equivalence & fallback
 *    when `crossOriginIsolated: false` or worker throws.
 * 4. Overflow single-retry path in `SabBakedLoader`.
 * 5. Full `WorkerRuntime` round-trip (`getTransferables` preserves `SharedArrayBuffer`).
 * 6. Combined B3 + B4 `ChunkedBakedAssetClient` + `SabBakedLoader.mountIntoProvider`
 *    streaming into `BakedAssetProvider`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as THREE from "three";
import {
  BakedAssetProvider,
  ChunkedBakedAssetClient,
  bakedAssetHash32,
  encodeBakedGeometryRecord,
  type BakedChunkManifest,
  type BakedStoreIndexManifest,
} from "@mmo-engine/art/browser";
import { SabArena, SabArenaState } from "../src/assets/sab-arena.js";
import { probeSabSupport } from "../src/assets/sab-support.js";
import { SabBakedLoader, sabBakedMeshes } from "../src/assets/sab-baked-loader.js";
import { bakedPlaceHandler, estimateBakedChunkSabBytes } from "../src/workers/handlers/baked-place.js";
import { WorkerRuntime, type WorkerScope } from "../src/workers/runtime.js";

const usableSupport = probeSabSupport({ SharedArrayBuffer, Worker: function () {}, crossOriginIsolated: true });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeBakedChunkFixture() {
  const quadPos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const quadNorm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const quadUv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const quadIdx = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const wedgePos = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const wedgeNorm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const wedgeUv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const wedgeIdx = new Uint32Array([0, 1, 2]);

  const blobQuad = encodeBakedGeometryRecord({ positions: quadPos, normals: quadNorm, uvs: quadUv, indices: quadIdx });
  const blobWedge = encodeBakedGeometryRecord({ positions: wedgePos, normals: wedgeNorm, uvs: wedgeUv, indices: wedgeIdx });

  const quadAligned = (blobQuad.byteLength + 3) & ~3;
  const wedgeAligned = (blobWedge.byteLength + 3) & ~3;
  const chunkBytes = new Uint8Array(quadAligned + wedgeAligned);
  chunkBytes.set(blobQuad, 0);
  chunkBytes.set(blobWedge, quadAligned);

  const [quadHash, wedgeHash, chunkHash] = await Promise.all([
    sha256Hex(blobQuad),
    sha256Hex(blobWedge),
    sha256Hex(chunkBytes),
  ]);

  const manifest: BakedChunkManifest = {
    version: 1,
    kit: "test-kit",
    target: "shipped-prototype-pack",
    chunkId: "base",
    chunkFile: `chunks/${chunkHash}.chunk`,
    chunkHash,
    chunkBytes: chunkBytes.byteLength,
    assets: [
      {
        id: "test/quad",
        assetHash: bakedAssetHash32("test/quad"),
        canonicalId: "test/quad",
        byteOffset: 0,
        byteLength: blobQuad.byteLength,
        blobHash: quadHash,
        licenceLane: "cc0",
        forShape: "0",
      },
      {
        id: "test/quad_alias",
        assetHash: bakedAssetHash32("test/quad_alias"),
        canonicalId: "test/quad",
        byteOffset: 0,
        byteLength: blobQuad.byteLength,
        blobHash: quadHash,
        licenceLane: "cc0",
      },
      {
        id: "test/wedge",
        assetHash: bakedAssetHash32("test/wedge"),
        canonicalId: "test/wedge",
        byteOffset: quadAligned,
        byteLength: blobWedge.byteLength,
        blobHash: wedgeHash,
        licenceLane: "cc0",
      },
    ],
    rejected: [],
  };

  return { manifest, chunkBytes, quadPos, quadNorm, quadUv, quadIdx, wedgePos };
}

function createInMemoryWorkerPair(): { clientScope: WorkerScope; workerScope: WorkerScope } {
  const mkScope = (): WorkerScope & { listeners: Set<(e: any) => void>; peer?: any } => {
    const listeners = new Set<(e: any) => void>();
    return {
      onmessage: null,
      onerror: null,
      listeners,
      addEventListener(type, fn) {
        if (type === "message") listeners.add(fn);
      },
      removeEventListener(type, fn) {
        if (type === "message") listeners.delete(fn);
      },
      postMessage(message) {
        queueMicrotask(() => {
          const ev = { data: message } as MessageEvent;
          this.peer.onmessage?.(ev);
          for (const fn of this.peer.listeners) fn(ev);
        });
      },
    };
  };
  const clientScope = mkScope();
  const workerScope = mkScope();
  clientScope.peer = workerScope;
  workerScope.peer = clientScope;
  return { clientScope, workerScope };
}

describe("B3 client SAB baked placement", () => {
  it("places SoA geometry into SabArena with zero-copy views and deduped aliases", async () => {
    const { manifest, chunkBytes, quadPos, quadNorm, quadUv, quadIdx } = await makeBakedChunkFixture();
    const estimate = estimateBakedChunkSabBytes(manifest.assets);
    const arena = SabArena.create(estimate + 64 + 1024);

    const res = await bakedPlaceHandler.handle({
      chunkId: manifest.chunkId,
      chunk: chunkBytes.slice().buffer as ArrayBuffer,
      assets: manifest.assets,
      sab: arena.sab,
    });
    assert.ok(!("overflow" in res));
    assert.equal(arena.state, SabArenaState.Ready);

    const { meshes } = sabBakedMeshes(arena.sab, res);
    const quadMesh = meshes.get("test/quad")!;
    const aliasMesh = meshes.get("test/quad_alias")!;
    const wedgeMesh = meshes.get("test/wedge")!;

    assert.equal(quadMesh.geometry.getAttribute("position").array.buffer, arena.sab);
    assert.equal(quadMesh.geometry.getAttribute("normal").array.buffer, arena.sab);
    assert.equal(quadMesh.geometry.getAttribute("uv").array.buffer, arena.sab);
    assert.equal(quadMesh.geometry.getIndex()!.array.buffer, arena.sab);
    assert.equal(quadMesh.geometry, aliasMesh.geometry, "canonical duplicate shares geometry in SAB");
    assert.notEqual(quadMesh.geometry, wedgeMesh.geometry);

    assert.deepEqual([...(quadMesh.geometry.getAttribute("position").array as Float32Array)], [...quadPos]);
    assert.deepEqual([...(quadMesh.geometry.getAttribute("normal").array as Float32Array)], [...quadNorm]);
    assert.deepEqual([...(quadMesh.geometry.getAttribute("uv").array as Float32Array)], [...quadUv]);
    assert.deepEqual([...(quadMesh.geometry.getIndex()!.array as Uint32Array)], [...quadIdx]);
  });

  it("SabBakedLoader SAB worker path & main-thread fallback produce identical geometry + handles overflow retry", async () => {
    const { manifest, chunkBytes } = await makeBakedChunkFixture();

    // Real WorkerRuntime round-trip exercising WorkerRuntime.getTransferables
    const { clientScope, workerScope } = createInMemoryWorkerPair();
    const workerRuntime = new WorkerRuntime({}, workerScope);
    workerRuntime.registerHandler("bakedPlace", bakedPlaceHandler);
    const clientRuntime = new WorkerRuntime({}, clientScope);

    const sabLoader = new SabBakedLoader({ workers: clientRuntime, support: usableSupport });
    const viaSab = await sabLoader.placeChunkBytes(manifest, chunkBytes);
    assert.equal(viaSab.via, "sab-worker");
    assert.ok(viaSab.sab instanceof SharedArrayBuffer);
    assert.ok((viaSab.sabBytes ?? 0) > 0);
    assert.equal(viaSab.meshes.get("test/quad")!.geometry.getAttribute("position").array.buffer, viaSab.sab);

    // Main-thread fallback when crossOriginIsolated is false or worker fails
    const noIsolation = probeSabSupport({ SharedArrayBuffer, Worker: function () {}, crossOriginIsolated: false });
    const fallback1 = await new SabBakedLoader({ workers: clientRuntime, support: noIsolation }).placeChunkBytes(manifest, chunkBytes);
    assert.equal(fallback1.via, "main-thread");

    const brokenWorker = { request: async () => { throw new Error("worker crashed"); } } as any;
    const fallback2 = await new SabBakedLoader({ workers: brokenWorker, support: usableSupport }).placeChunkBytes(manifest, chunkBytes);
    assert.equal(fallback2.via, "main-thread");

    assert.deepEqual(
      [...(viaSab.meshes.get("test/wedge")!.geometry.getAttribute("position").array as Float32Array)],
      [...(fallback1.meshes.get("test/wedge")!.geometry.getAttribute("position").array as Float32Array)],
    );

    // Handler overflow detection + loader single-retry
    const tiny = SabArena.create(64 + 8);
    const overflow = await bakedPlaceHandler.handle({
      chunkId: manifest.chunkId,
      chunk: chunkBytes.slice().buffer as ArrayBuffer,
      assets: manifest.assets,
      sab: tiny.sab,
    });
    assert.ok("overflow" in overflow && overflow.overflow);
    assert.equal(tiny.state, SabArenaState.Error);

    let calls = 0;
    const flakyWorkers: any = {
      request: async (_t: string, p: any) => {
        calls++;
        if (calls === 1) return { overflow: true, neededBytes: 8192 };
        return bakedPlaceHandler.handle(p);
      },
    };
    const retried = await new SabBakedLoader({ workers: flakyWorkers, support: usableSupport }).placeChunkBytes(manifest, chunkBytes);
    assert.equal(retried.via, "sab-worker");
    assert.equal(calls, 2);
  });

  it("integrates B3 SabBakedLoader with B4 ChunkedBakedAssetClient into BakedAssetProvider", async () => {
    const { manifest, chunkBytes } = await makeBakedChunkFixture();
    const { clientScope, workerScope } = createInMemoryWorkerPair();
    const workerRuntime = new WorkerRuntime({}, workerScope);
    workerRuntime.registerHandler("bakedPlace", bakedPlaceHandler);
    const clientRuntime = new WorkerRuntime({}, clientScope);

    const sabLoader = new SabBakedLoader({ workers: clientRuntime, support: usableSupport });
    const provider = new BakedAssetProvider();

    const index: BakedStoreIndexManifest = {
      version: 1,
      target: "shipped-prototype-pack",
      baseChunkId: "base",
      chunks: [
        {
          chunkId: "base",
          kind: "base",
          chunkFile: manifest.chunkFile,
          manifestFile: "manifests/base.baked.json",
          chunkHash: manifest.chunkHash,
          chunkBytes: manifest.chunkBytes,
          assetCount: manifest.assets.length,
          assetIds: manifest.assets.map((a) => a.id),
        },
      ],
      assetToChunk: Object.fromEntries(manifest.assets.map((a) => [a.id, "base"])),
    };

    const placedResults: Array<SharedArrayBuffer | null> = [];
    const stream = new ChunkedBakedAssetClient({
      provider,
      index,
      fetchJson: async () => manifest,
      fetchBinary: async () => chunkBytes.slice(),
      mountChunk: async (m, b) => {
        const res = await sabLoader.mountIntoProvider(provider, m, b);
        placedResults.push(res.sab);
      },
    });

    await stream.boot();
    assert.equal(placedResults.length, 1);
    const lastSab = placedResults[0];
    assert.ok(lastSab instanceof SharedArrayBuffer);
    const mesh = provider.assetMesh({
      wireId: 7n,
      assetHash: bakedAssetHash32("test/quad"),
      variant: 0,
    }) as THREE.Mesh;
    assert.ok(mesh);
    assert.equal(mesh.geometry.getAttribute("position").array.buffer, lastSab);
  });
});
