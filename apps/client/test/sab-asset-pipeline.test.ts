/**
 * SAB Phase 6 — client SAB asset pipeline tests.
 *
 * Covers: capability probe, SAB arena protocol, GLB + meshopt decode
 * (uncompressed / meshopt / interleaved), worker handler end-to-end into
 * a SAB, loader SAB path + fallback + overflow retry, zero-copy
 * (geometry attributes view the same SAB), determinism, and the
 * getTransferables SAB regression (a SAB in the transfer list throws
 * DataCloneError in browsers).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MeshoptEncoder } from "meshoptimizer/encoder";

// The encoder's WASM instance initializes asynchronously; meshopt
// fixtures must wait for it or encode* reads an unset instance.
await MeshoptEncoder.ready;
import { SabArena, SabArenaState, SabOverflowError } from "../src/assets/sab-arena.js";
import { probeSabSupport } from "../src/assets/sab-support.js";
import {
  decodeGlb,
  decodeGlbIntoSab,
  estimateSabPayloadBytes,
  GlbDecodeError,
} from "../src/assets/glb-meshopt.js";
import {
  SabAssetLoader,
  sabGeometries,
  threeAttributeName,
} from "../src/assets/sab-asset-loader.js";
import { assetDecodeHandler } from "../src/workers/handlers/asset-decode.js";
import { WorkerRuntime } from "../src/workers/runtime.js";

/* ------------------------------------------------------------------ */
/* GLB fixture builder                                                 */
/* ------------------------------------------------------------------ */

interface FixtureMesh {
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  indices: Uint32Array | Uint16Array;
  interleaved?: boolean;
  meshopt?: boolean;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function chunk(type: string, data: Uint8Array, padByte = 0): Uint8Array {
  const out = new Uint8Array(8 + pad4(data.byteLength));
  out.fill(padByte);
  new DataView(out.buffer).setUint32(0, pad4(data.byteLength), true);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

/** Build a one-mesh GLB (uncompressed, meshopt, and/or interleaved). */
function makeGlb(fx: FixtureMesh): Uint8Array {
  const vertexCount = fx.positions.length / 3;
  const indexComponentType = fx.indices instanceof Uint32Array ? 5125 : 5123;
  const indexBytes = new Uint8Array(fx.indices.buffer, fx.indices.byteOffset, fx.indices.byteLength);
  const binParts: Uint8Array[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  let binOffset = 0;
  const pushBin = (bytes: Uint8Array): number => {
    const at = binOffset;
    binParts.push(bytes);
    binOffset += pad4(bytes.byteLength);
    return at;
  };
  const addAccessor = (bufferView: number, componentType: number, count: number, type: string, byteOffset = 0) => {
    accessors.push({ bufferView, byteOffset, componentType, count, type });
    return accessors.length - 1;
  };

  let posAcc: number;
  let nrmAcc: number | undefined;
  if (fx.interleaved && fx.normals) {
    // One interleaved POSITION+NORMAL view, stride 24 bytes.
    const stride = 24;
    const packed = new Uint8Array(vertexCount * stride);
    const pf = new Float32Array(packed.buffer);
    for (let i = 0; i < vertexCount; i++) {
      pf.set(fx.positions.subarray(i * 3, i * 3 + 3), i * 6);
      pf.set(fx.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    }
    if (fx.meshopt) {
      const compressed = MeshoptEncoder.encodeGltfBuffer(packed, vertexCount, stride, "ATTRIBUTES");
      const at = pushBin(compressed);
      const bv = bufferViews.length;
      bufferViews.push({
        buffer: 0, byteOffset: 0, byteLength: packed.byteLength,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: compressed.byteLength, byteStride: stride, count: vertexCount, mode: "ATTRIBUTES", filter: "NONE" } },
      });
      // The meshopt view decodes to the interleaved layout; accessors gather with stride.
      bufferViews[bv].byteStride = stride;
      posAcc = addAccessor(bv, 5126, vertexCount, "VEC3", 0);
      nrmAcc = addAccessor(bv, 5126, vertexCount, "VEC3", 12);
    } else {
      const at = pushBin(packed);
      const bv = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: at, byteLength: packed.byteLength, byteStride: stride });
      posAcc = addAccessor(bv, 5126, vertexCount, "VEC3", 0);
      nrmAcc = addAccessor(bv, 5126, vertexCount, "VEC3", 12);
    }
  } else {
    const addAttribute = (data: Float32Array, type: string) => {
      const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (fx.meshopt) {
        const stride = type === "VEC3" ? 12 : type === "VEC2" ? 8 : 4;
        const compressed = MeshoptEncoder.encodeGltfBuffer(raw, vertexCount, stride, "ATTRIBUTES");
        const at = pushBin(compressed);
        const bv = bufferViews.length;
        bufferViews.push({
          buffer: 0, byteOffset: 0, byteLength: raw.byteLength,
          extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: compressed.byteLength, byteStride: stride, count: vertexCount, mode: "ATTRIBUTES", filter: "NONE" } },
        });
        return addAccessor(bv, 5126, vertexCount, type);
      }
      const at = pushBin(raw);
      const bv = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: at, byteLength: raw.byteLength });
      return addAccessor(bv, 5126, vertexCount, type);
    };
    posAcc = addAttribute(fx.positions, "VEC3");
    nrmAcc = fx.normals ? addAttribute(fx.normals, "VEC3") : undefined;
  }

  let uvAcc: number | undefined;
  if (fx.uvs) {
    const raw = new Uint8Array(fx.uvs.buffer, fx.uvs.byteOffset, fx.uvs.byteLength);
    if (fx.meshopt) {
      const compressed = MeshoptEncoder.encodeGltfBuffer(raw, vertexCount, 8, "ATTRIBUTES");
      const at = pushBin(compressed);
      const bv = bufferViews.length;
      bufferViews.push({
        buffer: 0, byteOffset: 0, byteLength: raw.byteLength,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: compressed.byteLength, byteStride: 8, count: vertexCount, mode: "ATTRIBUTES", filter: "NONE" } },
      });
      uvAcc = addAccessor(bv, 5126, vertexCount, "VEC2");
    } else {
      const at = pushBin(raw);
      const bv = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: at, byteLength: raw.byteLength });
      uvAcc = addAccessor(bv, 5126, vertexCount, "VEC2");
    }
  }

  let idxAcc: number;
  if (fx.meshopt) {
    const size = indexComponentType === 5125 ? 4 : 2;
    const compressed = MeshoptEncoder.encodeGltfBuffer(indexBytes, fx.indices.length, size, "TRIANGLES");
    const at = pushBin(compressed);
    const bv = bufferViews.length;
    bufferViews.push({
      buffer: 0, byteOffset: 0, byteLength: indexBytes.byteLength,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: compressed.byteLength, byteStride: size, count: fx.indices.length, mode: "TRIANGLES", filter: "NONE" } },
    });
    idxAcc = addAccessor(bv, indexComponentType, fx.indices.length, "SCALAR");
  } else {
    const at = pushBin(indexBytes);
    const bv = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: indexBytes.byteLength });
    idxAcc = addAccessor(bv, indexComponentType, fx.indices.length, "SCALAR");
  }

  const attributes: Record<string, number> = { POSITION: posAcc };
  if (nrmAcc !== undefined) attributes.NORMAL = nrmAcc;
  if (uvAcc !== undefined) attributes.TEXCOORD_0 = uvAcc;
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: binOffset }],
    bufferViews,
    accessors,
    meshes: [{ primitives: [{ attributes, indices: idxAcc }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const bin = new Uint8Array(binOffset);
  let o = 0;
  for (const part of binParts) {
    bin.set(part, o);
    o += pad4(part.byteLength);
  }
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0x46546c67, true);
  hv.setUint32(4, 2, true);
  const total = 12 + 8 + pad4(jsonBytes.byteLength) + 8 + pad4(bin.byteLength);
  hv.setUint32(8, total, true);
  const out = new Uint8Array(total);
  out.set(header, 0);
  out.set(chunk("JSON", jsonBytes, 0x20), 12);
  out.set(chunk("BIN\0", bin), 12 + 8 + pad4(jsonBytes.byteLength));
  return out;
}

const quad = (): FixtureMesh => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
});

function attrBytes(decoded: { primitives: Array<{ attributes: Array<{ name: string; bytes: Uint8Array }> }> }, name: string): number[] {
  const a = decoded.primitives[0].attributes.find((x) => x.name === name)!;
  return [...new Float32Array(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength / 4)];
}

/* ------------------------------------------------------------------ */
/* Probe                                                               */
/* ------------------------------------------------------------------ */

describe("probeSabSupport", () => {
  it("is usable when all three legs are present", () => {
    const s = probeSabSupport({ SharedArrayBuffer, Worker: function () {}, crossOriginIsolated: true });
    assert.equal(s.usable, true);
  });
  it("is not usable without cross-origin isolation", () => {
    const s = probeSabSupport({ SharedArrayBuffer, Worker: function () {}, crossOriginIsolated: false });
    assert.equal(s.usable, false);
    assert.match(s.reason, /cross-origin isolated/);
  });
  it("is not usable without SharedArrayBuffer", () => {
    const s = probeSabSupport({ Worker: function () {}, crossOriginIsolated: true });
    assert.equal(s.usable, false);
  });
  it("is not usable without Workers", () => {
    const s = probeSabSupport({ SharedArrayBuffer, crossOriginIsolated: true });
    assert.equal(s.usable, false);
  });
});

/* ------------------------------------------------------------------ */
/* Arena                                                               */
/* ------------------------------------------------------------------ */

describe("SabArena", () => {
  it("allocates 8-aligned, writes/reads, and tracks state", () => {
    const arena = SabArena.create(1024);
    assert.equal(arena.state, SabArenaState.Empty);
    arena.beginWrite();
    assert.equal(arena.state, SabArenaState.Writing);
    const off = arena.alloc(3);
    assert.equal(off % 8, 0);
    arena.write(off, new Uint8Array([1, 2, 3]));
    assert.deepEqual([...arena.view(off, 3)], [1, 2, 3]);
    arena.publish();
    assert.equal(arena.state, SabArenaState.Ready);
    arena.markConsumed();
    assert.equal(arena.state, SabArenaState.Consumed);
  });
  it("throws SabOverflowError carrying neededBytes", () => {
    const arena = SabArena.create(64 + 16);
    arena.beginWrite();
    assert.throws(() => arena.alloc(17), (e: unknown) => e instanceof SabOverflowError && e.neededBytes === 17);
  });
  it("awaitReady resolves on publish and reports errors", async () => {
    const arena = SabArena.create(256);
    setTimeout(() => arena.publish(), 5);
    assert.equal(await arena.awaitReady(1000), SabArenaState.Ready);
    const bad = SabArena.create(256);
    setTimeout(() => bad.markError(999), 5);
    assert.equal(await bad.awaitReady(1000), SabArenaState.Error);
    assert.equal(bad.neededBytes, 999);
  });
});

/* ------------------------------------------------------------------ */
/* GLB decode                                                          */
/* ------------------------------------------------------------------ */

describe("decodeGlb", () => {
  it("round-trips an uncompressed GLB exactly", async () => {
    const d = await decodeGlb(makeGlb(quad()));
    assert.equal(d.primitives.length, 1);
    assert.deepEqual(attrBytes(d, "POSITION"), [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    assert.deepEqual(attrBytes(d, "NORMAL"), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.deepEqual(attrBytes(d, "TEXCOORD_0"), [0, 0, 1, 0, 1, 1, 0, 1]);
    const ix = d.primitives[0].index!;
    assert.deepEqual([...new Uint16Array(ix.bytes.buffer, ix.bytes.byteOffset, ix.count)], [0, 1, 2, 0, 2, 3]);
  });
  it("round-trips a meshopt-compressed GLB exactly (lossless codecs)", async () => {
    const d = await decodeGlb(makeGlb({ ...quad(), meshopt: true }));
    assert.deepEqual(attrBytes(d, "POSITION"), [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const ix = d.primitives[0].index!;
    assert.deepEqual([...new Uint16Array(ix.bytes.buffer, ix.bytes.byteOffset, ix.count)], [0, 1, 2, 0, 2, 3]);
  });
  it("gathers interleaved attributes (meshopt and plain)", async () => {
    for (const meshopt of [false, true]) {
      const d = await decodeGlb(makeGlb({ ...quad(), interleaved: true, meshopt }));
      assert.deepEqual(attrBytes(d, "POSITION"), [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
      assert.deepEqual(attrBytes(d, "NORMAL"), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    }
  });
  it("is deterministic: same bytes in, same bytes out", async () => {
    const glb = makeGlb({ ...quad(), meshopt: true });
    const a = await decodeGlb(glb);
    const b = await decodeGlb(glb);
    assert.deepEqual(
      a.primitives[0].attributes.map((x) => [...x.bytes]),
      b.primitives[0].attributes.map((x) => [...x.bytes]),
    );
  });
  it("rejects malformed GLBs", async () => {
    await assert.rejects(decodeGlb(new Uint8Array([1, 2, 3])), GlbDecodeError);
    const bad = makeGlb(quad());
    bad[0] = 0;
    await assert.rejects(decodeGlb(bad), GlbDecodeError);
  });
  it("estimateSabPayloadBytes matches the bytes the worker writes", async () => {
    const glb = makeGlb({ ...quad(), meshopt: true });
    const arena = SabArena.create(estimateSabPayloadBytes(glb) + 64 + 1024);
    const result = await decodeGlbIntoSab(glb, arena);
    assert.equal(result.totalBytes, estimateSabPayloadBytes(glb));
  });
});

/* ------------------------------------------------------------------ */
/* Handler + loader                                                    */
/* ------------------------------------------------------------------ */

describe("threeAttributeName", () => {
  it("maps glTF semantics to three.js attribute names", () => {
    assert.equal(threeAttributeName("POSITION"), "position");
    assert.equal(threeAttributeName("NORMAL"), "normal");
    assert.equal(threeAttributeName("TANGENT"), "tangent");
    assert.equal(threeAttributeName("TEXCOORD_0"), "uv");
    assert.equal(threeAttributeName("TEXCOORD_1"), "uv2");
    assert.equal(threeAttributeName("COLOR_0"), "color");
    assert.equal(threeAttributeName("COLOR_1"), "color2");
    assert.equal(threeAttributeName("JOINTS_0"), "skinIndex");
    assert.equal(threeAttributeName("WEIGHTS_0"), "skinWeight");
  });
});

const usableSupport = probeSabSupport({ SharedArrayBuffer, Worker: function () {}, crossOriginIsolated: true });

describe("assetDecodeHandler + SabAssetLoader", () => {
  it("decodes into a SAB; geometry attributes view the same SAB (zero copy)", async () => {
    const glb = makeGlb({ ...quad(), meshopt: true });
    const arena = SabArena.create(estimateSabPayloadBytes(glb) + 64 + 1024);
    const result = await assetDecodeHandler.handle({ glb: glb.slice().buffer as ArrayBuffer, sab: arena.sab });
    assert.ok(!("overflow" in result));
    assert.equal(arena.state, SabArenaState.Ready);
    const [geometry] = sabGeometries(arena.sab, result);
    const pos = geometry.getAttribute("position");
    assert.equal(pos.array.buffer, arena.sab); // zero-copy: the view IS the SAB
    assert.deepEqual([...(pos.array as Float32Array)], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    // glTF semantics map to three.js attribute names (TEXCOORD_0 -> uv).
    assert.deepEqual([...(geometry.getAttribute("uv").array as Float32Array)], [0, 0, 1, 0, 1, 1, 0, 1]);
    assert.deepEqual([...(geometry.getAttribute("normal").array as Float32Array)], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.deepEqual([...(geometry.getIndex()!.array as Uint16Array)], [0, 1, 2, 0, 2, 3]);
    geometry.computeBoundingSphere();
    assert.ok(geometry.boundingSphere);
    assert.equal(geometry.boundingSphere!.center.x, 0.5);
  });

  it("loader SAB path and fallback produce identical geometry", async () => {
    const glb = makeGlb({ ...quad(), meshopt: true });
    const fakeWorkers: any = { request: async (_t: string, p: any) => assetDecodeHandler.handle(p) };
    const viaSab = await new SabAssetLoader({ workers: fakeWorkers, support: usableSupport }).decodeGlbBytes(glb);
    assert.equal(viaSab.via, "sab-worker");
    const viaMain = await new SabAssetLoader({ support: usableSupport }).decodeGlbBytes(glb);
    assert.equal(viaMain.via, "main-thread");
    const a = viaSab.geometries[0].getAttribute("position").array as Float32Array;
    const b = viaMain.geometries[0].getAttribute("position").array as Float32Array;
    assert.deepEqual([...a], [...b]);
  });

  it("loader falls back when SAB is unusable or the worker fails", async () => {
    const glb = makeGlb({ ...quad(), meshopt: true });
    const noIsolation = probeSabSupport({ SharedArrayBuffer, Worker: function () {}, crossOriginIsolated: false });
    const fakeWorkers: any = { request: async () => assetDecodeHandler.handle({} as any) };
    const r1 = await new SabAssetLoader({ workers: fakeWorkers, support: noIsolation }).decodeGlbBytes(glb);
    assert.equal(r1.via, "main-thread");
    const failing: any = { request: async () => { throw new Error("worker down"); } };
    const r2 = await new SabAssetLoader({ workers: failing, support: usableSupport }).decodeGlbBytes(glb);
    assert.equal(r2.via, "main-thread");
    assert.deepEqual([...(r2.geometries[0].getAttribute("position").array as Float32Array)], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  });

  it("handler reports overflow; loader retries once with a bigger arena", async () => {
    const glb = makeGlb({ ...quad(), meshopt: true });
    const tiny = SabArena.create(64 + 8);
    const overflow = await assetDecodeHandler.handle({ glb: glb.slice().buffer as ArrayBuffer, sab: tiny.sab });
    assert.ok("overflow" in overflow && overflow.overflow);
    assert.equal(tiny.state, SabArenaState.Error);
    assert.ok(overflow.neededBytes > 8);

    let calls = 0;
    const flaky: any = {
      request: async (_t: string, p: any) => {
        calls++;
        if (calls === 1) return { overflow: true, neededBytes: 4096 };
        return assetDecodeHandler.handle(p);
      },
    };
    const r = await new SabAssetLoader({ workers: flaky, support: usableSupport }).decodeGlbBytes(glb);
    assert.equal(r.via, "sab-worker");
    assert.equal(calls, 2);
  });

  it("fetchAndDecodeGlb fetches then decodes", async () => {
    const glb = makeGlb({ ...quad(), meshopt: true });
    const fakeFetch = (async () => new Response(glb as unknown as BodyInit)) as typeof fetch;
    const loader = new SabAssetLoader({ support: usableSupport, fetchImpl: fakeFetch });
    const r = await loader.fetchAndDecodeGlb("https://example.invalid/model.glb");
    assert.equal(r.via, "main-thread");
    assert.equal(r.geometries.length, 1);
    await assert.rejects(
      new SabAssetLoader({ fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch }).fetchAndDecodeGlb("https://example.invalid/missing.glb"),
      /404/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Runtime regression: SAB must never enter the transfer list         */
/* ------------------------------------------------------------------ */

describe("WorkerRuntime.getTransferables", () => {
  it("shares SABs instead of transferring them; still transfers ArrayBuffers", () => {
    const sab = new SharedArrayBuffer(64);
    const view = new Uint8Array(sab, 0, 8);
    const plain = new ArrayBuffer(16);
    const transferables = WorkerRuntime.getTransferables({ glb: plain, sab, view });
    assert.ok(transferables.includes(plain));
    assert.ok(!transferables.includes(sab as unknown as ArrayBuffer));
  });
});
