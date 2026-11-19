/**
 * Node-only Baked Asset Store B2 Animation Clip Baker (`BAKED-ASSET-STORE-SPEC.md §5 B2`):
 * - Extracts glTF 2.0 animations from `.glb` files in Node using shared `./glb-parse.js`,
 * - Enforces `validateRetargetedClip` (`validateClip`: bone budget, loop continuity, planted foot slide),
 * - Enforces fail-closed licence-lane gating via `./baked-store.js`,
 * - Encodes canonical SoA keyframe streams (`encodeBakedClipRecord`: `"quant16"` / `"none"`)
 *   with measured per-clip compression ratios and reconstruction error bounds,
 * - Deduplicates identical clip blobs via SHA-256 and writes deterministic `<outDir>/chunks/<hash>.chunk`,
 *   `<outDir>/<kit>.clips.baked.json`, and SQLite `clips` + `chunks` tables.
 *
 * Node-only module: do NOT re-export from `browser.ts`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as THREE from "three";
import {
  encodeBakedClipRecord,
  type BakedClipAssetEntry,
  type BakedClipManifest,
  type BakedClipRejectedEntry,
  type ClipCompressionMode,
} from "./baked-clips.js";
import {
  classifyAssetLicence,
  commitBakedStoreDatabase,
  compareCodepoint,
  resolveContainedFile,
  sha256Hex,
  validateBakeLicences,
  validateChunkId,
  writeFileAtomic,
  type AssetLicenceInput,
  type BakedAssetStore,
  type BakeTarget,
  type ChunkKind,
  type ClipToInsert,
  type DedupeReport,
  type LicenceClassification,
  type LicenceCoverageReport,
} from "./baked-store.js";
import type { AnimationManifest } from "./character/animations.js";
import { validateRetargetedClip } from "./convert/retarget.js";
import { parseCredits, type CreditEntry } from "./credits.js";
import { buildGlbNodeHierarchy, parseGlbChunks, readAccessorValues } from "./glb-parse.js";
import { errMessage } from "./util.js";

export interface BakedClipSourceSpec {
  id: string;
  file: string;
  license: AssetLicenceInput | string;
  author?: string;
  url?: string;
  family?: string;
  reference?: boolean;
  /** Optional per-clip metadata (e.g. from `animations.json`). */
  clipMeta?: Readonly<Record<string, { loop?: boolean; travel?: readonly [number, number] }>>;
}

export interface BakeClipStoreOptions {
  /** Root directory that source `.glb` paths are relative to (e.g. Rigged/ dir or assetsRoot). */
  assetsRoot: string;
  /** Directory where `chunks/<hash>.chunk`, `<kit>.clips.baked.json`, and `store.sqlite` are written. */
  outDir: string;
  /** Clip bundle slug (default `"clips"`). */
  kit?: string;
  /** Optional chunk id override (default `"kit:<kit>"`). */
  chunkId?: ChunkKind;
  /** Optional explicit SQLite path (default `<outDir>/store.sqlite`). */
  dbPath?: string;
  /** Optional explicit sources list (if omitted, reads `animationsManifest` / `animationsManifestPath`). */
  sources?: readonly BakedClipSourceSpec[];
  animationsManifest?: AnimationManifest;
  animationsManifestPath?: string;
  /** Optional filter matching source ids (`"cmu-traversal"`, `"ual1"`, etc.). */
  sourceIds?: readonly string[];
  /** Include reference sources when reading `animations.json`. Defaults to false. */
  includeReference?: boolean;
  /** Optional rig `.glb` used for planted-foot slide measurement inside `validateRetargetedClip`. */
  rigGlbPath?: string;
  /** Target licence gate (`"own-game"` | `"shipped-prototype-pack"`, default `"own-game"`). */
  target?: BakeTarget;
  /** Optional `credits.json` path for attribution lookup. */
  creditsPath?: string;
  /** Keyframe track compression (`"quant16"` default, or `"none"`). */
  compression?: ClipCompressionMode;
  /** Nominal sample rate recorded in SQLite & clip headers (default `30`). */
  rate?: number;
  /** Bone budget enforced per clip (default `128`). */
  maxBoneBudget?: number;
  /** Max allowed planted-foot slide in metres when `rigGlbPath` is provided. */
  maxFootSlide?: number;
  /** Foot plant tolerance in metres for `measureClipFootSlide`. */
  plantToleranceM?: number;
  /** Optional clip name filter. */
  clipNames?: ReadonlySet<string> | readonly string[];
  /** Throw immediately if any clip fails validation instead of recording in `rejected[]`. Defaults to false. */
  strictValidation?: boolean;
}

export interface BakeClipStoreResult {
  store: BakedAssetStore;
  chunkPath: string;
  manifestPath: string;
  manifest: BakedClipManifest;
  bakedCount: number;
  uniqueBlobCount: number;
  rejectedCount: number;
  totalRawBytes: number;
  totalCompressedBytes: number;
  maxPositionErrorM: number;
  maxRotationErrorRad: number;
  dedupeReport: DedupeReport;
  licenceCoverageReport: LicenceCoverageReport;
}

/** Extract `THREE.AnimationClip[]` and hierarchy `THREE.Group` directly from a glTF 2.0 `.glb`. */
export function extractGlbClipsAndRig(glbBytes: Uint8Array): {
  clips: THREE.AnimationClip[];
  rig: THREE.Group;
} {
  const { gltf, buffers } = parseGlbChunks(glbBytes);
  const rig = buildGlbNodeHierarchy(gltf);
  const nodes = gltf.nodes ?? [];
  const clips: THREE.AnimationClip[] = [];

  for (let aIdx = 0; aIdx < (gltf.animations?.length ?? 0); aIdx++) {
    const anim = gltf.animations![aIdx];
    const animName = anim.name?.trim() || `clip_${aIdx}`;
    const samplers = anim.samplers ?? [];
    const tracks: THREE.KeyframeTrack[] = [];

    for (const ch of anim.channels ?? []) {
      if (ch.target.node === undefined) continue;
      const node = nodes[ch.target.node];
      const rawNodeName = node?.name ?? `node_${ch.target.node}`;
      const nodeName = THREE.PropertyBinding.sanitizeNodeName(rawNodeName);
      const sampler = samplers[ch.sampler];
      if (!sampler) continue;

      const times = new Float32Array(readAccessorValues(gltf, buffers, sampler.input, "SCALAR").values);
      const out = readAccessorValues(gltf, buffers, sampler.output);
      const values = new Float32Array(out.values);

      if (ch.target.path === "rotation" && out.componentCount === 4) {
        tracks.push(new THREE.QuaternionKeyframeTrack(`${nodeName}.quaternion`, times, values));
      } else if (ch.target.path === "translation" && out.componentCount === 3) {
        tracks.push(new THREE.VectorKeyframeTrack(`${nodeName}.position`, times, values));
      } else if (ch.target.path === "scale" && out.componentCount === 3) {
        tracks.push(new THREE.VectorKeyframeTrack(`${nodeName}.scale`, times, values));
      }
    }

    let duration = 0;
    for (const t of tracks) {
      if (t.times.length > 0) {
        const last = t.times[t.times.length - 1];
        if (last > duration) duration = last;
      }
    }
    clips.push(new THREE.AnimationClip(animName, duration, tracks));
  }

  return { clips, rig };
}

function loadSourcesFromManifest(
  options: BakeClipStoreOptions,
  assetsRoot: string,
): { sources: BakedClipSourceSpec[]; effectiveRoot: string } {
  let manifest = options.animationsManifest;
  let effectiveRoot = assetsRoot;
  if (!manifest && options.animationsManifestPath) {
    const mPath = resolve(options.animationsManifestPath);
    manifest = JSON.parse(readFileSync(mPath, "utf8")) as AnimationManifest;
    effectiveRoot = dirname(mPath);
  }
  if (!manifest) {
    throw new Error("bakeClipStore requires either `sources`, `animationsManifest`, or `animationsManifestPath`");
  }

  const clipMetaBySource = new Map<string, Record<string, { loop: boolean; travel: [number, number] }>>();
  for (const c of manifest.clips) {
    let map = clipMetaBySource.get(c.source);
    if (!map) clipMetaBySource.set(c.source, (map = {}));
    map[c.name] = { loop: c.loop, travel: [c.travel[0], c.travel[1]] };
  }

  const sources: BakedClipSourceSpec[] = manifest.sources
    .filter((s) => options.includeReference || !s.reference)
    .map((s) => ({
      id: s.id,
      file: s.file,
      license: { name: s.license, author: s.author, page: s.url, sourcePath: s.file, packSlug: s.id },
      author: s.author,
      url: s.url,
      family: s.reference ? "reference" : "locomotion",
      reference: s.reference,
      clipMeta: clipMetaBySource.get(s.id),
    }));

  return { sources, effectiveRoot };
}

function estimateClipTravel(clip: THREE.AnimationClip): [number, number] {
  const hipsPos = clip.tracks.find(
    (t) => t.name === "Hips.position" || t.name.toLowerCase().endsWith("hips.position"),
  );
  if (!hipsPos || hipsPos.values.length < 6) return [0, 0];
  const n = hipsPos.values.length;
  return [
    +(hipsPos.values[n - 3] - hipsPos.values[0]).toFixed(3),
    +(hipsPos.values[n - 1] - hipsPos.values[2]).toFixed(3),
  ];
}

function inferClipLoop(name: string): boolean {
  return /_Loop$|Idle|_Hold(\.F)?$|(Run|Walk|Sprint|Strafe|Crouch)\w*0\d/i.test(name);
}

/**
 * Bake validated, compressed SoA animation clips into `<outDir>/chunks/<chunkHash>.chunk`,
 * `<outDir>/<kit>.clips.baked.json`, and SQLite `store.sqlite`.
 */
export function bakeClipStore(options: BakeClipStoreOptions): BakeClipStoreResult {
  const kit = options.kit ?? "clips";
  const outDir = resolve(options.outDir);
  const dbPath = options.dbPath ?? join(outDir, "store.sqlite");
  const chunkId: ChunkKind = options.chunkId ? validateChunkId(options.chunkId) : (`kit:${kit}` as ChunkKind);
  const target: BakeTarget = options.target ?? "own-game";
  const compression: ClipCompressionMode = options.compression ?? "quant16";
  const rate = options.rate ?? 30;
  const maxBoneBudget = options.maxBoneBudget ?? 128;

  const creditIndex = new Map<string, CreditEntry>();
  if (options.creditsPath && existsSync(options.creditsPath)) {
    const parsedCredits = parseCredits(JSON.parse(readFileSync(options.creditsPath, "utf8")) as unknown);
    for (const c of parsedCredits.thirdPartyArt) creditIndex.set(c.author.toLowerCase(), c);
  }

  let effectiveRoot = resolve(options.assetsRoot);
  let rawSources: BakedClipSourceSpec[];
  if (options.sources) {
    rawSources = [...options.sources];
  } else {
    const loaded = loadSourcesFromManifest(options, effectiveRoot);
    rawSources = loaded.sources;
    effectiveRoot = loaded.effectiveRoot;
  }

  const sourceFilter = options.sourceIds ? new Set(options.sourceIds) : null;
  const sources = rawSources
    .filter((s) => !sourceFilter || sourceFilter.has(s.id))
    .sort((a, b) => compareCodepoint(a.id, b.id));

  const classBySource = new Map<string, LicenceClassification>();
  for (const s of sources) {
    const licObj: AssetLicenceInput =
      typeof s.license === "string"
        ? { name: s.license, author: s.author, page: s.url, sourcePath: s.file, packSlug: s.id }
        : { ...s.license, author: s.license.author ?? s.author, page: s.license.page ?? s.url, sourcePath: s.license.sourcePath ?? s.file, packSlug: s.license.packSlug ?? s.id };
    classBySource.set(s.id, classifyAssetLicence(licObj, creditIndex));
  }

  // Fail closed on any disallowed source licence before processing or writing files.
  validateBakeLicences(
    sources.map((s) => ({
      id: `anim:${s.id}`,
      kind: "clip" as const,
      classification: classBySource.get(s.id)!,
    })),
    target,
  );

  let externalRig: THREE.Object3D | undefined;
  if (options.rigGlbPath) {
    const { rig } = extractGlbClipsAndRig(readFileSync(resolve(options.rigGlbPath)));
    externalRig = rig;
  }

  const clipFilter = options.clipNames ? new Set(options.clipNames) : null;
  const blobByHash = new Map<string, Uint8Array>();
  const encodedEntries: Array<{
    id: string;
    source: string;
    family: string;
    verb: string;
    duration: number;
    frames: number;
    loop: boolean;
    travel: [number, number];
    blobHash: string;
    bytes: Uint8Array;
    rawBytes: number;
    compressedBytes: number;
    compressionRatio: number;
    maxPositionErrorM: number;
    maxRotationErrorRad: number;
    footSlide: number;
    boneCount: number;
    classification: LicenceClassification;
  }> = [];
  const rejected: BakedClipRejectedEntry[] = [];
  const seenClipIds = new Set<string>();

  for (const src of sources) {
    const classification = classBySource.get(src.id)!;
    const fullPath = resolveContainedFile(effectiveRoot, src.file, `animation source "${src.id}"`);
    const { clips, rig: extractedRig } = extractGlbClipsAndRig(readFileSync(fullPath));
    const validationRig = externalRig ?? (extractedRig.children.length > 0 ? extractedRig : undefined);

    for (const clip of [...clips].sort((a, b) => compareCodepoint(a.name, b.name))) {
      if (clipFilter && !clipFilter.has(clip.name)) continue;
      if (seenClipIds.has(clip.name)) continue;

      try {
        if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.tracks.length === 0) {
          throw new Error("clip has empty tracks or non-positive duration");
        }
        const validation = validateRetargetedClip(clip, maxBoneBudget, {
          rig: validationRig,
          maxFootSlide: options.maxFootSlide,
          plantToleranceM: options.plantToleranceM,
        });

        const meta = src.clipMeta?.[clip.name];
        const loop = meta?.loop ?? inferClipLoop(clip.name);
        const travel: [number, number] = meta?.travel ? [meta.travel[0], meta.travel[1]] : estimateClipTravel(clip);
        const { bytes, stats } = encodeBakedClipRecord(clip, { compression, rate, loop, travel });
        const blobHash = sha256Hex(bytes);
        if (!blobByHash.has(blobHash)) blobByHash.set(blobHash, bytes);

        seenClipIds.add(clip.name);
        encodedEntries.push({
          id: clip.name,
          source: src.id,
          family: src.family ?? "locomotion",
          verb: clip.name.toLowerCase(),
          duration: clip.duration,
          frames: Math.max(1, Math.round(clip.duration * rate)),
          loop,
          travel,
          blobHash,
          bytes,
          rawBytes: stats.rawBytes,
          compressedBytes: stats.compressedBytes,
          compressionRatio: stats.compressionRatio,
          maxPositionErrorM: stats.maxPositionErrorM,
          maxRotationErrorRad: stats.maxRotationErrorRad,
          footSlide: validation.footSlide,
          boneCount: validation.boneCount,
          classification,
        });
      } catch (err) {
        if (options.strictValidation) throw err;
        rejected.push({ id: clip.name, source: src.id, reason: errMessage(err) });
      }
    }
  }

  const orderedHashes = [...blobByHash.keys()].sort(compareCodepoint);
  const offsetByHash = new Map<string, number>();
  let totalChunkBytes = 0;
  for (const h of orderedHashes) {
    offsetByHash.set(h, totalChunkBytes);
    totalChunkBytes += (blobByHash.get(h)!.byteLength + 3) & ~3;
  }

  const chunkBuffer = new Uint8Array(totalChunkBytes);
  for (const h of orderedHashes) {
    chunkBuffer.set(blobByHash.get(h)!, offsetByHash.get(h)!);
  }
  const chunkHash = sha256Hex(chunkBuffer);
  const chunkRelFile = `chunks/${chunkHash}.chunk`;

  mkdirSync(join(outDir, "chunks"), { recursive: true });
  const chunkPath = join(outDir, chunkRelFile);
  writeFileAtomic(chunkPath, chunkBuffer);

  encodedEntries.sort((a, b) => compareCodepoint(a.id, b.id));
  const clipAssets: BakedClipAssetEntry[] = encodedEntries.map((e) => ({
    id: e.id,
    source: e.source,
    family: e.family,
    verb: e.verb,
    duration: e.duration,
    rate,
    frames: e.frames,
    loop: e.loop,
    travel: e.travel,
    byteOffset: offsetByHash.get(e.blobHash)!,
    byteLength: e.bytes.byteLength,
    blobHash: e.blobHash,
    rawBytes: e.rawBytes,
    compressedBytes: e.compressedBytes,
    compressionRatio: e.compressionRatio,
    maxPositionErrorM: e.maxPositionErrorM,
    maxRotationErrorRad: e.maxRotationErrorRad,
    footSlide: e.footSlide,
    boneCount: e.boneCount,
    licenceLane: e.classification.licenceLane,
    ...(e.classification.credit ? { credit: e.classification.credit } : {}),
  }));

  const manifest: BakedClipManifest = {
    version: 1,
    kit,
    target,
    chunkId,
    chunkFile: chunkRelFile,
    chunkHash,
    chunkBytes: chunkBuffer.byteLength,
    compression,
    clips: clipAssets,
    rejected: rejected.sort((a, b) => compareCodepoint(a.id, b.id)),
  };

  const manifestPath = join(outDir, `${kit}.clips.baked.json`);
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

  const resolvedClips: ClipToInsert[] = encodedEntries.map((e) => ({
    id: e.id,
    assetId: `anim:${e.source}`,
    family: e.family,
    verb: e.verb,
    frames: e.frames,
    rate,
    hash: e.blobHash,
    classification: e.classification,
  }));

  const dbRes = commitBakedStoreDatabase({
    dbPath,
    target,
    manifest: { name: kit, version: "1.0.0", models: [], textures: [] },
    converterVersion: undefined,
    chunksToInsert: [{ id: chunkId, kind: chunkId, bytes: chunkBuffer.byteLength, hash: chunkHash }],
    assetsWithHashes: [],
    slotByHash: new Map(),
    resolvedClips,
    knobsToInsert: [],
  });

  let totalRawBytes = 0;
  let totalCompressedBytes = 0;
  let maxPositionErrorM = 0;
  let maxRotationErrorRad = 0;
  for (const c of clipAssets) {
    totalRawBytes += c.rawBytes;
    totalCompressedBytes += c.compressedBytes;
    if (c.maxPositionErrorM > maxPositionErrorM) maxPositionErrorM = c.maxPositionErrorM;
    if (c.maxRotationErrorRad > maxRotationErrorRad) maxRotationErrorRad = c.maxRotationErrorRad;
  }

  return {
    store: dbRes.store,
    chunkPath,
    manifestPath,
    manifest,
    bakedCount: clipAssets.length,
    uniqueBlobCount: orderedHashes.length,
    rejectedCount: rejected.length,
    totalRawBytes,
    totalCompressedBytes,
    maxPositionErrorM,
    maxRotationErrorRad,
    dedupeReport: dbRes.dedupeReport,
    licenceCoverageReport: dbRes.licenceCoverageReport,
  };
}
