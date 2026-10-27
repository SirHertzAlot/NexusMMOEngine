/**
 * Type declarations for @mmo-engine/addon-codec.
 */

export interface FastPathEntry {
  wireId: bigint;
  px: number;
  py: number;
  pz: number;
  lx: number;
  ly: number;
  lz: number;
}

export type FastPathDecodeResult =
  | { ok: true; tick: number; entries: FastPathEntry[] }
  | { ok: false; reason: string };

export const FAST_PATH_MAGIC: number;
export const FAST_PATH_VERSION: number;
export const FAST_PATH_HEADER_BYTES: number;
export const FAST_PATH_RECORD_BYTES: number;

export function encodeFastDelta(tick: number, entries: readonly FastPathEntry[]): Uint8Array;
export function decodeFastDelta(bytes: Uint8Array): { tick: number; entries: FastPathEntry[] };
export function tryDecodeFastDelta(bytes: Uint8Array): FastPathDecodeResult;
export function encodeFastDeltaFromSoA(
  tick: number,
  transforms: { eids: number[] | Uint32Array | Int32Array; wireIdOf: (eid: number) => bigint; px: Float64Array | Float32Array; py: Float64Array | Float32Array; pz: Float64Array | Float32Array },
  velocities: { eids: number[] | Uint32Array | Int32Array; wireIdOf: (eid: number) => bigint; lx: Float64Array | Float32Array; ly: Float64Array | Float32Array; lz: Float64Array | Float32Array }
): Uint8Array | null;
export function encodeFastDeltaSoABulk(
  tick: number,
  tEids: Uint32Array,
  tWireIds: BigUint64Array,
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  vEids: Uint32Array,
  lx: Float64Array,
  ly: Float64Array,
  lz: Float64Array
): Uint8Array | null;
