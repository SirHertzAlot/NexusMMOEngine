import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  BakedStoreValidationError,
  bakeClipStore,
  decodeBakedClipRecord,
  decodeBakedClipsFromChunk,
  encodeBakedClipRecord,
  openBakedAssetStore,
} from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const REAL_RIGGED_DIR = join(REPO_ROOT, "assets", "models", "glb", "modular-fantasy-hero", "Rigged");
const REAL_CREDITS_PATH = join(REPO_ROOT, "content", "credits.json");

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Build a valid glTF 2.0 binary carrying a minimal Hips+Foot rig and animation clips. */
function makeClipGlb(
  specs: Array<{
    name: string;
    duration: number;
    loopMismatch?: boolean;
    footSlideX?: number;
  }>,
): Buffer {
  // Nodes: 0 = Hips, 1 = Ankle_L (matches FOOT_BONE_PATTERN in retarget.ts)
  const nodes = [
    { name: "Hips", translation: [0, 1, 0], children: [1] },
    { name: "Ankle_L", translation: [0, -1, 0] },
  ];
  const binParts: Buffer[] = [];
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [];
  const accessors: Array<{ bufferView: number; componentType: number; count: number; type: string }> = [];
  let offset = 0;

  const pushArr = (arr: Float32Array, type: "SCALAR" | "VEC3" | "VEC4"): number => {
    const raw = Buffer.from(arr.buffer);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: raw.byteLength });
    binParts.push(raw);
    offset += raw.byteLength;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: type === "SCALAR" ? arr.length : type === "VEC3" ? arr.length / 3 : arr.length / 4,
      type,
    });
    return accessors.length - 1;
  };

  const animations = specs.map((spec) => {
    const times = new Float32Array([0, spec.duration * 0.5, spec.duration]);
    const tAcc = pushArr(times, "SCALAR");

    const sx = spec.footSlideX ?? 0;
    const hipsPos = new Float32Array([
      0, 1, 0,
      0, 1.05, 0,
      spec.loopMismatch ? 0.5 : 0, 1, spec.loopMismatch ? 0.8 : 0,
    ]);
    const hPosAcc = pushArr(hipsPos, "VEC3");

    const qStart = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
    const qMid = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.35);
    const qEnd = spec.loopMismatch
      ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8)
      : qStart;
    const ankleQuat = new Float32Array([
      qStart.x, qStart.y, qStart.z, qStart.w,
      qMid.x, qMid.y, qMid.z, qMid.w,
      qEnd.x, qEnd.y, qEnd.z, qEnd.w,
    ]);
    const aQuatAcc = pushArr(ankleQuat, "VEC4");

    const anklePos = new Float32Array([
      0, -1, 0,
      sx * 0.5, -1, 0,
      sx, -1, 0,
    ]);
    const aPosAcc = pushArr(anklePos, "VEC3");

    return {
      name: spec.name,
      samplers: [
        { input: tAcc, output: hPosAcc, interpolation: "LINEAR" },
        { input: tAcc, output: aQuatAcc, interpolation: "LINEAR" },
        { input: tAcc, output: aPosAcc, interpolation: "LINEAR" },
      ],
      channels: [
        { sampler: 0, target: { node: 0, path: "translation" } },
        { sampler: 1, target: { node: 1, path: "rotation" } },
        { sampler: 2, target: { node: 1, path: "translation" } },
      ],
    };
  });

  const binBuf = Buffer.concat(binParts);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    animations,
    buffers: [{ byteLength: binBuf.byteLength }],
    bufferViews,
    accessors,
  };
  const jRaw = Buffer.from(JSON.stringify(gltf), "utf8");
  const jPad = Buffer.concat([jRaw, Buffer.alloc((4 - (jRaw.length % 4)) % 4, 0x20)]);
  const totalLen = 12 + 8 + jPad.length + 8 + binBuf.length;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(jPad.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jPad.copy(out, 20);
  out.writeUInt32LE(binBuf.length, 20 + jPad.length);
  out.writeUInt32LE(0x004e4942, 24 + jPad.length);
  binBuf.copy(out, 28 + jPad.length);
  return out;
}

after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("B2 SoA animation clip codec, validation gate & baker", () => {
  it("encodes and decodes quantized and raw clip streams with bounded reconstruction error", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const clip = new THREE.AnimationClip("TestVault", 0.5, [
      new THREE.VectorKeyframeTrack("Hips.position", [0, 0.25, 0.5], [0, 1, 0, 0, 1.4, 0.5, 0, 1, 1]),
      new THREE.QuaternionKeyframeTrack("Spine_01.quaternion", [0, 0.25, 0.5], [0, 0, 0, 1, q.x, q.y, q.z, q.w, 0, 0, 0, 1]),
    ]);

    const qEnc = encodeBakedClipRecord(clip, { compression: "quant16", loop: false, travel: [0, 1] });
    const rEnc = encodeBakedClipRecord(clip, { compression: "none", loop: false, travel: [0, 1] });
    assert.ok(qEnc.stats.compressedBytes < rEnc.stats.compressedBytes, "quant16 smaller than raw_f32");
    assert.ok(qEnc.stats.maxPositionErrorM < 1e-4, `pos error ${qEnc.stats.maxPositionErrorM} within 0.1 mm`);
    assert.ok(qEnc.stats.maxRotationErrorRad < 1e-3, `rot error ${qEnc.stats.maxRotationErrorRad} within 1 mrad`);

    const dec = decodeBakedClipRecord(qEnc.bytes, "TestVault");
    assert.equal(dec.clip.name, "TestVault");
    assert.equal(dec.clip.tracks.length, 2);
    assert.deepEqual(dec.travel, [0, 1]);
    assert.throws(() => decodeBakedClipRecord(Buffer.from("bad!"), "X"), /invalid baked clip/);
  });

  it("enforces validateClip (loop continuity + foot slide), licence gate, and golden-hash determinism", () => {
    const src = makeTempDir("b2-synth-src-");
    const outA = makeTempDir("b2-synth-outA-");
    const outB = makeTempDir("b2-synth-outB-");

    const glbPath = join(src, "anims.glb");
    mkdirSync(dirname(glbPath), { recursive: true });
    writeFileSync(
      glbPath,
      makeClipGlb([
        { name: "Walk_Loop", duration: 1.0, loopMismatch: false, footSlideX: 0 },
        { name: "Broken_Loop", duration: 1.0, loopMismatch: true, footSlideX: 0 },
        { name: "SkatingJump", duration: 1.0, loopMismatch: false, footSlideX: 0.45 },
      ]),
    );

    const sources = [
      {
        id: "cc0-test",
        file: "anims.glb",
        license: "CC0 1.0",
        author: "Test",
        url: "https://example.test",
      },
    ];

    const resA = bakeClipStore({
      assetsRoot: src,
      outDir: outA,
      kit: "demo-clips",
      sources,
      target: "shipped-prototype-pack",
      maxFootSlide: 0.05,
    });
    const resB = bakeClipStore({
      assetsRoot: src,
      outDir: outB,
      kit: "demo-clips",
      sources,
      target: "shipped-prototype-pack",
      maxFootSlide: 0.05,
    });

    try {
      assert.equal(resA.manifest.chunkHash, resB.manifest.chunkHash);
      assert.equal(Buffer.compare(readFileSync(resA.chunkPath), readFileSync(resB.chunkPath)), 0);
      assert.equal(resA.bakedCount, 1);
      assert.equal(resA.manifest.clips[0].id, "Walk_Loop");
      assert.equal(resA.rejectedCount, 2);
      const rejNames = resA.manifest.rejected.map((r) => r.id).sort();
      assert.deepEqual(rejNames, ["Broken_Loop", "SkatingJump"]);

      const decoded = decodeBakedClipsFromChunk(resA.manifest, readFileSync(resA.chunkPath));
      assert.equal(decoded.clips.length, 1);
      assert.equal(decoded.clips[0].name, "Walk_Loop");

      // SQLite store records clips & chunks rows cleanly
      const reopen = openBakedAssetStore(join(outA, "store.sqlite"));
      try {
        const clipCountRow = reopen.db.prepare("SELECT COUNT(*) AS c FROM clips").get() as { c: number };
        assert.equal(clipCountRow.c, 1);
      } finally {
        reopen.close();
      }
    } finally {
      resA.store.close();
      resB.store.close();
    }

    // Fail-closed on CMU source for shipped-prototype-pack
    assert.throws(
      () =>
        bakeClipStore({
          assetsRoot: src,
          outDir: makeTempDir("b2-fail-lic-"),
          kit: "bad-cmu",
          target: "shipped-prototype-pack",
          sources: [
            {
              id: "cmu-traversal",
              file: "anims.glb",
              license: "CMU: free in commercial products, not to be sold as animations; credit mocap.cs.cmu.edu",
            },
          ],
        }),
      (err) => err instanceof BakedStoreValidationError && err.rejections.length === 1,
    );
  });

  it("bakes real CMU P1 traversal & UAL1 clips from assets/ with golden-hash determinism", (t) => {
    const cmuPath = join(REAL_RIGGED_DIR, "animations", "cmu-traversal.glb");
    const ual1Path = join(REAL_RIGGED_DIR, "animations", "ual1.glb");
    const rigPath = join(REAL_RIGGED_DIR, "rig.glb");
    if (!existsSync(cmuPath) || !existsSync(ual1Path) || !existsSync(rigPath)) {
      t.skip("gitignored Rigged animations/rig GLBs not present in this checkout");
      return;
    }

    const outCmuA = makeTempDir("b2-cmu-A-");
    const outCmuB = makeTempDir("b2-cmu-B-");
    const outUal = makeTempDir("b2-ual-");
    const creditsPath = existsSync(REAL_CREDITS_PATH) ? REAL_CREDITS_PATH : undefined;

    const cmuSource = [
      {
        id: "cmu-traversal",
        file: "animations/cmu-traversal.glb",
        license: "CMU: free in commercial products, not to be sold as animations; credit mocap.cs.cmu.edu (NSF EIA-0196217)",
        author: "CMU Graphics Lab",
        url: "http://mocap.cs.cmu.edu/",
        family: "traversal",
      },
    ];

    let cmuA: ReturnType<typeof bakeClipStore> | null = null;
    let cmuB: ReturnType<typeof bakeClipStore> | null = null;
    let ual: ReturnType<typeof bakeClipStore> | null = null;

    try {
      cmuA = bakeClipStore({
        assetsRoot: REAL_RIGGED_DIR,
        outDir: outCmuA,
        kit: "cmu-traversal",
        sources: cmuSource,
        rigGlbPath: rigPath,
        target: "own-game",
        creditsPath,
      });
      cmuB = bakeClipStore({
        assetsRoot: REAL_RIGGED_DIR,
        outDir: outCmuB,
        kit: "cmu-traversal",
        sources: cmuSource,
        rigGlbPath: rigPath,
        target: "own-game",
        creditsPath,
      });

      // Quaternius UAL1 raw source files are own-game-only per §4, so own-game succeeds
      // while shipped-prototype-pack fails closed.
      assert.throws(
        () =>
          bakeClipStore({
            assetsRoot: REAL_RIGGED_DIR,
            outDir: makeTempDir("b2-ual-fail-"),
            kit: "ual1",
            animationsManifestPath: join(REAL_RIGGED_DIR, "animations.json"),
            sourceIds: ["ual1"],
            target: "shipped-prototype-pack",
            creditsPath,
          }),
        (err) => err instanceof BakedStoreValidationError,
      );

      ual = bakeClipStore({
        assetsRoot: REAL_RIGGED_DIR,
        outDir: outUal,
        kit: "ual1",
        animationsManifestPath: join(REAL_RIGGED_DIR, "animations.json"),
        sourceIds: ["ual1"],
        rigGlbPath: rigPath,
        target: "own-game",
        creditsPath,
      });

      assert.equal(cmuA.bakedCount, 20, "all 20 CMU P1 traversal clips baked");
      assert.equal(cmuA.manifest.chunkHash, cmuB.manifest.chunkHash, "golden-hash determinism across two bakes");
      assert.ok(cmuA.totalCompressedBytes < cmuA.totalRawBytes, "quant16 compresses real CMU clips");
      assert.ok(cmuA.maxRotationErrorRad < 1e-3, `max rotation error ${cmuA.maxRotationErrorRad} < 1 mrad`);
      assert.ok(ual.bakedCount >= 30, `baked ${ual.bakedCount} UAL1 clips under own-game`);
    } finally {
      cmuA?.store.close();
      cmuB?.store.close();
      ual?.store.close();
    }
  });
});
