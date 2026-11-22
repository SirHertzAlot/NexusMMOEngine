/**
 * SpawnPoolSoA — Canonical SharedArrayBuffer Structure-of-Arrays (SoA) Binary
 * Format ("MMOS" v1) & Zero-Allocation Respawn Pool Container.
 *
 * Adheres strictly to AGENTS.md §4 & §6:
 * - Single contiguous SharedArrayBuffer sized for CPU L2/L3 cache residency
 *   (<= DEFAULT_L2_CACHE_BYTES = 2 MiB default, e.g. 16,384 slots).
 * - All SoA columns start on 8-byte aligned offsets so Float64Array views
 *   never misalign and native N-API addons can bind raw pointers once.
 * - Zero heap allocations, zero closures, zero per-item clock traps inside
 *   `scheduleRespawn`, `markActive`, `decrementStock`, and `pollReady`.
 * - 16-bit generation counters (`1..65535`, wrapping `65535 -> 1`) prevent
 *   stale-slot ABA bugs across alloc/free cycles.
 * - Packed handle convention: `((generation << 16) | index) >>> 0` (>= 65536).
 *   `INVALID_POOL_HANDLE = 0` is returned cleanly when the pool is full or a
 *   lookup misses; duplicate live keys and non-finite inputs throw loudly.
 */

import { fnv1a32 } from "@mmo-engine/scatter";

export { fnv1a32 };

export const SPAWN_POOL_MAGIC = 0x4d4d4f53; // "MMOS"
export const SPAWN_POOL_VERSION = 1;
export const SPAWN_POOL_HEADER_BYTES = 48;
export const DEFAULT_L2_CACHE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_POOL_CAPACITY = 16_384;
export const MAX_POOL_CAPACITY = 65_536;
export const INVALID_POOL_HANDLE = 0;

export const RespawnKind = {
  Creature: 1,
  ResourceNode: 2,
  CivicVein: 3,
  Chest: 4,
  BreakableProp: 5,
  Resident: 6,
} as const;
export type RespawnKind = (typeof RespawnKind)[keyof typeof RespawnKind];

export const SlotState = {
  Free: 0,
  Active: 1,
  CooldownRespawn: 2,
  Exhausted: 3,
  Locked: 4,
} as const;
export type SlotState = (typeof SlotState)[keyof typeof SlotState];

export const PoolSlotFlags = {
  None: 0,
  Baseline: 1 << 0,
  Aquatic: 1 << 1,
  Persistent: 1 << 2,
  Dirty: 1 << 3,
} as const;
export type PoolSlotFlags = (typeof PoolSlotFlags)[keyof typeof PoolSlotFlags];
export const PoolFlags = PoolSlotFlags;

// Inlined numeric constants for hot-loop V8 register-indirect access (AGENTS.md §6)
const STATE_FREE = 0;
const STATE_ACTIVE = 1;
const STATE_COOLDOWN_RESPAWN = 2;
const STATE_EXHAUSTED = 3;
const STATE_LOCKED = 4;

const KIND_MIN = 1;
const KIND_MAX = 6;
const FLAG_DIRTY = 1 << 3;

// 48-byte little-endian header word offsets (Int32 / Uint32 words 0..11)
const W_MAGIC = 0;
const W_VERSION = 1;
const W_CAPACITY = 2;
const W_ACTIVE_COUNT = 3;
const W_HIGH_WATER = 4;
const W_KEY_CAP = 5;
const W_KEY_USED = 6;
const W_SAB_BYTES = 7;
const W_LAYOUT_FLAGS = 8;
const W_FREE_TOP = 9;
const W_CHECKSUM = 10;
const W_BODY_BYTES = 11;

const MAX_KEY_BYTES_LEN = 65_535;
const KEY_SCRATCH_BYTES = 4096;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const KEY_ENCODE_SCRATCH = new Uint8Array(KEY_SCRATCH_BYTES);
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02;

/** Precomputed IEEE 802.3 CRC-32 lookup table (zero allocation per call). */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** Update a running IEEE 802.3 CRC-32 over `bytes[start..end)`. */
export function updateCrc32(
  crc: number,
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Compute IEEE 802.3 CRC-32 over `bytes[start..end)`. */
export function crc32Bytes(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): number {
  return updateCrc32(0, bytes, start, end);
}

/** Pack a 16-bit slot index and 16-bit generation (>= 1) into a non-zero uint32 handle. */
export function packPoolHandle(index: number, generation: number): number {
  return (((generation & 0xffff) << 16) | (index & 0xffff)) >>> 0;
}

/** Unpack a packed 32-bit pool handle into `{ index, generation }`. */
export function unpackPoolHandle(handle: number): { index: number; generation: number } {
  return {
    index: handle & 0xffff,
    generation: (handle >>> 16) & 0xffff,
  };
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

/** Default key intern buffer size for a given slot capacity (fits within 2 MiB at 16,384 slots). */
export function defaultKeyBufferBytes(capacity: number): number {
  if (capacity === 0) return 0;
  return Math.max(1024, capacity * 32);
}

export interface SpawnPoolSabLayout {
  readonly capacity: number;
  readonly keyBytesCapacity: number;
  readonly headerBytes: number;
  readonly kindOffset: number;
  readonly stateOffset: number;
  readonly flagsOffset: number;
  readonly generationOffset: number;
  readonly keyStrLenOffset: number;
  readonly anchorIndexOffset: number;
  readonly keyHashOffset: number;
  readonly modelHashOffset: number;
  readonly archetypeHashOffset: number;
  readonly keyStrOffsetOffset: number;
  readonly liveEidOffset: number;
  readonly stockOffset: number;
  readonly maxStockOffset: number;
  readonly homeXOffset: number;
  readonly homeYOffset: number;
  readonly homeZOffset: number;
  readonly footprintRadiusMOffset: number;
  readonly respawnDelayMsOffset: number;
  readonly respawnAtMsOffset: number;
  readonly freeStackOffset: number;
  readonly keyBytesOffset: number;
  readonly totalBytes: number;
}

/** Compute 8-byte aligned column offsets for a `SpawnPoolSoA` SharedArrayBuffer. */
export function computePoolSabLayout(
  capacity: number,
  keyBytesCapacity: number = defaultKeyBufferBytes(capacity),
): SpawnPoolSabLayout {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_POOL_CAPACITY) {
    throw new RangeError(
      `SpawnPoolSoA: capacity must be an integer in [0, ${MAX_POOL_CAPACITY}] (got ${capacity})`,
    );
  }
  if (!Number.isInteger(keyBytesCapacity) || keyBytesCapacity < 0) {
    throw new RangeError(
      `SpawnPoolSoA: keyBytesCapacity must be a non-negative integer (got ${keyBytesCapacity})`,
    );
  }

  let cursor = SPAWN_POOL_HEADER_BYTES;
  const take = (bytes: number): number => {
    const off = cursor;
    cursor = align8(cursor + bytes);
    return off;
  };

  const kindOffset = take(capacity * 1);
  const stateOffset = take(capacity * 1);
  const flagsOffset = take(capacity * 1);
  const generationOffset = take(capacity * 2);
  const keyStrLenOffset = take(capacity * 2);
  const anchorIndexOffset = take(capacity * 2);
  const keyHashOffset = take(capacity * 4);
  const modelHashOffset = take(capacity * 4);
  const archetypeHashOffset = take(capacity * 4);
  const keyStrOffsetOffset = take(capacity * 4);
  const liveEidOffset = take(capacity * 4);
  const stockOffset = take(capacity * 4);
  const maxStockOffset = take(capacity * 4);
  const homeXOffset = take(capacity * 4);
  const homeYOffset = take(capacity * 4);
  const homeZOffset = take(capacity * 4);
  const footprintRadiusMOffset = take(capacity * 4);
  const respawnDelayMsOffset = take(capacity * 8);
  const respawnAtMsOffset = take(capacity * 8);
  const freeStackOffset = take(capacity * 4);
  const keyBytesOffset = take(keyBytesCapacity);

  return {
    capacity,
    keyBytesCapacity,
    headerBytes: SPAWN_POOL_HEADER_BYTES,
    kindOffset,
    stateOffset,
    flagsOffset,
    generationOffset,
    keyStrLenOffset,
    anchorIndexOffset,
    keyHashOffset,
    modelHashOffset,
    archetypeHashOffset,
    keyStrOffsetOffset,
    liveEidOffset,
    stockOffset,
    maxStockOffset,
    homeXOffset,
    homeYOffset,
    homeZOffset,
    footprintRadiusMOffset,
    respawnDelayMsOffset,
    respawnAtMsOffset,
    freeStackOffset,
    keyBytesOffset,
    totalBytes: cursor,
  };
}

interface BinaryBodyLayout {
  readonly kindOffset: number;
  readonly stateOffset: number;
  readonly flagsOffset: number;
  readonly generationOffset: number;
  readonly keyStrLenOffset: number;
  readonly anchorIndexOffset: number;
  readonly keyHashOffset: number;
  readonly modelHashOffset: number;
  readonly archetypeHashOffset: number;
  readonly keyStrOffsetOffset: number;
  readonly liveEidOffset: number;
  readonly stockOffset: number;
  readonly maxStockOffset: number;
  readonly homeXOffset: number;
  readonly homeYOffset: number;
  readonly homeZOffset: number;
  readonly footprintRadiusMOffset: number;
  readonly respawnDelayMsOffset: number;
  readonly respawnAtMsOffset: number;
  readonly keyBytesOffset: number;
  readonly bodyBytes: number;
}

function computePoolBinaryLayout(highWater: number, keyBytesUsed: number): BinaryBodyLayout {
  if (highWater === 0 && keyBytesUsed === 0) {
    return {
      kindOffset: SPAWN_POOL_HEADER_BYTES,
      stateOffset: SPAWN_POOL_HEADER_BYTES,
      flagsOffset: SPAWN_POOL_HEADER_BYTES,
      generationOffset: SPAWN_POOL_HEADER_BYTES,
      keyStrLenOffset: SPAWN_POOL_HEADER_BYTES,
      anchorIndexOffset: SPAWN_POOL_HEADER_BYTES,
      keyHashOffset: SPAWN_POOL_HEADER_BYTES,
      modelHashOffset: SPAWN_POOL_HEADER_BYTES,
      archetypeHashOffset: SPAWN_POOL_HEADER_BYTES,
      keyStrOffsetOffset: SPAWN_POOL_HEADER_BYTES,
      liveEidOffset: SPAWN_POOL_HEADER_BYTES,
      stockOffset: SPAWN_POOL_HEADER_BYTES,
      maxStockOffset: SPAWN_POOL_HEADER_BYTES,
      homeXOffset: SPAWN_POOL_HEADER_BYTES,
      homeYOffset: SPAWN_POOL_HEADER_BYTES,
      homeZOffset: SPAWN_POOL_HEADER_BYTES,
      footprintRadiusMOffset: SPAWN_POOL_HEADER_BYTES,
      respawnDelayMsOffset: SPAWN_POOL_HEADER_BYTES,
      respawnAtMsOffset: SPAWN_POOL_HEADER_BYTES,
      keyBytesOffset: SPAWN_POOL_HEADER_BYTES,
      bodyBytes: 0,
    };
  }
  let cursor = SPAWN_POOL_HEADER_BYTES;
  const take = (bytes: number): number => {
    const off = cursor;
    cursor = align8(cursor + bytes);
    return off;
  };
  const kindOffset = take(highWater * 1);
  const stateOffset = take(highWater * 1);
  const flagsOffset = take(highWater * 1);
  const generationOffset = take(highWater * 2);
  const keyStrLenOffset = take(highWater * 2);
  const anchorIndexOffset = take(highWater * 2);
  const keyHashOffset = take(highWater * 4);
  const modelHashOffset = take(highWater * 4);
  const archetypeHashOffset = take(highWater * 4);
  const keyStrOffsetOffset = take(highWater * 4);
  const liveEidOffset = take(highWater * 4);
  const stockOffset = take(highWater * 4);
  const maxStockOffset = take(highWater * 4);
  const homeXOffset = take(highWater * 4);
  const homeYOffset = take(highWater * 4);
  const homeZOffset = take(highWater * 4);
  const footprintRadiusMOffset = take(highWater * 4);
  const respawnDelayMsOffset = take(highWater * 8);
  const respawnAtMsOffset = take(highWater * 8);
  const keyBytesOffset = take(keyBytesUsed);

  return {
    kindOffset,
    stateOffset,
    flagsOffset,
    generationOffset,
    keyStrLenOffset,
    anchorIndexOffset,
    keyHashOffset,
    modelHashOffset,
    archetypeHashOffset,
    keyStrOffsetOffset,
    liveEidOffset,
    stockOffset,
    maxStockOffset,
    homeXOffset,
    homeYOffset,
    homeZOffset,
    footprintRadiusMOffset,
    respawnDelayMsOffset,
    respawnAtMsOffset,
    keyBytesOffset,
    bodyBytes: cursor - SPAWN_POOL_HEADER_BYTES,
  };
}

export interface SpawnPoolOptions {
  capacity?: number;
  keyBufferBytes?: number;
  maxBudgetBytes?: number;
}

export interface DecodeSpawnPoolOptions {
  capacity?: number;
  maxBudgetBytes?: number;
}

export interface FromSharedBufferOptions {
  maxBudgetBytes?: number;
}

export interface AllocateSpawnSlotInput {
  key: string;
  kind: RespawnKind;
  state?: SlotState;
  flags?: number;
  modelId?: string;
  modelHash?: number;
  archetypeId?: string;
  archetypeHash?: number;
  liveEid?: number;
  stock?: number;
  maxStock?: number;
  anchorIndex?: number;
  homeX?: number;
  homeY?: number;
  homeZ?: number;
  footprintRadiusM?: number;
  respawnDelayMs?: number;
  respawnAtMs?: number;
}

export interface PoolUtilizationStats {
  capacity: number;
  activeCount: number;
  highWater: number;
  freeCount: number;
  byteLength: number;
  maxBudgetBytes: number;
  utilizationPct: number;
  slotUtilizationPct: number;
  keyBytesUsed: number;
  keyBytesCapacity: number;
  keyUtilizationPct: number;
  byState: {
    free: number;
    active: number;
    cooldownRespawn: number;
    exhausted: number;
    locked: number;
  };
  byKind: {
    creature: number;
    resourceNode: number;
    civicVein: number;
    chest: number;
    breakableProp: number;
    resident: number;
  };
}

function isValidRespawnKind(kind: number): boolean {
  return Number.isInteger(kind) && kind >= KIND_MIN && kind <= KIND_MAX;
}

function isValidSlotState(state: number): boolean {
  return Number.isInteger(state) && state >= STATE_FREE && state <= STATE_LOCKED;
}

let pendingAttach: {
  sab: SharedArrayBuffer;
  layout: SpawnPoolSabLayout;
  maxBudgetBytes: number;
  externalKeyBytes: Uint8Array | null;
} | null = null;

/**
 * SharedArrayBuffer-backed Structure-of-Arrays (SoA) container for spawn &
 * respawn pools.
 *
 * Handle convention:
 * - Valid handles are non-zero unsigned 32-bit integers `((gen << 16) | idx) >>> 0`
 *   where `gen` is in `1..65535` (wrapping `65535 -> 1`) and `idx` is in `0..capacity-1`.
 * - `INVALID_POOL_HANDLE` (`0`) is returned cleanly by `allocateSlot` when at capacity
 *   and by `findByKey` / `findByKeyHash` when not found.
 * - Duplicate live keys throw `Error` in `allocateSlot` (call `findByKey` first if
 *   idempotency/dedup tallying is desired).
 */
export class SpawnPoolSoA {
  public readonly sab: SharedArrayBuffer;
  public readonly capacity: number;
  public readonly keyBytesCapacity: number;
  public readonly maxBudgetBytes: number;
  public readonly layout: SpawnPoolSabLayout;
  public readonly headerI32: Int32Array;
  private readonly headerU32: Uint32Array;

  public readonly kind: Uint8Array;
  public readonly state: Uint8Array;
  public readonly flags: Uint8Array;
  public readonly generation: Uint16Array;
  public readonly keyHash: Uint32Array;
  public readonly modelHash: Uint32Array;
  public readonly archetypeHash: Uint32Array;
  public readonly keyStrOffset: Uint32Array;
  public readonly keyStrLen: Uint16Array;
  public readonly liveEid: Int32Array;
  public readonly stock: Int32Array;
  public readonly maxStock: Int32Array;
  public readonly anchorIndex: Uint16Array;
  public readonly homeX: Float32Array;
  public readonly homeY: Float32Array;
  public readonly homeZ: Float32Array;
  public readonly footprintRadiusM: Float32Array;
  public readonly respawnDelayMs: Float64Array;
  public readonly respawnAtMs: Float64Array;
  public readonly freeStack: Int32Array;
  public readonly keyBytes: Uint8Array;

  private readonly externalKeyBytes: Uint8Array | null;
  private readonly keyToHandle = new Map<string, number>();
  private readonly hashToHandles = new Map<number, number | number[]>();

  constructor(opts: SpawnPoolOptions = {}) {
    const attached = pendingAttach;
    let sab: SharedArrayBuffer;
    let layout: SpawnPoolSabLayout;
    let maxBudgetBytes: number;
    let initFresh: boolean;
    let externalKeyBytes: Uint8Array | null;

    if (attached !== null) {
      pendingAttach = null;
      sab = attached.sab;
      layout = attached.layout;
      maxBudgetBytes = attached.maxBudgetBytes;
      externalKeyBytes = attached.externalKeyBytes;
      initFresh = false;
    } else {
      const capacity = opts.capacity ?? DEFAULT_POOL_CAPACITY;
      maxBudgetBytes = opts.maxBudgetBytes ?? DEFAULT_L2_CACHE_BYTES;
      if (!Number.isFinite(maxBudgetBytes) || maxBudgetBytes < SPAWN_POOL_HEADER_BYTES) {
        throw new RangeError(
          `SpawnPoolSoA: maxBudgetBytes must be >= ${SPAWN_POOL_HEADER_BYTES} (got ${maxBudgetBytes})`,
        );
      }
      const keyBufferBytes = opts.keyBufferBytes ?? defaultKeyBufferBytes(capacity);
      layout = computePoolSabLayout(capacity, keyBufferBytes);
      if (layout.totalBytes > maxBudgetBytes) {
        throw new RangeError(
          `SpawnPoolSoA: layout requires ${layout.totalBytes} bytes, exceeding L2 budget ${maxBudgetBytes} bytes (capacity=${capacity}, keyBufferBytes=${keyBufferBytes})`,
        );
      }
      sab = new SharedArrayBuffer(layout.totalBytes);
      externalKeyBytes = null;
      initFresh = true;
    }

    this.sab = sab;
    this.capacity = layout.capacity;
    this.keyBytesCapacity = layout.keyBytesCapacity;
    this.maxBudgetBytes = maxBudgetBytes;
    this.layout = layout;
    this.externalKeyBytes = externalKeyBytes;

    this.headerI32 = new Int32Array(sab, 0, SPAWN_POOL_HEADER_BYTES / 4);
    this.headerU32 = new Uint32Array(sab, 0, SPAWN_POOL_HEADER_BYTES / 4);

    this.kind = new Uint8Array(sab, layout.kindOffset, layout.capacity);
    this.state = new Uint8Array(sab, layout.stateOffset, layout.capacity);
    this.flags = new Uint8Array(sab, layout.flagsOffset, layout.capacity);
    this.generation = new Uint16Array(sab, layout.generationOffset, layout.capacity);
    this.keyStrLen = new Uint16Array(sab, layout.keyStrLenOffset, layout.capacity);
    this.anchorIndex = new Uint16Array(sab, layout.anchorIndexOffset, layout.capacity);
    this.keyHash = new Uint32Array(sab, layout.keyHashOffset, layout.capacity);
    this.modelHash = new Uint32Array(sab, layout.modelHashOffset, layout.capacity);
    this.archetypeHash = new Uint32Array(sab, layout.archetypeHashOffset, layout.capacity);
    this.keyStrOffset = new Uint32Array(sab, layout.keyStrOffsetOffset, layout.capacity);
    this.liveEid = new Int32Array(sab, layout.liveEidOffset, layout.capacity);
    this.stock = new Int32Array(sab, layout.stockOffset, layout.capacity);
    this.maxStock = new Int32Array(sab, layout.maxStockOffset, layout.capacity);
    this.homeX = new Float32Array(sab, layout.homeXOffset, layout.capacity);
    this.homeY = new Float32Array(sab, layout.homeYOffset, layout.capacity);
    this.homeZ = new Float32Array(sab, layout.homeZOffset, layout.capacity);
    this.footprintRadiusM = new Float32Array(sab, layout.footprintRadiusMOffset, layout.capacity);
    this.respawnDelayMs = new Float64Array(sab, layout.respawnDelayMsOffset, layout.capacity);
    this.respawnAtMs = new Float64Array(sab, layout.respawnAtMsOffset, layout.capacity);
    this.freeStack = new Int32Array(sab, layout.freeStackOffset, layout.capacity);
    this.keyBytes = new Uint8Array(sab, layout.keyBytesOffset, layout.keyBytesCapacity);

    if (initFresh) {
      this.generation.fill(1);
      this.liveEid.fill(-1);
      this.respawnAtMs.fill(Number.NaN);

      const dv = new DataView(sab, 0, SPAWN_POOL_HEADER_BYTES);
      dv.setUint32(W_MAGIC * 4, SPAWN_POOL_MAGIC, true);
      dv.setUint32(W_VERSION * 4, SPAWN_POOL_VERSION, true);
      dv.setUint32(W_CAPACITY * 4, layout.capacity, true);
      dv.setUint32(W_ACTIVE_COUNT * 4, 0, true);
      dv.setUint32(W_HIGH_WATER * 4, 0, true);
      dv.setUint32(W_KEY_CAP * 4, layout.keyBytesCapacity, true);
      dv.setUint32(W_KEY_USED * 4, 0, true);
      dv.setUint32(W_SAB_BYTES * 4, sab.byteLength, true);
      dv.setUint32(W_LAYOUT_FLAGS * 4, 0, true);
      dv.setUint32(W_FREE_TOP * 4, 0, true);
      dv.setUint32(W_CHECKSUM * 4, 0, true);
      dv.setUint32(W_BODY_BYTES * 4, sab.byteLength - SPAWN_POOL_HEADER_BYTES, true);
    }
  }

  public static create(opts: SpawnPoolOptions = {}): SpawnPoolSoA {
    return new SpawnPoolSoA(opts);
  }

  /** Construct a new L2-bounded SharedArrayBuffer spawn/respawn pool. */
  public static allocate(opts: SpawnPoolOptions = {}): SpawnPoolSoA {
    return SpawnPoolSoA.create(opts);
  }

  public get byteLength(): number {
    return this.sab.byteLength;
  }

  public get activeCount(): number {
    return this.headerU32[W_ACTIVE_COUNT]!;
  }

  public get highWater(): number {
    return this.headerU32[W_HIGH_WATER]!;
  }

  public get keyBytesUsed(): number {
    return this.headerU32[W_KEY_USED]!;
  }

  public get freeCount(): number {
    return this.headerU32[W_FREE_TOP]!;
  }

  public get isFull(): boolean {
    return this.headerU32[W_ACTIVE_COUNT]! >= this.capacity;
  }

  /**
   * Instantiate a pool attached to an existing `SharedArrayBuffer` (e.g. transferred
   * to a worker thread). Validates the header, alignment, bounds, and restores the
   * O(1) key lookup table.
   */
  public static fromSharedBuffer(
    sab: SharedArrayBuffer,
    keyBytes?: Uint8Array,
    opts?: FromSharedBufferOptions,
  ): SpawnPoolSoA {
    if (!(sab instanceof SharedArrayBuffer)) {
      throw new TypeError("SpawnPoolSoA.fromSharedBuffer: expected a SharedArrayBuffer");
    }
    if (sab.byteLength < SPAWN_POOL_HEADER_BYTES) {
      throw new RangeError(
        `SpawnPoolSoA.fromSharedBuffer: buffer too small (${sab.byteLength} < ${SPAWN_POOL_HEADER_BYTES})`,
      );
    }

    const dv = new DataView(sab, 0, SPAWN_POOL_HEADER_BYTES);
    const magic = dv.getUint32(W_MAGIC * 4, true);
    if (magic !== SPAWN_POOL_MAGIC) {
      throw new Error(`SpawnPoolSoA.fromSharedBuffer: bad magic 0x${magic.toString(16)}`);
    }
    const version = dv.getUint32(W_VERSION * 4, true);
    if (version !== SPAWN_POOL_VERSION) {
      throw new Error(`SpawnPoolSoA.fromSharedBuffer: unsupported version ${version}`);
    }
    const layoutFlags = dv.getUint32(W_LAYOUT_FLAGS * 4, true);
    if (layoutFlags !== 0) {
      throw new Error(`SpawnPoolSoA.fromSharedBuffer: unsupported layoutFlags 0x${layoutFlags.toString(16)}`);
    }

    const capacity = dv.getUint32(W_CAPACITY * 4, true);
    const activeCount = dv.getUint32(W_ACTIVE_COUNT * 4, true);
    const highWater = dv.getUint32(W_HIGH_WATER * 4, true);
    const keyBytesCapacity = dv.getUint32(W_KEY_CAP * 4, true);
    const keyBytesUsed = dv.getUint32(W_KEY_USED * 4, true);
    const sabByteLength = dv.getUint32(W_SAB_BYTES * 4, true);
    const freeTop = dv.getUint32(W_FREE_TOP * 4, true);

    const layout = computePoolSabLayout(capacity, keyBytesCapacity);
    if (sab.byteLength < layout.totalBytes || sabByteLength !== layout.totalBytes) {
      throw new RangeError(
        `SpawnPoolSoA.fromSharedBuffer: buffer size mismatch (got ${sab.byteLength}, header=${sabByteLength}, layout=${layout.totalBytes})`,
      );
    }
    if (opts?.maxBudgetBytes !== undefined && sab.byteLength > opts.maxBudgetBytes) {
      throw new RangeError(
        `SpawnPoolSoA.fromSharedBuffer: buffer size ${sab.byteLength} exceeds maxBudgetBytes ${opts.maxBudgetBytes}`,
      );
    }
    if (highWater > capacity || activeCount > highWater || keyBytesUsed > keyBytesCapacity) {
      throw new RangeError(
        `SpawnPoolSoA.fromSharedBuffer: corrupt header counts (active=${activeCount}, highWater=${highWater}, cap=${capacity}, keyUsed=${keyBytesUsed}, keyCap=${keyBytesCapacity})`,
      );
    }
    if (freeTop !== highWater - activeCount) {
      throw new RangeError(
        `SpawnPoolSoA.fromSharedBuffer: freeTop ${freeTop} != highWater - activeCount (${highWater - activeCount})`,
      );
    }

    let externalBytes: Uint8Array | null = null;
    if (keyBytes !== undefined) {
      if (!(keyBytes instanceof Uint8Array)) {
        throw new TypeError("SpawnPoolSoA.fromSharedBuffer: keyBytes must be a Uint8Array");
      }
      if (keyBytes.byteLength < keyBytesUsed) {
        throw new RangeError(
          `SpawnPoolSoA.fromSharedBuffer: keyBytes length ${keyBytes.byteLength} < keyBytesUsed ${keyBytesUsed}`,
        );
      }
      externalBytes = keyBytes;
    }

    const maxBudgetBytes = opts?.maxBudgetBytes ?? Math.max(DEFAULT_L2_CACHE_BYTES, sab.byteLength);
    let pool: SpawnPoolSoA;
    pendingAttach = {
      sab,
      layout,
      maxBudgetBytes,
      externalKeyBytes: externalBytes,
    };
    try {
      pool = new SpawnPoolSoA();
    } finally {
      pendingAttach = null;
    }
    if (externalBytes !== null && pool.keyBytes.byteLength >= keyBytesUsed && keyBytesUsed > 0) {
      pool.keyBytes.set(externalBytes.subarray(0, keyBytesUsed), 0);
    }
    pool.rebuildIndices(activeCount, highWater, keyBytesUsed, true);
    return pool;
  }

  /**
   * Allocate a slot, returning a packed generational handle `((gen << 16) | idx) >>> 0`.
   * Returns `INVALID_POOL_HANDLE` (`0`) cleanly when the pool is at capacity.
   * Throws on duplicate live key, empty key, or invalid non-finite inputs.
   */
  public allocateSlot(input: AllocateSpawnSlotInput): number {
    const key = input.key;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("SpawnPoolSoA.allocateSlot: key must be a non-empty string");
    }
    if (this.keyToHandle.has(key)) {
      throw new Error(`SpawnPoolSoA.allocateSlot: duplicate live key "${key}"`);
    }
    if (!isValidRespawnKind(input.kind)) {
      throw new RangeError(`SpawnPoolSoA.allocateSlot: invalid RespawnKind ${String(input.kind)}`);
    }

    const stateVal = input.state ?? STATE_ACTIVE;
    if (!isValidSlotState(stateVal) || stateVal === STATE_FREE) {
      throw new RangeError(`SpawnPoolSoA.allocateSlot: invalid initial SlotState ${String(stateVal)}`);
    }

    const homeX = input.homeX ?? 0;
    const homeY = input.homeY ?? 0;
    const homeZ = input.homeZ ?? 0;
    const footprintRadiusM = input.footprintRadiusM ?? 0;
    const respawnDelayMs = input.respawnDelayMs ?? 0;
    const respawnAtMs = input.respawnAtMs ?? Number.NaN;
    if (!Number.isFinite(homeX) || !Number.isFinite(homeY) || !Number.isFinite(homeZ)) {
      throw new RangeError("SpawnPoolSoA.allocateSlot: home coordinates must be finite");
    }
    if (!Number.isFinite(footprintRadiusM) || footprintRadiusM < 0) {
      throw new RangeError(`SpawnPoolSoA.allocateSlot: footprintRadiusM must be finite >= 0 (got ${footprintRadiusM})`);
    }
    if (!Number.isFinite(respawnDelayMs) || respawnDelayMs < 0) {
      throw new RangeError(`SpawnPoolSoA.allocateSlot: respawnDelayMs must be finite >= 0 (got ${respawnDelayMs})`);
    }
    if (!Number.isNaN(respawnAtMs) && !Number.isFinite(respawnAtMs)) {
      throw new RangeError(`SpawnPoolSoA.allocateSlot: respawnAtMs must be NaN or finite (got ${respawnAtMs})`);
    }

    const anchorIndex = input.anchorIndex ?? 0;
    if (!Number.isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex > 0xffff) {
      throw new RangeError(`SpawnPoolSoA.allocateSlot: anchorIndex out of uint16 range (${anchorIndex})`);
    }

    const maxStock = input.maxStock !== undefined ? Math.max(0, input.maxStock | 0) : Math.max(0, (input.stock ?? 1) | 0);
    const stock = input.stock !== undefined ? Math.max(0, input.stock | 0) : maxStock;
    const liveEid = input.liveEid !== undefined ? (input.liveEid | 0) : -1;
    const flagsVal = (input.flags ?? 0) & 0xff;

    const active = this.headerU32[W_ACTIVE_COUNT]!;
    if (active >= this.capacity) {
      return INVALID_POOL_HANDLE;
    }

    let freeTop = this.headerU32[W_FREE_TOP]!;
    let highWater = this.headerU32[W_HIGH_WATER]!;
    let idx: number;
    let poppedFromFree = false;
    if (freeTop > 0) {
      freeTop--;
      idx = this.freeStack[freeTop]!;
      poppedFromFree = true;
    } else if (highWater < this.capacity) {
      idx = highWater++;
    } else {
      return INVALID_POOL_HANDLE;
    }

    // Intern UTF-8 key bytes directly into the SAB key buffer BEFORE committing slot counters.
    const preHighWater = this.headerU32[W_HIGH_WATER]!;
    const keyOffset = this.writeInternedKey(key, idx, poppedFromFree, freeTop, preHighWater);

    const kHash = fnv1a32(key);
    const mHash =
      input.modelId !== undefined
        ? fnv1a32(input.modelId)
        : (input.modelHash ?? 0) >>> 0;
    const aHash =
      input.archetypeId !== undefined
        ? fnv1a32(input.archetypeId)
        : (input.archetypeHash ?? 0) >>> 0;

    let gen = this.generation[idx]!;
    if (gen === 0) {
      gen = 1;
      this.generation[idx] = 1;
    }

    this.kind[idx] = input.kind;
    this.state[idx] = stateVal;
    this.flags[idx] = flagsVal;
    this.keyHash[idx] = kHash;
    this.modelHash[idx] = mHash;
    this.archetypeHash[idx] = aHash;
    this.keyStrOffset[idx] = keyOffset.offset;
    this.keyStrLen[idx] = keyOffset.length;
    this.liveEid[idx] = liveEid;
    this.stock[idx] = stock;
    this.maxStock[idx] = maxStock;
    this.anchorIndex[idx] = anchorIndex;
    this.homeX[idx] = homeX;
    this.homeY[idx] = homeY;
    this.homeZ[idx] = homeZ;
    this.footprintRadiusM[idx] = footprintRadiusM;
    this.respawnDelayMs[idx] = respawnDelayMs;
    this.respawnAtMs[idx] = respawnAtMs;

    this.headerU32[W_ACTIVE_COUNT] = active + 1;
    this.headerU32[W_HIGH_WATER] = highWater;
    this.headerU32[W_FREE_TOP] = freeTop;

    const handle = packPoolHandle(idx, gen);
    this.keyToHandle.set(key, handle);
    this.addHashMapping(kHash, handle);
    return handle;
  }

  /** Validate whether `handle` refers to a currently allocated slot with matching ABA generation. */
  public isValidHandle(handle: number): boolean {
    if (!Number.isInteger(handle) || handle <= 0 || handle > 0xffffffff) return false;
    const idx = handle & 0xffff;
    const gen = (handle >>> 16) & 0xffff;
    if (gen === 0 || idx >= this.headerU32[W_HIGH_WATER]!) return false;
    return this.state[idx] !== STATE_FREE && this.generation[idx] === gen;
  }

  /** Return slot index for a valid live `handle`, or `-1` if stale/invalid. */
  public slotIndexOf(handle: number): number {
    return this.isValidHandle(handle) ? handle & 0xffff : -1;
  }

  /** Return packed handle for a live `slotIndex`, or `INVALID_POOL_HANDLE` (`0`) if free/out of bounds. */
  public handleAtSlot(slotIndex: number): number {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.headerU32[W_HIGH_WATER]!) {
      return INVALID_POOL_HANDLE;
    }
    if (this.state[slotIndex] === STATE_FREE) return INVALID_POOL_HANDLE;
    return packPoolHandle(slotIndex, this.generation[slotIndex]!);
  }

  /**
   * Free the slot identified by `handle`. Enforces ABA generation guard, increments
   * generation (`65535 -> 1`), zeroes all slot columns, and pushes index onto `freeStack`.
   */
  public freeSlot(handle: number): boolean {
    if (!this.isValidHandle(handle)) return false;
    const idx = handle & 0xffff;
    const key = this.decodeKeyAt(idx);
    const kHash = this.keyHash[idx]!;
    if (key !== undefined) {
      this.keyToHandle.delete(key);
    }
    this.removeHashMapping(kHash, handle);

    const nextGen = (this.generation[idx]! + 1) & 0xffff;
    this.generation[idx] = nextGen === 0 ? 1 : nextGen;

    this.kind[idx] = 0;
    this.state[idx] = STATE_FREE;
    this.flags[idx] = 0;
    this.keyHash[idx] = 0;
    this.modelHash[idx] = 0;
    this.archetypeHash[idx] = 0;
    this.keyStrOffset[idx] = 0;
    this.keyStrLen[idx] = 0;
    this.liveEid[idx] = -1;
    this.stock[idx] = 0;
    this.maxStock[idx] = 0;
    this.anchorIndex[idx] = 0;
    this.homeX[idx] = 0;
    this.homeY[idx] = 0;
    this.homeZ[idx] = 0;
    this.footprintRadiusM[idx] = 0;
    this.respawnDelayMs[idx] = 0;
    this.respawnAtMs[idx] = Number.NaN;

    const nextActive = this.headerU32[W_ACTIVE_COUNT]! - 1;
    this.headerU32[W_ACTIVE_COUNT] = nextActive;
    if (nextActive === 0) {
      this.headerU32[W_HIGH_WATER] = 0;
      this.headerU32[W_FREE_TOP] = 0;
      this.headerU32[W_KEY_USED] = 0;
    } else {
      const freeTop = this.headerU32[W_FREE_TOP]!;
      this.freeStack[freeTop] = idx;
      this.headerU32[W_FREE_TOP] = freeTop + 1;
    }
    return true;
  }

  /** O(1) lookup of packed handle by exact string key (`0` when absent). */
  public findByKey(key: string): number {
    return this.keyToHandle.get(key) ?? INVALID_POOL_HANDLE;
  }

  /** Alias for `findByKey`. */
  public findSlotByKey(key: string): number {
    return this.keyToHandle.get(key) ?? INVALID_POOL_HANDLE;
  }

  /** O(1) lookup of packed handle by FNV-1a 32-bit key hash (`0` when absent). */
  public findByKeyHash(hash: number): number {
    const entry = this.hashToHandles.get(hash >>> 0);
    if (entry === undefined) return INVALID_POOL_HANDLE;
    return typeof entry === "number" ? entry : (entry[0] ?? INVALID_POOL_HANDLE);
  }

  /** Decode the interned key string for a valid handle (`undefined` if stale). */
  public getKey(handle: number): string | undefined {
    if (!this.isValidHandle(handle)) return undefined;
    return this.decodeKeyAt(handle & 0xffff);
  }

  /** Decode the interned key string at a live slot index (`undefined` if free/invalid). */
  public getKeyAtSlot(slotIndex: number): string | undefined {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.headerU32[W_HIGH_WATER]!) {
      return undefined;
    }
    if (this.state[slotIndex] === STATE_FREE) return undefined;
    return this.decodeKeyAt(slotIndex);
  }

  /**
   * Schedule a slot for cooldown respawn at `nowMs + delay`.
   * Zero heap allocations, zero clock syscalls.
   */
  public scheduleRespawn(handle: number, nowMs: number, overrideDelayMs?: number): boolean {
    if (!this.isValidHandle(handle)) return false;
    if (!Number.isFinite(nowMs)) {
      throw new RangeError(`SpawnPoolSoA.scheduleRespawn: nowMs must be finite (got ${nowMs})`);
    }
    const idx = handle & 0xffff;
    const delay = overrideDelayMs !== undefined ? overrideDelayMs : this.respawnDelayMs[idx]!;
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError(`SpawnPoolSoA.scheduleRespawn: delay must be finite >= 0 (got ${delay})`);
    }
    this.state[idx] = STATE_COOLDOWN_RESPAWN;
    this.respawnAtMs[idx] = nowMs + delay;
    this.liveEid[idx] = -1;
    this.flags[idx] |= FLAG_DIRTY;
    return true;
  }

  /**
   * Mark a slot as Active, bind `liveEid`, clear `respawnAtMs = NaN`, and optionally update `stock`.
   * Zero heap allocations.
   */
  public markActive(handle: number, liveEid: number, nextStock?: number): boolean {
    if (!this.isValidHandle(handle)) return false;
    const idx = handle & 0xffff;
    this.state[idx] = STATE_ACTIVE;
    this.respawnAtMs[idx] = Number.NaN;
    this.liveEid[idx] = liveEid | 0;
    if (nextStock !== undefined) {
      this.stock[idx] = nextStock > 0 ? nextStock | 0 : 0;
    }
    this.flags[idx] |= FLAG_DIRTY;
    return true;
  }

  /** Bind/unbind `liveEid` without changing state or respawn timer. Zero heap allocations. */
  public setLiveEid(handle: number, liveEid: number): boolean {
    if (!this.isValidHandle(handle)) return false;
    this.liveEid[handle & 0xffff] = liveEid | 0;
    return true;
  }

  /** Update a slot's home coordinates. Zero heap allocations. */
  public setHome(handle: number, x: number, y: number, z: number): boolean {
    if (!this.isValidHandle(handle)) return false;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new RangeError("SpawnPoolSoA.setHome: coordinates must be finite");
    }
    const idx = handle & 0xffff;
    this.homeX[idx] = x;
    this.homeY[idx] = y;
    this.homeZ[idx] = z;
    this.flags[idx] |= FLAG_DIRTY;
    return true;
  }

  /**
   * Decrement `stock` by `delta`, clamping to `>= 0`. When `stock` reaches `0`:
   * transitions to `CooldownRespawn` (`respawnAtMs = nowMs + respawnDelayMs`) if
   * `respawnDelayMs > 0`, otherwise transitions to `Exhausted`.
   * Returns the remaining stock (`-1` if `handle` is stale/invalid).
   */
  public decrementStock(handle: number, delta = 1, nowMs?: number): number {
    if (!this.isValidHandle(handle)) return -1;
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError(`SpawnPoolSoA.decrementStock: delta must be finite >= 0 (got ${delta})`);
    }
    const idx = handle & 0xffff;
    const step = delta | 0;
    const cur = this.stock[idx]!;
    const next = cur > step ? cur - step : 0;
    this.stock[idx] = next;
    this.flags[idx] |= FLAG_DIRTY;

    if (next === 0) {
      const delay = this.respawnDelayMs[idx]!;
      if (delay > 0) {
        if (nowMs === undefined || !Number.isFinite(nowMs)) {
          throw new RangeError(
            `SpawnPoolSoA.decrementStock: finite nowMs is required when scheduling respawn (got ${String(nowMs)})`,
          );
        }
        this.state[idx] = STATE_COOLDOWN_RESPAWN;
        this.respawnAtMs[idx] = nowMs + delay;
      } else {
        this.state[idx] = STATE_EXHAUSTED;
        this.respawnAtMs[idx] = Number.NaN;
      }
    }
    return next;
  }

  /**
   * Scan `0..highWater` for slots in `SlotState.CooldownRespawn` with `respawnAtMs <= nowMs`,
   * optionally filtered by `RespawnKind` (`kindFilter = 0` matches all kinds).
   *
   * Zero heap allocations, zero closures, zero clock calls.
   *
   * By default (`claim = false`), peeks cleanly without mutating slot state so callers
   * call `markActive(handle, eid, ...)` after instantiating/regrowing each ready slot.
   * Pass `claim = true` to atomically transition matched slots to `SlotState.Locked`
   * with `respawnAtMs = NaN`.
   */
  public pollReady(
    nowMs: number,
    outSlotIndices: Int32Array,
    kindFilter = 0,
    claim = false,
  ): number {
    const maxOut = outSlotIndices.length;
    if (maxOut === 0 || !Number.isFinite(nowMs)) return 0;

    const hw = this.headerU32[W_HIGH_WATER]!;
    const state = this.state;
    const kind = this.kind;
    const respawnAtMs = this.respawnAtMs;
    let found = 0;

    if (kindFilter === 0) {
      for (let i = 0; i < hw; i++) {
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
      for (let i = 0; i < hw; i++) {
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

  /**
   * Serialize header (`48` bytes, little-endian) + aligned SoA columns (`0..highWater`) +
   * key intern bytes (`0..keyBytesUsed`) with IEEE 802.3 CRC-32 integrity checksum.
   * Zero per-entity object allocation: 1 bulk buffer copy per SoA column.
   */
  public encodeBinary(): Uint8Array {
    const hw = this.headerU32[W_HIGH_WATER]!;
    const activeCount = this.headerU32[W_ACTIVE_COUNT]!;
    const kUsed = this.headerU32[W_KEY_USED]!;
    const freeTop = this.headerU32[W_FREE_TOP]!;
    const binLayout = computePoolBinaryLayout(hw, kUsed);
    const totalBytes = SPAWN_POOL_HEADER_BYTES + binLayout.bodyBytes;

    const out = new Uint8Array(totalBytes);
    const dv = new DataView(out.buffer, out.byteOffset, totalBytes);
    dv.setUint32(W_MAGIC * 4, SPAWN_POOL_MAGIC, true);
    dv.setUint32(W_VERSION * 4, SPAWN_POOL_VERSION, true);
    dv.setUint32(W_CAPACITY * 4, this.capacity, true);
    dv.setUint32(W_ACTIVE_COUNT * 4, activeCount, true);
    dv.setUint32(W_HIGH_WATER * 4, hw, true);
    dv.setUint32(W_KEY_CAP * 4, this.keyBytesCapacity, true);
    dv.setUint32(W_KEY_USED * 4, kUsed, true);
    dv.setUint32(W_SAB_BYTES * 4, this.sab.byteLength, true);
    dv.setUint32(W_LAYOUT_FLAGS * 4, 0, true);
    dv.setUint32(W_FREE_TOP * 4, freeTop, true);
    dv.setUint32(W_CHECKSUM * 4, 0, true);
    dv.setUint32(W_BODY_BYTES * 4, binLayout.bodyBytes, true);

    if (hw > 0) {
      const l = this.layout;
      if (IS_LITTLE_ENDIAN) {
        const copyCol = (sabOff: number, binOff: number, bytes: number): void => {
          out.set(new Uint8Array(this.sab, sabOff, bytes), binOff);
        };
        copyCol(l.kindOffset, binLayout.kindOffset, hw);
        copyCol(l.stateOffset, binLayout.stateOffset, hw);
        copyCol(l.flagsOffset, binLayout.flagsOffset, hw);
        copyCol(l.generationOffset, binLayout.generationOffset, hw * 2);
        copyCol(l.keyStrLenOffset, binLayout.keyStrLenOffset, hw * 2);
        copyCol(l.anchorIndexOffset, binLayout.anchorIndexOffset, hw * 2);
        copyCol(l.keyHashOffset, binLayout.keyHashOffset, hw * 4);
        copyCol(l.modelHashOffset, binLayout.modelHashOffset, hw * 4);
        copyCol(l.archetypeHashOffset, binLayout.archetypeHashOffset, hw * 4);
        copyCol(l.keyStrOffsetOffset, binLayout.keyStrOffsetOffset, hw * 4);
        copyCol(l.liveEidOffset, binLayout.liveEidOffset, hw * 4);
        copyCol(l.stockOffset, binLayout.stockOffset, hw * 4);
        copyCol(l.maxStockOffset, binLayout.maxStockOffset, hw * 4);
        copyCol(l.homeXOffset, binLayout.homeXOffset, hw * 4);
        copyCol(l.homeYOffset, binLayout.homeYOffset, hw * 4);
        copyCol(l.homeZOffset, binLayout.homeZOffset, hw * 4);
        copyCol(l.footprintRadiusMOffset, binLayout.footprintRadiusMOffset, hw * 4);
        copyCol(l.respawnDelayMsOffset, binLayout.respawnDelayMsOffset, hw * 8);
        copyCol(l.respawnAtMsOffset, binLayout.respawnAtMsOffset, hw * 8);
      } else {
        this.encodeColumnsBigEndianFallback(dv, binLayout, hw);
      }
    }

    if (kUsed > 0) {
      const srcKeys = this.externalKeyBytes && this.keyBytesCapacity === 0
        ? this.externalKeyBytes.subarray(0, kUsed)
        : this.keyBytes.subarray(0, kUsed);
      out.set(srcKeys, binLayout.keyBytesOffset);
    }

    let crc = updateCrc32(0, out, 0, W_CHECKSUM * 4);
    crc = updateCrc32(crc, out, W_BODY_BYTES * 4, totalBytes);
    dv.setUint32(W_CHECKSUM * 4, crc, true);
    return out;
  }

  /**
   * Fail-closed binary decoder: validates magic, version, bounds, CRC-32 checksum,
   * L2 budget ceiling, and per-slot key/generation integrity, copying SoA columns
   * straight into a new `SharedArrayBuffer` with 1 bulk copy per column.
   */
  public static decodeBinary(
    bytes: Uint8Array,
    opts: DecodeSpawnPoolOptions = {},
  ): SpawnPoolSoA {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("SpawnPoolSoA.decodeBinary: expected Uint8Array");
    }
    if (bytes.byteLength < SPAWN_POOL_HEADER_BYTES) {
      throw new RangeError(
        `SpawnPoolSoA.decodeBinary: truncated header (${bytes.byteLength} < ${SPAWN_POOL_HEADER_BYTES})`,
      );
    }

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = dv.getUint32(W_MAGIC * 4, true);
    if (magic !== SPAWN_POOL_MAGIC) {
      throw new Error(
        `SpawnPoolSoA.decodeBinary: bad magic 0x${magic.toString(16)} (expected 0x${SPAWN_POOL_MAGIC.toString(16)})`,
      );
    }
    const version = dv.getUint32(W_VERSION * 4, true);
    if (version !== SPAWN_POOL_VERSION) {
      throw new Error(`SpawnPoolSoA.decodeBinary: unsupported version ${version}`);
    }

    const headerCapacity = dv.getUint32(W_CAPACITY * 4, true);
    const activeCount = dv.getUint32(W_ACTIVE_COUNT * 4, true);
    const highWater = dv.getUint32(W_HIGH_WATER * 4, true);
    const headerKeyCap = dv.getUint32(W_KEY_CAP * 4, true);
    const keyBytesUsed = dv.getUint32(W_KEY_USED * 4, true);
    const layoutFlags = dv.getUint32(W_LAYOUT_FLAGS * 4, true);
    const freeTop = dv.getUint32(W_FREE_TOP * 4, true);
    const expectedCrc = dv.getUint32(W_CHECKSUM * 4, true);
    const bodyBytes = dv.getUint32(W_BODY_BYTES * 4, true);

    if (layoutFlags !== 0) {
      throw new Error(`SpawnPoolSoA.decodeBinary: unsupported layoutFlags 0x${layoutFlags.toString(16)}`);
    }
    if (bytes.byteLength !== SPAWN_POOL_HEADER_BYTES + bodyBytes) {
      throw new RangeError(
        `SpawnPoolSoA.decodeBinary: length mismatch (got ${bytes.byteLength}, expected ${SPAWN_POOL_HEADER_BYTES + bodyBytes})`,
      );
    }

    let actualCrc = updateCrc32(0, bytes, 0, W_CHECKSUM * 4);
    actualCrc = updateCrc32(actualCrc, bytes, W_BODY_BYTES * 4, bytes.byteLength);
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `SpawnPoolSoA.decodeBinary: checksum mismatch (expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)})`,
      );
    }

    if (
      headerCapacity > MAX_POOL_CAPACITY ||
      highWater > headerCapacity ||
      activeCount > highWater ||
      keyBytesUsed > headerKeyCap ||
      freeTop !== highWater - activeCount
    ) {
      throw new RangeError(
        `SpawnPoolSoA.decodeBinary: corrupt header bounds (cap=${headerCapacity}, hw=${highWater}, active=${activeCount}, free=${freeTop}, keyUsed=${keyBytesUsed}, keyCap=${headerKeyCap})`,
      );
    }

    const binLayout = computePoolBinaryLayout(highWater, keyBytesUsed);
    if (bodyBytes !== binLayout.bodyBytes) {
      throw new RangeError(
        `SpawnPoolSoA.decodeBinary: bodyBytes mismatch (header=${bodyBytes}, expected=${binLayout.bodyBytes})`,
      );
    }

    const targetCapacity = opts.capacity ?? headerCapacity;
    if (!Number.isInteger(targetCapacity) || targetCapacity < highWater || targetCapacity > MAX_POOL_CAPACITY) {
      throw new RangeError(
        `SpawnPoolSoA.decodeBinary: target capacity ${targetCapacity} invalid for highWater=${highWater} (max=${MAX_POOL_CAPACITY})`,
      );
    }

    const maxBudgetBytes = opts.maxBudgetBytes ?? DEFAULT_L2_CACHE_BYTES;
    const targetKeyCap =
      opts.capacity === undefined
        ? Math.max(headerKeyCap, keyBytesUsed)
        : Math.max(keyBytesUsed, defaultKeyBufferBytes(targetCapacity));

    const pool = SpawnPoolSoA.create({
      capacity: targetCapacity,
      keyBufferBytes: targetKeyCap,
      maxBudgetBytes,
    });

    if (highWater > 0) {
      const l = pool.layout;
      if (IS_LITTLE_ENDIAN) {
        const copyCol = (binOff: number, sabOff: number, byteLen: number): void => {
          new Uint8Array(pool.sab, sabOff, byteLen).set(bytes.subarray(binOff, binOff + byteLen));
        };
        copyCol(binLayout.kindOffset, l.kindOffset, highWater);
        copyCol(binLayout.stateOffset, l.stateOffset, highWater);
        copyCol(binLayout.flagsOffset, l.flagsOffset, highWater);
        copyCol(binLayout.generationOffset, l.generationOffset, highWater * 2);
        copyCol(binLayout.keyStrLenOffset, l.keyStrLenOffset, highWater * 2);
        copyCol(binLayout.anchorIndexOffset, l.anchorIndexOffset, highWater * 2);
        copyCol(binLayout.keyHashOffset, l.keyHashOffset, highWater * 4);
        copyCol(binLayout.modelHashOffset, l.modelHashOffset, highWater * 4);
        copyCol(binLayout.archetypeHashOffset, l.archetypeHashOffset, highWater * 4);
        copyCol(binLayout.keyStrOffsetOffset, l.keyStrOffsetOffset, highWater * 4);
        copyCol(binLayout.liveEidOffset, l.liveEidOffset, highWater * 4);
        copyCol(binLayout.stockOffset, l.stockOffset, highWater * 4);
        copyCol(binLayout.maxStockOffset, l.maxStockOffset, highWater * 4);
        copyCol(binLayout.homeXOffset, l.homeXOffset, highWater * 4);
        copyCol(binLayout.homeYOffset, l.homeYOffset, highWater * 4);
        copyCol(binLayout.homeZOffset, l.homeZOffset, highWater * 4);
        copyCol(binLayout.footprintRadiusMOffset, l.footprintRadiusMOffset, highWater * 4);
        copyCol(binLayout.respawnDelayMsOffset, l.respawnDelayMsOffset, highWater * 8);
        copyCol(binLayout.respawnAtMsOffset, l.respawnAtMsOffset, highWater * 8);
      } else {
        pool.decodeColumnsBigEndianFallback(dv, binLayout, highWater);
      }
    }

    if (keyBytesUsed > 0) {
      pool.keyBytes.set(bytes.subarray(binLayout.keyBytesOffset, binLayout.keyBytesOffset + keyBytesUsed), 0);
    }

    pool.rebuildIndices(activeCount, highWater, keyBytesUsed, true);
    pool.headerU32[W_ACTIVE_COUNT] = activeCount;
    pool.headerU32[W_HIGH_WATER] = highWater;
    pool.headerU32[W_KEY_USED] = keyBytesUsed;
    return pool;
  }

  /** Report exact SharedArrayBuffer L2 budget and slot/key utilization telemetry. */
  public utilizationStats(): PoolUtilizationStats {
    const hw = this.headerU32[W_HIGH_WATER]!;
    const active = this.headerU32[W_ACTIVE_COUNT]!;
    const keyUsed = this.headerU32[W_KEY_USED]!;

    let stFree = this.capacity - hw;
    let stActive = 0;
    let stCooldown = 0;
    let stExhausted = 0;
    let stLocked = 0;

    let kCreature = 0;
    let kResource = 0;
    let kVein = 0;
    let kChest = 0;
    let kBreakable = 0;
    let kResident = 0;

    for (let i = 0; i < hw; i++) {
      const s = this.state[i]!;
      if (s === STATE_FREE) {
        stFree++;
        continue;
      }
      if (s === STATE_ACTIVE) stActive++;
      else if (s === STATE_COOLDOWN_RESPAWN) stCooldown++;
      else if (s === STATE_EXHAUSTED) stExhausted++;
      else if (s === STATE_LOCKED) stLocked++;

      switch (this.kind[i]) {
        case RespawnKind.Creature:
          kCreature++;
          break;
        case RespawnKind.ResourceNode:
          kResource++;
          break;
        case RespawnKind.CivicVein:
          kVein++;
          break;
        case RespawnKind.Chest:
          kChest++;
          break;
        case RespawnKind.BreakableProp:
          kBreakable++;
          break;
        case RespawnKind.Resident:
          kResident++;
          break;
      }
    }

    return {
      capacity: this.capacity,
      activeCount: active,
      highWater: hw,
      freeCount: this.capacity - active,
      byteLength: this.sab.byteLength,
      maxBudgetBytes: this.maxBudgetBytes,
      utilizationPct: (this.sab.byteLength / this.maxBudgetBytes) * 100,
      slotUtilizationPct: this.capacity > 0 ? (active / this.capacity) * 100 : 0,
      keyBytesUsed: keyUsed,
      keyBytesCapacity: this.keyBytesCapacity,
      keyUtilizationPct: this.keyBytesCapacity > 0 ? (keyUsed / this.keyBytesCapacity) * 100 : 0,
      byState: {
        free: stFree,
        active: stActive,
        cooldownRespawn: stCooldown,
        exhausted: stExhausted,
        locked: stLocked,
      },
      byKind: {
        creature: kCreature,
        resourceNode: kResource,
        civicVein: kVein,
        chest: kChest,
        breakableProp: kBreakable,
        resident: kResident,
      },
    };
  }

  private decodeKeyAt(slotIndex: number): string | undefined {
    const len = this.keyStrLen[slotIndex]!;
    if (len === 0) return undefined;
    const off = this.keyStrOffset[slotIndex]!;
    const src = this.externalKeyBytes && this.keyBytesCapacity === 0
      ? this.externalKeyBytes
      : this.keyBytes;
    if (off + len > src.byteLength) return undefined;
    return UTF8_DECODER.decode(src.subarray(off, off + len));
  }

  private addHashMapping(hash: number, handle: number): void {
    const existing = this.hashToHandles.get(hash);
    if (existing === undefined) {
      this.hashToHandles.set(hash, handle);
    } else if (typeof existing === "number") {
      this.hashToHandles.set(hash, [existing, handle]);
    } else {
      existing.push(handle);
    }
  }

  private removeHashMapping(hash: number, handle: number): void {
    const existing = this.hashToHandles.get(hash);
    if (existing === undefined) return;
    if (typeof existing === "number") {
      if (existing === handle) this.hashToHandles.delete(hash);
      return;
    }
    const idx = existing.indexOf(handle);
    if (idx !== -1) existing.splice(idx, 1);
    if (existing.length === 1) {
      this.hashToHandles.set(hash, existing[0]!);
    } else if (existing.length === 0) {
      this.hashToHandles.delete(hash);
    }
  }

  private writeInternedKey(
    key: string,
    slotIndex: number,
    poppedFromFree: boolean,
    freeTopAfterPop: number,
    preHighWater: number,
  ): { offset: number; length: number } {
    const rollbackSlot = (): void => {
      if (poppedFromFree) {
        this.freeStack[freeTopAfterPop] = slotIndex;
      }
    };

    let ascii = true;
    for (let i = 0; i < key.length; i++) {
      if (key.charCodeAt(i) >= 0x80) {
        ascii = false;
        break;
      }
    }

    if (ascii) {
      const byteLen = key.length;
      if (byteLen > MAX_KEY_BYTES_LEN) {
        rollbackSlot();
        throw new RangeError(`SpawnPoolSoA: key exceeds max length ${MAX_KEY_BYTES_LEN}`);
      }
      let keyUsed = this.headerU32[W_KEY_USED]!;
      if (keyUsed + byteLen > this.keyBytesCapacity) {
        keyUsed = this.compactKeyBuffer(preHighWater);
        if (keyUsed + byteLen > this.keyBytesCapacity) {
          rollbackSlot();
          throw new RangeError(
            `SpawnPoolSoA: key intern buffer exhausted (${keyUsed} + ${byteLen} > ${this.keyBytesCapacity})`,
          );
        }
      }
      const dst = this.keyBytes;
      for (let i = 0; i < byteLen; i++) {
        dst[keyUsed + i] = key.charCodeAt(i);
      }
      this.headerU32[W_KEY_USED] = keyUsed + byteLen;
      return { offset: keyUsed, length: byteLen };
    }

    let encodedBytes: Uint8Array;
    let byteLen: number;
    const encRes = UTF8_ENCODER.encodeInto(key, KEY_ENCODE_SCRATCH);
    if (encRes.read === key.length) {
      encodedBytes = KEY_ENCODE_SCRATCH;
      byteLen = encRes.written;
    } else {
      encodedBytes = UTF8_ENCODER.encode(key);
      byteLen = encodedBytes.byteLength;
    }

    if (byteLen > MAX_KEY_BYTES_LEN) {
      rollbackSlot();
      throw new RangeError(`SpawnPoolSoA: key exceeds max UTF-8 length ${MAX_KEY_BYTES_LEN}`);
    }

    let keyUsed = this.headerU32[W_KEY_USED]!;
    if (keyUsed + byteLen > this.keyBytesCapacity) {
      keyUsed = this.compactKeyBuffer(preHighWater);
      if (keyUsed + byteLen > this.keyBytesCapacity) {
        rollbackSlot();
        throw new RangeError(
          `SpawnPoolSoA: key intern buffer exhausted (${keyUsed} + ${byteLen} > ${this.keyBytesCapacity})`,
        );
      }
    }
    this.keyBytes.set(encodedBytes.subarray(0, byteLen), keyUsed);
    this.headerU32[W_KEY_USED] = keyUsed + byteLen;
    return { offset: keyUsed, length: byteLen };
  }

  /**
   * Compact fragmented key intern buffer in-place by sliding live keys down in
   * ascending `keyStrOffset` order (`writePos <= srcOffset` is invariant).
   */
  private compactKeyBuffer(highWater: number): number {
    const liveSlots: number[] = [];
    for (let i = 0; i < highWater; i++) {
      if (this.state[i] !== STATE_FREE && this.keyStrLen[i]! > 0) {
        liveSlots.push(i);
      }
    }
    liveSlots.sort((a, b) => this.keyStrOffset[a]! - this.keyStrOffset[b]!);
    let writePos = 0;
    for (let j = 0; j < liveSlots.length; j++) {
      const idx = liveSlots[j]!;
      const off = this.keyStrOffset[idx]!;
      const len = this.keyStrLen[idx]!;
      if (off !== writePos) {
        this.keyBytes.copyWithin(writePos, off, off + len);
        this.keyStrOffset[idx] = writePos;
      }
      writePos += len;
    }
    this.headerU32[W_KEY_USED] = writePos;
    return writePos;
  }

  private rebuildIndices(
    expectedActive: number,
    highWater: number,
    keyBytesUsed: number,
    rebuildFreeStack: boolean,
  ): void {
    this.keyToHandle.clear();
    this.hashToHandles.clear();

    const keySource =
      this.externalKeyBytes && this.keyBytesCapacity === 0
        ? this.externalKeyBytes
        : this.keyBytes;

    let liveCount = 0;
    for (let i = 0; i < highWater; i++) {
      const s = this.state[i]!;
      if (!isValidSlotState(s)) {
        throw new Error(`SpawnPoolSoA: invalid SlotState ${s} at slot ${i}`);
      }
      const gen = this.generation[i]!;
      if (gen === 0) {
        throw new Error(`SpawnPoolSoA: invalid generation 0 at slot ${i}`);
      }
      if (s === STATE_FREE) continue;

      const k = this.kind[i]!;
      if (!isValidRespawnKind(k)) {
        throw new Error(`SpawnPoolSoA: invalid RespawnKind ${k} at slot ${i}`);
      }
      const off = this.keyStrOffset[i]!;
      const len = this.keyStrLen[i]!;
      if (len === 0 || off + len > keyBytesUsed) {
        throw new RangeError(
          `SpawnPoolSoA: corrupt key slice [${off}..${off + len}) > ${keyBytesUsed} at slot ${i}`,
        );
      }
      const key = UTF8_DECODER.decode(keySource.subarray(off, off + len));
      const expectedHash = fnv1a32(key);
      if (this.keyHash[i]! !== expectedHash) {
        throw new Error(
          `SpawnPoolSoA: keyHash mismatch for "${key}" at slot ${i} (got 0x${this.keyHash[i]!.toString(16)}, expected 0x${expectedHash.toString(16)})`,
        );
      }
      if (this.keyToHandle.has(key)) {
        throw new Error(`SpawnPoolSoA: duplicate live key "${key}" at slot ${i}`);
      }
      const handle = packPoolHandle(i, gen);
      this.keyToHandle.set(key, handle);
      this.addHashMapping(expectedHash, handle);
      liveCount++;
    }

    if (liveCount !== expectedActive) {
      throw new Error(
        `SpawnPoolSoA: activeCount mismatch (header=${expectedActive}, actual=${liveCount})`,
      );
    }

    if (rebuildFreeStack) {
      let freeTop = 0;
      for (let i = highWater - 1; i >= 0; i--) {
        if (this.state[i] === STATE_FREE) {
          this.freeStack[freeTop++] = i;
        }
      }
      this.headerU32[W_FREE_TOP] = freeTop;
    }
  }

  private encodeColumnsBigEndianFallback(
    dv: DataView,
    binLayout: BinaryBodyLayout,
    hw: number,
  ): void {
    for (let i = 0; i < hw; i++) {
      dv.setUint8(binLayout.kindOffset + i, this.kind[i]!);
      dv.setUint8(binLayout.stateOffset + i, this.state[i]!);
      dv.setUint8(binLayout.flagsOffset + i, this.flags[i]!);
      dv.setUint16(binLayout.generationOffset + i * 2, this.generation[i]!, true);
      dv.setUint16(binLayout.keyStrLenOffset + i * 2, this.keyStrLen[i]!, true);
      dv.setUint16(binLayout.anchorIndexOffset + i * 2, this.anchorIndex[i]!, true);
      dv.setUint32(binLayout.keyHashOffset + i * 4, this.keyHash[i]!, true);
      dv.setUint32(binLayout.modelHashOffset + i * 4, this.modelHash[i]!, true);
      dv.setUint32(binLayout.archetypeHashOffset + i * 4, this.archetypeHash[i]!, true);
      dv.setUint32(binLayout.keyStrOffsetOffset + i * 4, this.keyStrOffset[i]!, true);
      dv.setInt32(binLayout.liveEidOffset + i * 4, this.liveEid[i]!, true);
      dv.setInt32(binLayout.stockOffset + i * 4, this.stock[i]!, true);
      dv.setInt32(binLayout.maxStockOffset + i * 4, this.maxStock[i]!, true);
      dv.setFloat32(binLayout.homeXOffset + i * 4, this.homeX[i]!, true);
      dv.setFloat32(binLayout.homeYOffset + i * 4, this.homeY[i]!, true);
      dv.setFloat32(binLayout.homeZOffset + i * 4, this.homeZ[i]!, true);
      dv.setFloat32(binLayout.footprintRadiusMOffset + i * 4, this.footprintRadiusM[i]!, true);
      dv.setFloat64(binLayout.respawnDelayMsOffset + i * 8, this.respawnDelayMs[i]!, true);
      dv.setFloat64(binLayout.respawnAtMsOffset + i * 8, this.respawnAtMs[i]!, true);
    }
  }

  private decodeColumnsBigEndianFallback(
    dv: DataView,
    binLayout: BinaryBodyLayout,
    hw: number,
  ): void {
    for (let i = 0; i < hw; i++) {
      this.kind[i] = dv.getUint8(binLayout.kindOffset + i);
      this.state[i] = dv.getUint8(binLayout.stateOffset + i);
      this.flags[i] = dv.getUint8(binLayout.flagsOffset + i);
      this.generation[i] = dv.getUint16(binLayout.generationOffset + i * 2, true);
      this.keyStrLen[i] = dv.getUint16(binLayout.keyStrLenOffset + i * 2, true);
      this.anchorIndex[i] = dv.getUint16(binLayout.anchorIndexOffset + i * 2, true);
      this.keyHash[i] = dv.getUint32(binLayout.keyHashOffset + i * 4, true);
      this.modelHash[i] = dv.getUint32(binLayout.modelHashOffset + i * 4, true);
      this.archetypeHash[i] = dv.getUint32(binLayout.archetypeHashOffset + i * 4, true);
      this.keyStrOffset[i] = dv.getUint32(binLayout.keyStrOffsetOffset + i * 4, true);
      this.liveEid[i] = dv.getInt32(binLayout.liveEidOffset + i * 4, true);
      this.stock[i] = dv.getInt32(binLayout.stockOffset + i * 4, true);
      this.maxStock[i] = dv.getInt32(binLayout.maxStockOffset + i * 4, true);
      this.homeX[i] = dv.getFloat32(binLayout.homeXOffset + i * 4, true);
      this.homeY[i] = dv.getFloat32(binLayout.homeYOffset + i * 4, true);
      this.homeZ[i] = dv.getFloat32(binLayout.homeZOffset + i * 4, true);
      this.footprintRadiusM[i] = dv.getFloat32(binLayout.footprintRadiusMOffset + i * 4, true);
      this.respawnDelayMs[i] = dv.getFloat64(binLayout.respawnDelayMsOffset + i * 8, true);
      this.respawnAtMs[i] = dv.getFloat64(binLayout.respawnAtMsOffset + i * 8, true);
    }
  }
}
