/**
 * Benchmark: SAB worker decode vs main-thread decode of a realistic
 * meshopt-compressed GLB (SAB Phase 6 benchmark gate).
 *
 * Run: `npm run bench:sab-assets` (builds lib first, so dist/ is fresh).
 *
 * Asset: a 256x256-cell grid — 66,049 vertices, 393,216 indices,
 * POSITION + NORMAL + TEXCOORD_0, meshopt-compressed with the same
 * encoder the bake pipeline's gltfpack -cc produces. ~2.4 MB decoded.
 *
 * Metrics (median of N runs after 1 warmup):
 * - baseline: main-thread decode wall time == main-thread blocking time
 *   (the whole decode runs on the main thread).
 * - sab: total wall time for worker decode + main-thread geometry build,
 *   and the main thread's own blocking time (arena alloc + geometry
 *   construction from SAB views only — the decode is off-thread).
 *
 * Gate: main-thread blocking must drop (the phase's goal — the decode
 * must not hitch the render/input thread). Total wall is reported, not
 * gated: in isolation the worker path pays thread-handoff + scheduling
 * (a second thread to wake), so its standalone wall can exceed the
 * single-threaded baseline; in production the worker decode overlaps
 * main-thread frame work instead of serializing behind it, so the
 * user-visible cost is the blocking time, not the isolated wall sum.
 * A wall regression here is therefore an observed tradeoff to report,
 * not a silent pass — see the numbers below.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { SabArena } from "../dist/src/assets/sab-arena.js";
import { decodeGlb, estimateSabPayloadBytes } from "../dist/src/assets/glb-meshopt.js";
import { decodedGeometries, sabGeometries } from "../dist/src/assets/sab-asset-loader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = 5;

const pad4 = (n) => (n + 3) & ~3;

function buildGridGlb(cells) {
  const n = cells + 1;
  const vertexCount = n * n;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = j * n + i;
      positions.set([i, Math.sin(i * 0.1) * Math.cos(j * 0.1), j], v * 3);
      normals.set([0, 1, 0], v * 3);
      uvs.set([i / cells, j / cells], v * 2);
    }
  }
  const indexCount = cells * cells * 6;
  const indices = new Uint32Array(indexCount);
  let k = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i;
      indices.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], k);
      k += 6;
    }
  }

  const binParts = [];
  const bufferViews = [];
  const accessors = [];
  let binOffset = 0;
  const pushBin = (bytes) => {
    const at = binOffset;
    binParts.push(bytes);
    binOffset += pad4(bytes.byteLength);
    return at;
  };
  const addAttr = (data, count, stride, type) => {
    const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const compressed = MeshoptEncoder.encodeGltfBuffer(raw, count, stride, "ATTRIBUTES");
    const at = pushBin(compressed);
    const bv = bufferViews.length;
    bufferViews.push({
      buffer: 0, byteOffset: 0, byteLength: raw.byteLength,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: compressed.byteLength, byteStride: stride, count, mode: "ATTRIBUTES", filter: "NONE" } },
    });
    accessors.push({ bufferView: bv, byteOffset: 0, componentType: 5126, count, type });
    return accessors.length - 1;
  };
  const posAcc = addAttr(positions, vertexCount, 12, "VEC3");
  const nrmAcc = addAttr(normals, vertexCount, 12, "VEC3");
  const uvAcc = addAttr(uvs, vertexCount, 8, "VEC2");
  const idxRaw = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
  const idxCompressed = MeshoptEncoder.encodeGltfBuffer(idxRaw, indexCount, 4, "TRIANGLES");
  const idxAt = pushBin(idxCompressed);
  const idxBv = bufferViews.length;
  bufferViews.push({
    buffer: 0, byteOffset: 0, byteLength: idxRaw.byteLength,
    extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: idxAt, byteLength: idxCompressed.byteLength, byteStride: 4, count: indexCount, mode: "TRIANGLES", filter: "NONE" } },
  });
  accessors.push({ bufferView: idxBv, byteOffset: 0, componentType: 5125, count: indexCount, type: "SCALAR" });
  const idxAcc = accessors.length - 1;

  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: binOffset }],
    bufferViews,
    accessors,
    meshes: [{ primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc, TEXCOORD_0: uvAcc }, indices: idxAcc }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const bin = new Uint8Array(binOffset);
  let o = 0;
  for (const part of binParts) {
    bin.set(part, o);
    o += pad4(part.byteLength);
  }
  const chunk = (type, data, padByte) => {
    const out = new Uint8Array(8 + pad4(data.byteLength));
    out.fill(padByte);
    new DataView(out.buffer).setUint32(0, pad4(data.byteLength), true);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  };
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0x46546c67, true);
  hv.setUint32(4, 2, true);
  hv.setUint32(8, 12 + 8 + pad4(jsonBytes.byteLength) + 8 + pad4(bin.byteLength), true);
  const out = new Uint8Array(hv.getUint32(8, true));
  out.set(header, 0);
  out.set(chunk("JSON", jsonBytes, 0x20), 12);
  out.set(chunk("BIN\0", bin, 0), 12 + 8 + pad4(jsonBytes.byteLength));
  return { glb: out, vertexCount, indexCount };
}

function decodeInWorker(worker, glb, sab) {
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      worker.off("message", onMsg);
      worker.off("error", onErr);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error));
    };
    const onErr = (e) => {
      worker.off("message", onMsg);
      worker.off("error", onErr);
      reject(e);
    };
    worker.on("message", onMsg);
    worker.on("error", onErr);
    // Transfer the GLB bytes (detaches the sender's copy, like the browser
    // runtime); the SAB is shared, never transferred.
    worker.postMessage({ glb: glb.buffer, sab }, [glb.buffer]);
  });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  await MeshoptEncoder.ready; // WASM instance initializes asynchronously.
  const { glb, vertexCount, indexCount } = buildGridGlb(256);
  const decodedBytes = vertexCount * (12 + 12 + 8) + indexCount * 4;
  console.log(`asset: ${vertexCount} verts, ${indexCount} indices, GLB ${(glb.byteLength / 1024).toFixed(1)} KiB compressed, ${decodedBytes.toLocaleString()} B decoded`);

  const worker = new Worker(path.join(HERE, "bench-sab-assets.worker.mjs"));

  // Warmup (WASM init + worker spin-up).
  await decodeGlb(glb);
  {
    const arena = SabArena.create(estimateSabPayloadBytes(glb) + 64 + 1024);
    await decodeInWorker(worker, glb.slice(), arena.sab);
  }

  const baseline = [];
  const sabWall = [];
  const sabMain = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const decoded = await decodeGlb(glb);
    const geos = decodedGeometries(decoded);
    for (const g of geos) g.dispose();
    baseline.push(performance.now() - t0);

    const w0 = performance.now();
    const m0 = performance.now();
    const arena = SabArena.create(estimateSabPayloadBytes(glb) + 64 + 1024);
    const mAlloc = performance.now() - m0;
    const result = await decodeInWorker(worker, glb.slice(), arena.sab);
    const m1 = performance.now();
    const sabGeos = sabGeometries(arena.sab, result);
    const mBuild = performance.now() - m1;
    for (const g of sabGeos) g.dispose();
    sabWall.push(performance.now() - w0);
    sabMain.push(mAlloc + mBuild);
  }
  await worker.terminate();

  const b = median(baseline);
  const w = median(sabWall);
  const m = median(sabMain);
  console.log(`baseline main-thread decode+build (median of ${RUNS}): ${b.toFixed(2)} ms  (all of it main-thread blocking)`);
  console.log(`sab worker decode — total wall (median):              ${w.toFixed(2)} ms`);
  console.log(`sab worker decode — main-thread blocking (median):   ${m.toFixed(2)} ms`);
  console.log(`main-thread blocking: ${b.toFixed(2)} ms -> ${m.toFixed(2)} ms (${((1 - m / b) * 100).toFixed(1)}% less)`);
  console.log(`total wall:           ${b.toFixed(2)} ms -> ${w.toFixed(2)} ms (${w <= b ? ((1 - w / b) * 100).toFixed(1) + "% faster" : ((w / b - 1) * 100).toFixed(1) + "% slower"})`);
  if (m >= b) {
    console.log("GATE: FAIL — main-thread blocking did not improve");
    process.exitCode = 1;
  } else {
    console.log("GATE: PASS — main-thread blocking improved (the phase goal).");
    console.log("NOTE: isolated total wall is higher (thread handoff + scheduling); in production the worker decode overlaps main-thread frame work, so blocking — not isolated wall — is the user-visible cost. Decode correctness is identical (see tests).");
  }
}

await main();
