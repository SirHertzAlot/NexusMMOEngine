/**
 * Browser-safe Baked Asset Store B2 SoA animation clip codec & manifest schema
 * (`BAKED-ASSET-STORE-SPEC.md §5 B2`).
 *
 * Binary layout (`MMOC` v1, little-endian, 4-byte aligned):
 * - Header (40 bytes):
 *     [0..4)   magic = 0x4D4D4F43 ("MMOC")
 *     [4..8)   version = 1
 *     [8..12)  compression (0 = raw_f32, 1 = quant16)
 *     [12..16) flags (bit 0 = loop)
 *     [16..20) duration (f32)
 *     [20..24) rate (f32)
 *     [24..28) frames (u32)
 *     [28..32) trackCount (u32)
 *     [32..36) travelX (f32)
 *     [36..40) travelZ (f32)
 * - Track table (`trackCount` × 24 bytes):
 *     [+0..4)  nameOffset (u32 into UTF-8 string block)
 *     [+4..8)  nameLen (u32)
 *     [+8..12) valueType (0 = position Vec3, 1 = quaternion Quat, 2 = scale Vec3)
 *     [+12..16) sampleCount (u32)
 *     [+16..20) timesByteOffset (u32 from blob start)
 *     [+20..24) valuesByteOffset (u32 from blob start)
 */

import * as THREE from "three";
import { z } from "zod";
import type { AnimationClipInfo } from "./character/animations.js";
import { canonF32 } from "./util.js";

export const BAKED_CLIP_MAGIC = 0x4d4d4f43; // "MMOC"
export const BAKED_CLIP_VERSION = 1;
const CLIP_HEADER_BYTES = 40;
const TRACK_DESC_BYTES = 24;

export type ClipCompressionMode = "none" | "quant16";

export interface BakedClipEncodeStats {
  compression: ClipCompressionMode;
  rawBytes: number;
  compressedBytes: number;
  compressionRatio: number;
  maxPositionErrorM: number;
  maxRotationErrorRad: number;
  trackCount: number;
  sampleCountTotal: number;
}

export interface DecodedBakedClip {
  clip: THREE.AnimationClip;
  compression: ClipCompressionMode;
  duration: number;
  rate: number;
  frames: number;
  loop: boolean;
  travel: [number, number];
}

export const BakedClipAssetEntrySchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  family: z.string().min(1),
  verb: z.string().min(1),
  duration: z.number().nonnegative(),
  rate: z.number().positive(),
  frames: z.number().int().positive(),
  loop: z.boolean(),
  travel: z.tuple([z.number(), z.number()]),
  byteOffset: z.number().int().nonnegative(),
  byteLength: z.number().int().positive(),
  blobHash: z.string().regex(/^[0-9a-f]{64}$/),
  rawBytes: z.number().int().positive(),
  compressedBytes: z.number().int().positive(),
  compressionRatio: z.number().positive(),
  maxPositionErrorM: z.number().nonnegative(),
  maxRotationErrorRad: z.number().nonnegative(),
  footSlide: z.number().nonnegative(),
  boneCount: z.number().int().nonnegative(),
  licenceLane: z.string().min(1),
  credit: z.string().nullable().optional(),
});

export const BakedClipRejectedEntrySchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  reason: z.string().min(1),
});

export const BakedClipManifestSchema = z.object({
  version: z.literal(1),
  kit: z.string().min(1),
  target: z.enum(["own-game", "shipped-prototype-pack"]),
  chunkId: z.string().min(1),
  chunkFile: z.string().min(1),
  chunkHash: z.string().regex(/^[0-9a-f]{64}$/),
  chunkBytes: z.number().int().nonnegative(),
  compression: z.enum(["none", "quant16"]),
  clips: z.array(BakedClipAssetEntrySchema),
  rejected: z.array(BakedClipRejectedEntrySchema).default([]),
});

export type BakedClipAssetEntry = z.infer<typeof BakedClipAssetEntrySchema>;
export type BakedClipRejectedEntry = z.infer<typeof BakedClipRejectedEntrySchema>;
export type BakedClipManifest = z.infer<typeof BakedClipManifestSchema>;

const VALUE_TYPE_POS = 0;
const VALUE_TYPE_QUAT = 1;
const VALUE_TYPE_SCALE = 2;

function trackKindOf(track: THREE.KeyframeTrack): { valueType: number; comps: number } {
  if (track instanceof THREE.QuaternionKeyframeTrack || track.name.endsWith(".quaternion")) {
    return { valueType: VALUE_TYPE_QUAT, comps: 4 };
  }
  if (track.name.endsWith(".scale")) {
    return { valueType: VALUE_TYPE_SCALE, comps: 3 };
  }
  return { valueType: VALUE_TYPE_POS, comps: 3 };
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** Quantize vec3 column (`min[3], span[3], u16[count*3]`) and measure max component error. */
function encodeQuantVec3(values: Float32Array, count: number): { buf: Uint8Array; maxErr: number } {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const v = canonF32(values[i * 3 + c]);
      if (v < mins[c]) mins[c] = v;
      if (v > maxs[c]) maxs[c] = v;
    }
  }
  const spans = [0, 1, 2].map((c) => {
    const s = canonF32(maxs[c] - mins[c]);
    return s > 0 ? s : 0;
  });
  const headerBytes = 24; // min[3] + span[3] as f32
  const payloadBytes = align4(count * 3 * 2);
  const out = new Uint8Array(headerBytes + payloadBytes);
  const view = new DataView(out.buffer);
  for (let c = 0; c < 3; c++) {
    view.setFloat32(c * 4, canonF32(mins[c]), true);
    view.setFloat32(12 + c * 4, spans[c], true);
  }
  let maxErr = 0;
  let off = headerBytes;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const orig = canonF32(values[i * 3 + c]);
      const span = spans[c];
      const q = span > 0 ? Math.max(0, Math.min(65535, Math.round(((orig - mins[c]) / span) * 65535))) : 0;
      view.setUint16(off, q, true);
      off += 2;
      const decoded = mins[c] + (q / 65535) * span;
      const err = Math.abs(decoded - orig);
      if (err > maxErr) maxErr = err;
    }
  }
  return { buf: out, maxErr };
}

/** Quantize normalized quaternions (`[-1..1]` -> `u16[4]` per sample) + compute max angular error (rad). */
function encodeQuantQuat(values: Float32Array, count: number): { buf: Uint8Array; maxAngleRad: number } {
  const payloadBytes = align4(count * 4 * 2);
  const out = new Uint8Array(payloadBytes);
  const view = new DataView(out.buffer);
  let maxAngleRad = 0;
  let off = 0;
  for (let i = 0; i < count; i++) {
    let x = canonF32(values[i * 4]);
    let y = canonF32(values[i * 4 + 1]);
    let z = canonF32(values[i * 4 + 2]);
    let w = canonF32(values[i * 4 + 3]);
    const len = Math.hypot(x, y, z, w);
    if (len > 0) {
      x /= len;
      y /= len;
      z /= len;
      w /= len;
    } else {
      w = 1;
    }
    const qs = [x, y, z, w].map((v) => Math.max(0, Math.min(65535, Math.round(((v + 1) * 0.5) * 65535))));
    for (let c = 0; c < 4; c++) {
      view.setUint16(off, qs[c], true);
      off += 2;
    }
    const dx = (qs[0] / 65535) * 2 - 1;
    const dy = (qs[1] / 65535) * 2 - 1;
    const dz = (qs[2] / 65535) * 2 - 1;
    const dw = (qs[3] / 65535) * 2 - 1;
    const dLen = Math.hypot(dx, dy, dz, dw) || 1;
    const dot = Math.min(1, Math.abs(x * (dx / dLen) + y * (dy / dLen) + z * (dz / dLen) + w * (dw / dLen)));
    const angle = 2 * Math.acos(dot);
    if (angle > maxAngleRad) maxAngleRad = angle;
  }
  return { buf: out, maxAngleRad };
}

/**
 * Encode one `THREE.AnimationClip` into a canonical deterministic binary SoA blob
 * (`raw_f32` or `quant16`) and compute compression + reconstruction error stats.
 */
export function encodeBakedClipRecord(
  clip: THREE.AnimationClip,
  options: {
    compression?: ClipCompressionMode;
    rate?: number;
    loop?: boolean;
    travel?: readonly [number, number];
  } = {},
): { bytes: Uint8Array; stats: BakedClipEncodeStats } {
  const compression: ClipCompressionMode = options.compression ?? "quant16";
  const rate = options.rate ?? 30;
  const loop = Boolean(options.loop);
  const travel: readonly [number, number] = options.travel ?? [0, 0];
  const frames = Math.max(1, Math.round(clip.duration * rate));
  const compCode = compression === "quant16" ? 1 : 0;

  const sortedTracks = [...clip.tracks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const enc = new TextEncoder();
  const strChunks: Uint8Array[] = [];
  let strCursor = 0;

  interface EncodedTrack {
    nameOff: number;
    nameLen: number;
    valueType: number;
    sampleCount: number;
    times: Float32Array;
    valBytes: Uint8Array;
  }

  let rawDataBytes = CLIP_HEADER_BYTES + sortedTracks.length * TRACK_DESC_BYTES;
  let sampleCountTotal = 0;
  let maxPositionErrorM = 0;
  let maxRotationErrorRad = 0;
  const encodedTracks: EncodedTrack[] = [];

  for (const track of sortedTracks) {
    const nameBytes = enc.encode(track.name);
    const nameOff = strCursor;
    strChunks.push(nameBytes);
    strCursor += nameBytes.byteLength;

    const { valueType, comps } = trackKindOf(track);
    const sampleCount = track.times.length;
    sampleCountTotal += sampleCount;

    const times = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) times[i] = canonF32(track.times[i]);

    const srcVals = new Float32Array(track.values.length);
    for (let i = 0; i < track.values.length; i++) srcVals[i] = canonF32(track.values[i]);

    rawDataBytes += nameBytes.byteLength + sampleCount * 4 + sampleCount * comps * 4;

    let valBytes: Uint8Array;
    if (compression === "quant16") {
      if (valueType === VALUE_TYPE_QUAT) {
        const res = encodeQuantQuat(srcVals, sampleCount);
        valBytes = res.buf;
        if (res.maxAngleRad > maxRotationErrorRad) maxRotationErrorRad = res.maxAngleRad;
      } else {
        const res = encodeQuantVec3(srcVals, sampleCount);
        valBytes = res.buf;
        if (valueType === VALUE_TYPE_POS && res.maxErr > maxPositionErrorM) {
          maxPositionErrorM = res.maxErr;
        }
      }
    } else {
      valBytes = new Uint8Array(sampleCount * comps * 4);
      const dv = new DataView(valBytes.buffer);
      for (let i = 0; i < srcVals.length; i++) dv.setFloat32(i * 4, srcVals[i], true);
    }

    encodedTracks.push({
      nameOff,
      nameLen: nameBytes.byteLength,
      valueType,
      sampleCount,
      times,
      valBytes,
    });
  }

  const strBytesAligned = align4(strCursor);
  const descBase = CLIP_HEADER_BYTES;
  const strBase = descBase + encodedTracks.length * TRACK_DESC_BYTES;
  let dataCursor = strBase + strBytesAligned;

  const timesOffsets: number[] = [];
  const valOffsets: number[] = [];
  for (const et of encodedTracks) {
    timesOffsets.push(dataCursor);
    dataCursor += et.sampleCount * 4;
    valOffsets.push(dataCursor);
    dataCursor += align4(et.valBytes.byteLength);
  }

  const out = new Uint8Array(dataCursor);
  const view = new DataView(out.buffer);
  view.setUint32(0, BAKED_CLIP_MAGIC, true);
  view.setUint32(4, BAKED_CLIP_VERSION, true);
  view.setUint32(8, compCode, true);
  view.setUint32(12, loop ? 1 : 0, true);
  view.setFloat32(16, canonF32(clip.duration), true);
  view.setFloat32(20, canonF32(rate), true);
  view.setUint32(24, frames >>> 0, true);
  view.setUint32(28, encodedTracks.length >>> 0, true);
  view.setFloat32(32, canonF32(travel[0]), true);
  view.setFloat32(36, canonF32(travel[1]), true);

  for (let i = 0; i < encodedTracks.length; i++) {
    const et = encodedTracks[i];
    const dOff = descBase + i * TRACK_DESC_BYTES;
    view.setUint32(dOff, et.nameOff, true);
    view.setUint32(dOff + 4, et.nameLen, true);
    view.setUint32(dOff + 8, et.valueType, true);
    view.setUint32(dOff + 12, et.sampleCount, true);
    view.setUint32(dOff + 16, timesOffsets[i], true);
    view.setUint32(dOff + 20, valOffsets[i], true);
  }

  let sOff = strBase;
  for (const chunk of strChunks) {
    out.set(chunk, sOff);
    sOff += chunk.byteLength;
  }

  for (let i = 0; i < encodedTracks.length; i++) {
    const et = encodedTracks[i];
    let tOff = timesOffsets[i];
    for (let k = 0; k < et.times.length; k++) {
      view.setFloat32(tOff, et.times[k], true);
      tOff += 4;
    }
    out.set(et.valBytes, valOffsets[i]);
  }

  return {
    bytes: out,
    stats: {
      compression,
      rawBytes: rawDataBytes,
      compressedBytes: out.byteLength,
      compressionRatio: rawDataBytes > 0 ? out.byteLength / rawDataBytes : 1,
      maxPositionErrorM,
      maxRotationErrorRad,
      trackCount: encodedTracks.length,
      sampleCountTotal,
    },
  };
}

/** Decode a baked SoA clip slice directly into a playable `THREE.AnimationClip`. */
export function decodeBakedClipRecord(
  bytes: Uint8Array,
  clipName: string,
  byteOffset = 0,
  byteLength?: number,
): DecodedBakedClip {
  const len = byteLength ?? bytes.byteLength - byteOffset;
  if (byteOffset < 0 || len < CLIP_HEADER_BYTES || byteOffset + len > bytes.byteLength) {
    throw new Error(`invalid baked clip slice [${byteOffset}..${byteOffset + len})`);
  }
  const abs = bytes.byteOffset + byteOffset;
  const view = new DataView(bytes.buffer, abs, len);
  const magic = view.getUint32(0, true);
  if (magic !== BAKED_CLIP_MAGIC) {
    throw new Error(`bad baked clip magic 0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== BAKED_CLIP_VERSION) {
    throw new Error(`unsupported baked clip version ${version}`);
  }
  const compCode = view.getUint32(8, true);
  const compression: ClipCompressionMode = compCode === 1 ? "quant16" : "none";
  const flags = view.getUint32(12, true);
  const loop = (flags & 1) !== 0;
  const duration = view.getFloat32(16, true);
  const rate = view.getFloat32(20, true);
  const frames = view.getUint32(24, true);
  const trackCount = view.getUint32(28, true);
  const travel: [number, number] = [view.getFloat32(32, true), view.getFloat32(36, true)];

  const strBase = CLIP_HEADER_BYTES + trackCount * TRACK_DESC_BYTES;
  const dec = new TextDecoder();
  const tracks: THREE.KeyframeTrack[] = [];

  for (let i = 0; i < trackCount; i++) {
    const dOff = CLIP_HEADER_BYTES + i * TRACK_DESC_BYTES;
    const nameOff = view.getUint32(dOff, true);
    const nameLen = view.getUint32(dOff + 4, true);
    const valueType = view.getUint32(dOff + 8, true);
    const sampleCount = view.getUint32(dOff + 12, true);
    const timesOff = view.getUint32(dOff + 16, true);
    const valuesOff = view.getUint32(dOff + 20, true);

    const trackName = dec.decode(new Uint8Array(bytes.buffer, abs + strBase + nameOff, nameLen));

    const times = new Float32Array(sampleCount);
    for (let k = 0; k < sampleCount; k++) times[k] = view.getFloat32(timesOff + k * 4, true);

    if (valueType === VALUE_TYPE_QUAT) {
      const vals = new Float32Array(sampleCount * 4);
      if (compression === "quant16") {
        for (let k = 0; k < sampleCount; k++) {
          const base = valuesOff + k * 8;
          const qx = (view.getUint16(base, true) / 65535) * 2 - 1;
          const qy = (view.getUint16(base + 2, true) / 65535) * 2 - 1;
          const qz = (view.getUint16(base + 4, true) / 65535) * 2 - 1;
          const qw = (view.getUint16(base + 6, true) / 65535) * 2 - 1;
          const qLen = Math.hypot(qx, qy, qz, qw) || 1;
          vals[k * 4] = qx / qLen;
          vals[k * 4 + 1] = qy / qLen;
          vals[k * 4 + 2] = qz / qLen;
          vals[k * 4 + 3] = qw / qLen;
        }
      } else {
        for (let k = 0; k < vals.length; k++) vals[k] = view.getFloat32(valuesOff + k * 4, true);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(trackName, times, vals));
    } else {
      const vals = new Float32Array(sampleCount * 3);
      if (compression === "quant16") {
        const mins = [view.getFloat32(valuesOff, true), view.getFloat32(valuesOff + 4, true), view.getFloat32(valuesOff + 8, true)];
        const spans = [view.getFloat32(valuesOff + 12, true), view.getFloat32(valuesOff + 16, true), view.getFloat32(valuesOff + 20, true)];
        const qBase = valuesOff + 24;
        for (let k = 0; k < sampleCount; k++) {
          for (let c = 0; c < 3; c++) {
            const q = view.getUint16(qBase + (k * 3 + c) * 2, true);
            vals[k * 3 + c] = mins[c] + (q / 65535) * spans[c];
          }
        }
      } else {
        for (let k = 0; k < vals.length; k++) vals[k] = view.getFloat32(valuesOff + k * 4, true);
      }
      tracks.push(new THREE.VectorKeyframeTrack(trackName, times, vals));
    }
  }

  return {
    clip: new THREE.AnimationClip(clipName, duration, tracks),
    compression,
    duration,
    rate,
    frames,
    loop,
    travel,
  };
}

/** Decode all clips in a baked clip chunk into `THREE.AnimationClip[]` + `AnimationClipInfo[]`. */
export function decodeBakedClipsFromChunk(
  rawManifest: BakedClipManifest,
  chunkBytes: Uint8Array,
): { manifest: BakedClipManifest; clips: THREE.AnimationClip[]; info: AnimationClipInfo[] } {
  const manifest = BakedClipManifestSchema.parse(rawManifest);
  if (chunkBytes.byteLength !== manifest.chunkBytes) {
    throw new Error(`clip chunk byte length ${chunkBytes.byteLength} != expected ${manifest.chunkBytes}`);
  }
  const clips: THREE.AnimationClip[] = [];
  const info: AnimationClipInfo[] = [];
  for (const entry of manifest.clips) {
    const dec = decodeBakedClipRecord(chunkBytes, entry.id, entry.byteOffset, entry.byteLength);
    clips.push(dec.clip);
    info.push({
      name: entry.id,
      source: entry.source,
      duration: entry.duration,
      loop: entry.loop,
      travel: entry.travel,
    });
  }
  return { manifest, clips, info };
}
