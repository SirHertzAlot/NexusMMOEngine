import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  BakedAssetProvider,
  BakedStoreValidationError,
  bakedAssetHash32,
  bakeKitGeometry,
  decodeBakedGeometryRecord,
  encodeBakedGeometryRecord,
  extractGlbGeometry,
  lookupAssetChunk,
} from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const REAL_ASSETS_DIR = join(REPO_ROOT, "assets");
const REAL_CREDITS_PATH = join(REPO_ROOT, "content", "credits.json");

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, bytes: Uint8Array | string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

/** Build a valid glTF 2.0 binary (`.glb`) in memory for deterministic geometry extraction tests. */
function makeSyntheticTriangleGlb(opts: {
  scale?: number;
  indexed?: boolean;
  omitNormals?: boolean;
  baseColorFactor?: [number, number, number, number];
  requireExtension?: string;
} = {}): Buffer {
  const scale = opts.scale ?? 1;
  const indexed = opts.indexed ?? true;
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]);
  const norm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2]);

  const chunks: Buffer[] = [Buffer.from(pos.buffer)];
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [
    { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
  ];
  let byteOffset = pos.byteLength;

  const attributes: Record<string, number> = { POSITION: 0 };
  const accessors: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
  }> = [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }];

  if (!opts.omitNormals) {
    bufferViews.push({ buffer: 0, byteOffset, byteLength: norm.byteLength });
    chunks.push(Buffer.from(norm.buffer));
    attributes.NORMAL = accessors.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 3, type: "VEC3" });
    byteOffset += norm.byteLength;
  }

  bufferViews.push({ buffer: 0, byteOffset, byteLength: uv.byteLength });
  chunks.push(Buffer.from(uv.buffer));
  attributes.TEXCOORD_0 = accessors.length;
  accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 3, type: "VEC2" });
  byteOffset += uv.byteLength;

  let indicesAcc: number | undefined;
  if (indexed) {
    const idxBuf = Buffer.from(idx.buffer);
    const padded = Buffer.alloc((idxBuf.length + 3) & ~3);
    idxBuf.copy(padded);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: idxBuf.length });
    chunks.push(padded);
    indicesAcc = accessors.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5123, count: 3, type: "SCALAR" });
    byteOffset += padded.length;
  }

  const binBuf = Buffer.concat(chunks);
  const gltf: Record<string, unknown> = {
    asset: { version: "2.0" },
    ...(opts.requireExtension ? { extensionsRequired: [opts.requireExtension], extensionsUsed: [opts.requireExtension] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, scale: [scale, scale, scale] }],
    meshes: [
      {
        primitives: [
          {
            attributes,
            ...(indicesAcc !== undefined ? { indices: indicesAcc } : {}),
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: opts.baseColorFactor ?? [0.8, 0.4, 0.2, 1],
          roughnessFactor: 0.85,
          metallicFactor: 0.1,
        },
      },
    ],
    buffers: [{ byteLength: binBuf.byteLength }],
    bufferViews,
    accessors,
  };

  const jsonRaw = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = (4 - (jsonRaw.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonRaw, Buffer.alloc(jsonPad, 0x20)]);
  const totalLen = 12 + 8 + jsonChunk.length + 8 + binBuf.length;

  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  const binHdrOff = 20 + jsonChunk.length;
  out.writeUInt32LE(binBuf.length, binHdrOff);
  out.writeUInt32LE(0x004e4942, binHdrOff + 4);
  binBuf.copy(out, binHdrOff + 8);
  return out;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("B1 geometry SoA codec & baker", () => {
  it("encodes and decodes binary SoA geometry deterministically (canonicalizing -0)", () => {
    const pos = new Float32Array([-0, 1, 2, 3, -0, 5, 6, 7, 8]);
    const norm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);
    const blob = encodeBakedGeometryRecord({ positions: pos, normals: norm, uvs: uv, indices });
    const decoded = decodeBakedGeometryRecord(blob);
    assert.equal(Object.is(decoded.positions[0], 0), true);
    assert.deepEqual([...decoded.indices], [0, 1, 2]);
    assert.ok(decoded.boundingSphere.radius > 0);
    assert.throws(() => decodeBakedGeometryRecord(Buffer.from("bad!")), /invalid baked geometry/);
  });

  it("applies GLB node scale transforms and computes flat normals when omitted", () => {
    const glb = makeSyntheticTriangleGlb({ scale: 0.01, indexed: false, omitNormals: true });
    const rec = extractGlbGeometry(glb);
    assert.equal(rec.positions.length, 9);
    // Vertex (1, 0, 0) scaled by 0.01 -> (0.01, 0, 0)
    assert.ok(Math.abs(rec.positions[3] - 0.01) < 1e-6);
    assert.ok(Math.abs(rec.positions[7] - 0.02) < 1e-6);
    // Normal along +Z
    assert.ok(Math.abs(rec.normals[2] - 1) < 1e-6);
  });

  it("produces golden-hash identical chunks, dedupes duplicates, rejects bad GLBs gracefully, and serves BakedAssetProvider", async (t) => {
    const root = makeTempDir("b1-synth-src-");
    const outA = makeTempDir("b1-synth-outA-");
    const outB = makeTempDir("b1-synth-outB-");

    const glbIndexed = makeSyntheticTriangleGlb({ scale: 1, indexed: true, baseColorFactor: [0.5, 0.7, 0.2, 1] });
    const glbFlat = makeSyntheticTriangleGlb({ scale: 2, indexed: false, omitNormals: true });
    const glbBad = makeSyntheticTriangleGlb({ requireExtension: "EXT_meshopt_compression" });

    writeFile(root, "models/crate.glb", glbIndexed);
    writeFile(root, "models/crate_copy.glb", glbIndexed);
    writeFile(root, "models/spire.glb", glbFlat);
    writeFile(root, "models/unsupported.glb", glbBad);

    const manifest = {
      name: "town-kit",
      version: "1.0.0",
      models: [
        { id: "town/crate", file: "models/crate.glb", forShape: "0" },
        { id: "town/crate_copy", file: "models/crate_copy.glb" },
        { id: "town/spire", file: "models/spire.glb" },
        { id: "town/unsupported", file: "models/unsupported.glb" },
      ],
      textures: [],
    };
    const licenceMap = {
      "town/crate": { name: "CC BY 4.0", author: "Polyfork", credit: "Polyfork" },
      "town/crate_copy": { name: "CC BY 4.0", author: "Polyfork", credit: "Polyfork" },
      "town/spire": { name: "CC BY 4.0", author: "Polyfork", credit: "Polyfork" },
      "town/unsupported": { name: "CC BY 4.0", author: "Polyfork", credit: "Polyfork" },
    };

    const resA = bakeKitGeometry({
      assetsRoot: root,
      outDir: outA,
      kit: "town",
      target: "shipped-prototype-pack",
      manifest,
      assetLicences: licenceMap,
    });
    const resB = bakeKitGeometry({
      assetsRoot: root,
      outDir: outB,
      kit: "town",
      target: "shipped-prototype-pack",
      manifest,
      assetLicences: licenceMap,
    });

    try {
      // Golden-hash determinism: identical chunk SHA-256 and byte content across independent runs
      assert.equal(resA.manifest.chunkHash, resB.manifest.chunkHash);
      const bytesA = readFileSync(resA.chunkPath);
      const bytesB = readFileSync(resB.chunkPath);
      assert.equal(Buffer.compare(bytesA, bytesB), 0);

      assert.equal(resA.bakedCount, 3);
      assert.equal(resA.uniqueBlobCount, 2, "crate + crate_copy deduped to 1 SoA blob");
      assert.equal(resA.rejectedCount, 1);
      assert.equal(resA.manifest.rejected[0].id, "town/unsupported");
      assert.match(resA.manifest.rejected[0].reason, /EXT_meshopt_compression/);

      // SQLite store agrees on offsets, licence lane, and dedupe
      const lookup = lookupAssetChunk(resA.store, "town/crate_copy");
      assert.ok(lookup);
      assert.equal(lookup.canonicalMeshAssetId, "town/crate");
      assert.equal(lookup.chunkHash, resA.manifest.chunkHash);

      // Serve baked output over loopback HTTP to BakedAssetProvider (real async AssetProvider seam)
      const server = http.createServer((req, res) => {
        const rel = (req.url ?? "/").replace(/^\/+/, "");
        const full = join(outA, rel);
        if (!existsSync(full)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const buf = readFileSync(full);
        res.writeHead(200, { "Content-Length": buf.length });
        res.end(buf);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      t.after(() => server.close());
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}/`;

      const provider = new BakedAssetProvider({ baseUrl, manifestFile: "town.baked.json" });
      await provider.loadAssetPack(baseUrl);

      const statusById = new Map(provider.fallbackStatus().map((s) => [s.id, s]));
      assert.equal(statusById.get("town/crate")?.status, "loaded");
      assert.equal(statusById.get("town/crate_copy")?.status, "loaded");
      assert.equal(statusById.get("town/spire")?.status, "loaded");
      assert.equal(statusById.get("town/unsupported")?.status, "fallback");

      // AssetRef resolution shares GPU geometry across duplicate entries
      const crateMesh = provider.assetMesh({ wireId: 1n, assetHash: bakedAssetHash32("town/crate"), variant: 0 }) as THREE.Mesh;
      const copyMesh = provider.assetMesh({ wireId: 2n, assetHash: bakedAssetHash32("town/crate_copy"), variant: 0 }) as THREE.Mesh;
      assert.ok(crateMesh);
      assert.ok(copyMesh);
      assert.equal(crateMesh.geometry, copyMesh.geometry, "deduped assets share one BufferGeometry");

      // Rejected asset returns undefined so caller falls back to bodyMesh placeholder cleanly
      assert.equal(
        provider.assetMesh({ wireId: 3n, assetHash: bakedAssetHash32("town/unsupported"), variant: 0 }),
        undefined,
      );

      // bodyMesh resolves forShape:"0" to baked geometry and unknown shape to placeholder box/sphere
      const shaped = provider.bodyMesh({
        wireId: 4n,
        shapeKind: 0,
        halfX: 0.5,
        halfY: 0.5,
        halfZ: 0.5,
        radius: 0.5,
        mass: 1,
        motionType: 0,
        layer: 0,
        friction: 0.5,
        restitution: 0,
      }) as THREE.Mesh;
      assert.equal(shaped.geometry, crateMesh.geometry);

      const fallbackSphere = provider.bodyMesh({
        wireId: 5n,
        shapeKind: 1,
        halfX: 0.5,
        halfY: 0.5,
        halfZ: 0.5,
        radius: 0.5,
        mass: 1,
        motionType: 0,
        layer: 0,
        friction: 0.5,
        restitution: 0,
      }) as THREE.Mesh;
      assert.notEqual(fallbackSphere.geometry, crateMesh.geometry);

      provider.dispose();
    } finally {
      resA.store.close();
      resB.store.close();
    }
  });

  it("fails closed on licence-lane violations before writing chunks", () => {
    const root = makeTempDir("b1-lic-src-");
    const outDir = makeTempDir("b1-lic-out-");
    writeFile(root, "models/prop.glb", makeSyntheticTriangleGlb());

    assert.throws(
      () =>
        bakeKitGeometry({
          assetsRoot: root,
          outDir,
          kit: "prop",
          target: "shipped-prototype-pack",
          manifest: {
            name: "bad-pack",
            version: "1.0.0",
            models: [{ id: "prop/x", file: "models/prop.glb" }],
            textures: [],
          },
          assetLicences: { "prop/x": { name: "Own-Game EULA" } },
        }),
      (err) => err instanceof BakedStoreValidationError && err.rejections.length === 1,
    );
    assert.equal(existsSync(join(outDir, "prop.baked.json")), false);
  });

  it("bakes a real kit from assets/ with golden-hash determinism and loads via BakedAssetProvider", async (t) => {
    const hasRealAssets =
      existsSync(join(REAL_ASSETS_DIR, "catalog.json")) &&
      existsSync(join(REAL_ASSETS_DIR, "manifest.json"));
    if (!hasRealAssets) {
      t.skip("gitignored assets/ not present in this checkout");
      return;
    }

    const outA = makeTempDir("b1-real-kitA-");
    const outB = makeTempDir("b1-real-kitB-");
    const creditsPath = existsSync(REAL_CREDITS_PATH) ? REAL_CREDITS_PATH : undefined;

    const resA = bakeKitGeometry({
      assetsRoot: REAL_ASSETS_DIR,
      outDir: outA,
      kit: "fantasy-props",
      target: "own-game",
      creditsPath,
    });
    const resB = bakeKitGeometry({
      assetsRoot: REAL_ASSETS_DIR,
      outDir: outB,
      kit: "fantasy-props",
      target: "own-game",
      creditsPath,
    });

    try {
      assert.equal(resA.manifest.chunkHash, resB.manifest.chunkHash, "real kit chunk hash is deterministic");
      assert.ok(resA.bakedCount >= 70, `expected >= 70 fantasy-props models baked, got ${resA.bakedCount}`);
      assert.equal(resA.rejectedCount, 0);

      const chunkBytes = readFileSync(resA.chunkPath);
      const provider = new BakedAssetProvider({ manifest: resA.manifest, chunkBytes });
      const firstId = resA.manifest.assets[0].id;
      const obj = provider.assetMesh({ wireId: 9n, assetHash: bakedAssetHash32(firstId), variant: 0 }) as THREE.Mesh;
      assert.ok(obj && obj.geometry instanceof THREE.BufferGeometry);
      assert.ok(obj.geometry.attributes.position.count > 0);
      provider.dispose();
    } finally {
      resA.store.close();
      resB.store.close();
    }
  });
});
