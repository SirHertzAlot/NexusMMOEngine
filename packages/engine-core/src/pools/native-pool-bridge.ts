/**
 * Native C++ N-API Zero-Copy Bridge & Cache-Coherent Pure-TS Parity Scanner
 * for SpawnPoolSoA (AGENTS.md §4 & §6).
 *
 * Crosses the N-API boundary with flat TypedArray views directly backed by the
 * single L2-resident SharedArrayBuffer (zero object traversal, zero GC).
 */

import {
  SPAWN_POOL_MAGIC,
  type SpawnPoolSoA,
} from "./spawn-pool-soa.js";

const STATE_COOLDOWN_RESPAWN = 2;
const STATE_LOCKED = 4;
const HDR_MAGIC_WORD = 0;
const HDR_HIGH_WATER_WORD = 4;

/**
 * Flat TypedArray handle bundle suitable for `napi_get_typedarray_info` zero-copy
 * C++ pointer extraction (`AGENTS.md §4`).
 */
export interface NativePoolSoABundle {
  readonly capacity: number;
  readonly activeCount: number;
  readonly highWater: number;
  readonly sab: SharedArrayBuffer;
  readonly headerI32: Int32Array;
  readonly kind: Uint8Array;
  readonly state: Uint8Array;
  readonly flags: Uint8Array;
  readonly liveEid: Int32Array;
  readonly stock: Int32Array;
  readonly homeX: Float32Array;
  readonly homeY: Float32Array;
  readonly homeZ: Float32Array;
  readonly footprintRadiusM: Float32Array;
  readonly respawnAtMs: Float64Array;
}

/**
 * Canonical C++ N-API kernel signature matching `scanReadySlotsSoA`.
 * A native addon acquires raw pointers once per column via `napi_get_typedarray_info`.
 */
export type NativeScanReadySlotsFn = (
  state: Uint8Array,
  kind: Uint8Array,
  respawnAtMs: Float64Array,
  highWater: number,
  nowMs: number,
  outSlotIndices: Int32Array,
  kindFilter: number,
) => number;

/**
 * Export the flat zero-copy TypedArray bundle for a `SpawnPoolSoA` instance.
 * Call once after pool creation/load; pass the resulting TypedArray columns
 * across N-API without per-entity JS property traversal.
 */
export function exportNativePoolSoA(pool: SpawnPoolSoA): NativePoolSoABundle {
  return {
    capacity: pool.capacity,
    activeCount: pool.activeCount,
    highWater: pool.highWater,
    sab: pool.sab,
    headerI32: pool.headerI32,
    kind: pool.kind,
    state: pool.state,
    flags: pool.flags,
    liveEid: pool.liveEid,
    stock: pool.stock,
    homeX: pool.homeX,
    homeY: pool.homeY,
    homeZ: pool.homeZ,
    footprintRadiusM: pool.footprintRadiusM,
    respawnAtMs: pool.respawnAtMs,
  };
}

export type ReadySlotBundleView = Pick<
  NativePoolSoABundle,
  "capacity" | "state" | "kind" | "respawnAtMs"
> & {
  readonly highWater?: number;
  readonly headerI32?: Int32Array;
};

/**
 * Pure-TS cache-coherent ready-slot scanner matching native C++ SoA scan semantics.
 * Scans contiguous L2-resident columns `state`, `kind`, and `respawnAtMs` up to live
 * `highWater` (falling back to `bundle.highWater ?? bundle.capacity`) with zero heap
 * allocations, zero closures, and zero clock syscalls.
 */
export function scanReadySlotsSoA(
  bundle: ReadySlotBundleView,
  nowMs: number,
  outSlotIndices: Int32Array,
  kindFilter = 0,
  claim = false,
): number {
  const maxOut = outSlotIndices.length;
  if (maxOut === 0 || !Number.isFinite(nowMs)) return 0;

  const state = bundle.state;
  const kind = bundle.kind;
  const respawnAtMs = bundle.respawnAtMs;
  const hdr = bundle.headerI32;

  let limit: number;
  if (hdr !== undefined && hdr.length > HDR_HIGH_WATER_WORD && (hdr[HDR_MAGIC_WORD]! >>> 0) === SPAWN_POOL_MAGIC) {
    limit = hdr[HDR_HIGH_WATER_WORD]!;
  } else {
    limit = bundle.highWater ?? bundle.capacity;
  }

  if (limit > state.length) limit = state.length;
  if (limit > kind.length) limit = kind.length;
  if (limit > respawnAtMs.length) limit = respawnAtMs.length;

  let found = 0;
  if (kindFilter === 0) {
    for (let i = 0; i < limit; i++) {
      if (state[i] === STATE_COOLDOWN_RESPAWN && respawnAtMs[i]! <= nowMs) {
        outSlotIndices[found++] = i;
        if (claim) {
          state[i] = STATE_LOCKED;
          respawnAtMs[i] = Number.NaN;
        }
        if (found >= maxOut) break;
      }
    }
  } else {
    for (let i = 0; i < limit; i++) {
      if (
        state[i] === STATE_COOLDOWN_RESPAWN &&
        kind[i] === kindFilter &&
        respawnAtMs[i]! <= nowMs
      ) {
        outSlotIndices[found++] = i;
        if (claim) {
          state[i] = STATE_LOCKED;
          respawnAtMs[i] = Number.NaN;
        }
        if (found >= maxOut) break;
      }
    }
  }
  return found;
}
