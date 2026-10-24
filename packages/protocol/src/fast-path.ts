/**
 * Fast-path v1: a frozen-layout binary encoding for the hottest per-tick
 * data — position + linear velocity deltas (Phase 5, Part B).
 *
 * The FlatBuffers Delta carries everything (transforms, velocities,
 * intents, chunks, health, ...) with table/vector overhead per entity.
 * On a busy tick the overwhelming majority of changed rows are
 * position + linear velocity, so those two columns get a fixed struct
 * array instead: no builder, no tables, one straight DataView pass.
 * Everything else stays in the FlatBuffers Delta — the fast path is a
 * supplement for the hottest columns, never a replacement for the
 * full delta. A tick whose delta is position/velocity-only may be
 * sent as fast-path alone; a tick with any other changed column still
 * sends the FlatBuffers Delta (the fast path simply doesn't apply).
 *
 * Layout (all little-endian, frozen at version 1):
 *
 *   Header (12 bytes):
 *     [0]    u8  magic    0x46 ('F')
 *     [1]    u8  version  1
 *     [2..3] u16 reserved 0 (must be zero on decode)
 *     [4..7] u32 tick
 *     [8..11]u32 count (records)
 *   Record (32 bytes, repeated `count` times):
 *     [0..7]   u64 wireId
 *     [8..11]  f32 px   [12..15] f32 py   [16..19] f32 pz
 *     [20..23] f32 lx   [24..27] f32 ly   [28..31] f32 lz
 *
 * Precision matches the wire exactly: the FlatBuffers Transform /
 * Velocity tables already store these fields as f32, so a fast-path
 * record round-trips to the same f32 values the FlatBuffers Delta
 * would carry (JS numbers are f64; encode rounds once via f32, decode
 * returns that f32 value exactly).
 *
 * Versioning: the version byte is checked before anything else is
 * trusted. An unknown version is NEVER parsed as v1 — decode throws
 * FastPathError, and tryDecodeFastDelta reports `{ ok: false }` so the
 * caller falls back to the FlatBuffers Delta. The layout may only
 * evolve by bumping the version (a new decoder branch), never by
 * reinterpreting v1 bytes.
 *
 * Fail-closed decoding: bad magic, short/truncated buffers, trailing
 * bytes, a nonzero reserved field, or a non-finite coordinate all
 * reject. A corrupt fast-path payload must surface as an error the
 * caller can fall back from — never as silently misread positions.
 *
 * No gateway wiring yet: the live broadcast still sends FlatBuffers
 * Deltas (the mirror client has no fast-path decoder). This module is
 * the versioned codec + the SoA encoder the gateway will call once
 * the client can decode it; until then it is exercised by tests and
 * benchmarks only, so no client-visible byte ever changes.
 */

import type { TransformSoA, VelocitySoA } from "./codec.js";

/** The only Transform columns the fast path reads (position). */
export type FastPathTransformColumns = Pick<TransformSoA, "eids" | "wireIdOf" | "px" | "py" | "pz">;
/** The only Velocity columns the fast path reads (linear velocity). */
export type FastPathVelocityColumns = Pick<VelocitySoA, "eids" | "wireIdOf" | "lx" | "ly" | "lz">;

/** Magic byte: 'F'. */
export const FAST_PATH_MAGIC = 0x46;
/** The only version this codec writes or understands. */
export const FAST_PATH_VERSION = 1;
export const FAST_PATH_HEADER_BYTES = 12;
export const FAST_PATH_RECORD_BYTES = 32;

/** One fast-path record: an entity's position + linear velocity. */
export interface FastPathEntry {
  wireId: bigint;
  px: number;
  py: number;
  pz: number;
  lx: number;
  ly: number;
  lz: number;
}

/** Thrown by decodeFastDelta on any malformed payload (see fail-closed notes above). */
export class FastPathError extends Error {
  constructor(message: string) {
    super(`fast-path: ${message}`);
    this.name = "FastPathError";
  }
}

const U32_MAX = 0xffffffff;

function checkTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0 || tick > U32_MAX) {
    throw new RangeError(`fast-path: tick must be a u32 integer (got ${tick})`);
  }
}

/**
 * Encode `entries` for `tick` into the frozen v1 layout. Pure: no
 * allocation beyond the output buffer.
 */
export function encodeFastDelta(tick: number, entries: readonly FastPathEntry[]): Uint8Array {
  checkTick(tick);
  if (entries.length > U32_MAX) throw new RangeError("fast-path: too many entries");
  const out = new Uint8Array(FAST_PATH_HEADER_BYTES + entries.length * FAST_PATH_RECORD_BYTES);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, FAST_PATH_MAGIC);
  view.setUint8(1, FAST_PATH_VERSION);
  view.setUint16(2, 0, true);
  view.setUint32(4, tick, true);
  view.setUint32(8, entries.length, true);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const o = FAST_PATH_HEADER_BYTES + i * FAST_PATH_RECORD_BYTES;
    view.setBigUint64(o, e.wireId, true);
    view.setFloat32(o + 8, e.px, true);
    view.setFloat32(o + 12, e.py, true);
    view.setFloat32(o + 16, e.pz, true);
    view.setFloat32(o + 20, e.lx, true);
    view.setFloat32(o + 24, e.ly, true);
    view.setFloat32(o + 28, e.lz, true);
  }
  return out;
}

/**
 * Strict decode: throws FastPathError on any malformed payload
 * (bad magic, unknown version, nonzero reserved, truncated or
 * trailing bytes, non-finite coordinates). Use tryDecodeFastDelta
 * when the caller wants to fall back to FlatBuffers instead.
 */
export function decodeFastDelta(bytes: Uint8Array): { tick: number; entries: FastPathEntry[] } {
  if (bytes.length < FAST_PATH_HEADER_BYTES) {
    throw new FastPathError(`short buffer (${bytes.length} < ${FAST_PATH_HEADER_BYTES} header bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== FAST_PATH_MAGIC) {
    throw new FastPathError(`bad magic 0x${view.getUint8(0).toString(16)} (expected 0x${FAST_PATH_MAGIC.toString(16)})`);
  }
  const version = view.getUint8(1);
  if (version !== FAST_PATH_VERSION) {
    throw new FastPathError(`unsupported version ${version} (this codec understands ${FAST_PATH_VERSION})`);
  }
  if (view.getUint16(2, true) !== 0) {
    throw new FastPathError(`nonzero reserved field (0x${view.getUint16(2, true).toString(16)})`);
  }
  const tick = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const expected = FAST_PATH_HEADER_BYTES + count * FAST_PATH_RECORD_BYTES;
  if (bytes.length !== expected) {
    throw new FastPathError(
      `length mismatch: header says ${count} records (${expected} bytes), buffer holds ${bytes.length}`,
    );
  }
  const entries: FastPathEntry[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = FAST_PATH_HEADER_BYTES + i * FAST_PATH_RECORD_BYTES;
    const entry: FastPathEntry = {
      wireId: view.getBigUint64(o, true),
      px: view.getFloat32(o + 8, true),
      py: view.getFloat32(o + 12, true),
      pz: view.getFloat32(o + 16, true),
      lx: view.getFloat32(o + 20, true),
      ly: view.getFloat32(o + 24, true),
      lz: view.getFloat32(o + 28, true),
    };
    for (const v of [entry.px, entry.py, entry.pz, entry.lx, entry.ly, entry.lz]) {
      if (!Number.isFinite(v)) throw new FastPathError(`non-finite coordinate in record ${i}`);
    }
    entries[i] = entry;
  }
  return { tick, entries };
}

export type FastPathDecodeResult =
  | { ok: true; tick: number; entries: FastPathEntry[] }
  | { ok: false; reason: string };

/**
 * Non-throwing decode for the fallback path: `{ ok: false }` means
 * "not a fast-path payload I understand — decode the FlatBuffers
 * Delta instead". Unknown versions land here (never misread as v1).
 */
export function tryDecodeFastDelta(bytes: Uint8Array): FastPathDecodeResult {
  try {
    const { tick, entries } = decodeFastDelta(bytes);
    return { ok: true, tick, entries };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build a fast-path payload directly from the SAB-backed SoA stores
 * (Phase 3 style: no row-object copy). Only the INTERSECTION of the
 * two blocks is encodable — an entity needs both a changed transform
 * and a changed velocity to appear. Entities in one block only
 * (rotated in place, or pushed without moving) stay in the FlatBuffers
 * Delta; angular velocity is never in the fast path either.
 *
 * Returns null when the intersection is empty: the fast path doesn't
 * apply to this tick, and the caller sends the FlatBuffers Delta.
 */
export function encodeFastDeltaFromSoA(
  tick: number,
  transforms: FastPathTransformColumns,
  velocities: FastPathVelocityColumns,
): Uint8Array | null {
  checkTick(tick);
  // Slot set of the velocity block, for the intersection lookup.
  // Stores are indexed by slot, so membership is all the lookup needs.
  const tEids = transforms.eids;
  const vEids = velocities.eids;
  const vSlots = new Set<number>();
  for (let i = 0; i < vEids.length; i++) vSlots.add(vEids[i]);
  const entries: FastPathEntry[] = [];
  for (let i = 0; i < tEids.length; i++) {
    const eid = tEids[i];
    if (!vSlots.has(eid)) continue;
    entries.push({
      wireId: transforms.wireIdOf(eid),
      px: transforms.px[eid],
      py: transforms.py[eid],
      pz: transforms.pz[eid],
      // Stores are indexed by slot, so the velocity row's slot is `eid`.
      lx: velocities.lx[eid],
      ly: velocities.ly[eid],
      lz: velocities.lz[eid],
    });
  }
  if (entries.length === 0) return null;
  return encodeFastDelta(tick, entries);
}
