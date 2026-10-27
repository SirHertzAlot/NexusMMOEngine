/**
 * SAB-backed bitECS component storage (Phase 1 of the SAB adaptation).
 *
 * bitECS 0.3.40 has no API to inject a backing store: `defineComponent`
 * allocates plain `ArrayBuffer` stores. This module performs post-allocation
 * store replacement — define the component normally, then swap each field's
 * typed array for a `SharedArrayBuffer`-backed view of identical constructor
 * and length. Every bitECS access path (systems, queries, `resetStoreFor`,
 * `Changed` shadows) reads field arrays through the component object, so
 * systems and queries see no API change — only the backing buffer changes.
 *
 * Critical ordering constraint (proven by the Phase 0 spike): replacement
 * must happen BEFORE any `defineQuery` for the component, because
 * `defineQuery` snapshots `component[$storeFlattened]` into `q.flatProps`
 * at definition time. This module is therefore called at component
 * definition time (`defineSABComponent`), and all queries are defined
 * later (at module import of the query sites, or at system construction).
 * Verified: no `defineQuery` in the engine references Body/Injury/Mana,
 * and every query on components.ts components lives in modules that import
 * components.ts first, so definition order is safe by ES module evaluation.
 *
 * Fixed-size constraint: a SharedArrayBuffer cannot grow. Stores are sized
 * to SAB_ENTITY_CAPACITY at definition time. Growing past capacity
 * requires a resize/migrate step that is NOT implemented — the boot-time
 * assertion in `defineSABComponent` guards the sizing, and the engine
 * must not call bitECS `setDefaultSize` with a larger value without
 * growing these stores too.
 *
 * Backing layout: ONE SharedArrayBuffer per component (not a single pooled
 * SAB for all components). Pooling would require either two-pass schema
 * collection across three definition sites (import-order complexity) or an
 * over-allocated magic-number pool (wasteful, fragile). Per-component SABs
 * match bitECS's per-component store model, keep rollback trivial (revert
 * the definition sites), and systems iterate one component's fields at a
 * time, so the locality benefit of pooling is marginal here.
 *
 * Array-type fields (`[Types.f32, N]`, e.g. Body.hp): bitECS builds a
 * shared parent array per type within a component and per-eid subarray
 * views into it. Replacement gives each array field its own SAB-backed
 * parent and rebuilds the per-eid views. Systems only ever touch the
 * per-eid views (`Body.hp[e][i]`), and no engine code reads the parent
 * array or the `$storeSubarrays` metadata directly, so splitting the
 * shared parent is safe. The old shared parent is orphaned.
 *
 * Tag components (`defineComponent()` with no schema, e.g. God/Noclip)
 * carry no data and are returned unchanged — there is nothing to back.
 */

import { defineComponent, type ComponentType, type ISchema } from "bitecs";

/**
 * Entity capacity for SAB-backed component stores.
 *
 * Must equal bitECS's global default size: `defineComponent(schema)`
 * without an explicit size uses `getGlobalSize()`, whose default is
 * 1e5 (bitECS 0.3.40, `defaultSize = 1e5`). The engine creates all
 * worlds with no-arg `createWorld()`, which also uses the global size,
 * so 100_000 is the single consistent capacity.
 */
export const SAB_ENTITY_CAPACITY = 100_000;

type TypedArray = ArrayBufferView & {
  readonly BYTES_PER_ELEMENT: number;
  readonly length: number;
};

type TypedArrayCtor = new (
  buffer: SharedArrayBuffer,
  byteOffset: number,
  length: number,
) => TypedArray;

/** Find an own symbol of `obj` by its description, or throw. */
function symbolByDescription(obj: object, description: string): symbol {
  const found = findSymbol(obj, description);
  if (!found) throw new Error(`sab-store: symbol "${description}" not found`);
  return found;
}

/** Find an own symbol of `obj` by its description, or undefined. */
function findSymbol(obj: object, description: string): symbol | undefined {
  return Object.getOwnPropertySymbols(obj).find(
    (s) => s.description === description,
  );
}

/** True if `value` is a bitECS array-type field store (JS array of per-eid subarrays). */
function isArrayStore(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    ArrayBuffer.isView(value[0]) &&
    !(value[0] instanceof DataView)
  );
}

/**
 * Replace a bitECS component's field stores with SharedArrayBuffer-backed
 * views. Returns the same component object (mutated in place).
 *
 * Must be called BEFORE any `defineQuery` for this component.
 * Tag components (no fields) are returned unchanged.
 */
export function sabBackComponent<C>(component: C): C {
  const comp = component as unknown as Record<string | symbol, unknown>;

  // Tag component: no schema, no field stores, nothing to back.
  // (Tag stores carry $tagStore; data components do not — hence the
  // non-throwing lookup.)
  const tagSym = findSymbol(comp, "tagStore");
  if (tagSym !== undefined && comp[tagSym] === true) return component;

  // Boot-time sizing guard: the component's store size must equal the
  // capacity these SABs are allocated for.
  const storeSize = comp[symbolByDescription(comp, "storeSize")];
  if (storeSize !== SAB_ENTITY_CAPACITY) {
    throw new Error(
      `sab-store: component store size ${String(storeSize)} != SAB_ENTITY_CAPACITY ${SAB_ENTITY_CAPACITY}`,
    );
  }

  // Pass 1: compute layout. One SAB, fields in Object.keys() order, each
  // aligned to its BYTES_PER_ELEMENT.
  interface FieldLayout {
    key: string;
    kind: "scalar" | "array";
    ctor: TypedArrayCtor;
    length: number;
    offset: number;
    old: unknown;
    oldParent?: TypedArray;
    storeSize?: number;
    perEid?: number;
  }
  const fields: FieldLayout[] = [];
  let totalBytes = 0;
  for (const key of Object.keys(comp)) {
    const value = comp[key];
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      // Scalar field store: a single typed array of length = capacity.
      const view = value as TypedArray;
      const bpe = view.BYTES_PER_ELEMENT;
      const offset = Math.ceil(totalBytes / bpe) * bpe;
      fields.push({
        key,
        kind: "scalar",
        ctor: view.constructor as TypedArrayCtor,
        length: view.length,
        offset,
        old: value,
      });
      totalBytes = offset + view.length * bpe;
    } else if (isArrayStore(value)) {
      // Array-type field: JS array of per-eid subarray views.
      const store = value as unknown[];
      const parent = (store as unknown as Record<symbol, unknown>)[
        symbolByDescription(store, "parentArray")
      ] as TypedArray;
      const perEid = (store[0] as TypedArray).length;
      const bpe = parent.BYTES_PER_ELEMENT;
      const offset = Math.ceil(totalBytes / bpe) * bpe;
      fields.push({
        key,
        kind: "array",
        ctor: parent.constructor as TypedArrayCtor,
        length: store.length * perEid,
        offset,
        old: value,
        oldParent: parent,
        storeSize: store.length,
        perEid,
      });
      totalBytes = offset + store.length * perEid * bpe;
    } else if (value !== null && typeof value === "object") {
      // Nested schema or unexpected shape: fail loudly, never skip silently.
      throw new Error(
        `sab-store: component field "${key}" has unsupported nested/object shape`,
      );
    }
    // Non-object values (none expected) are ignored.
  }
  if (fields.length === 0) {
    throw new Error("sab-store: no field stores found on component");
  }

  const sab = new SharedArrayBuffer(totalBytes);

  // Pass 2: build SAB-backed stores, copy symbol props, swap in.
  const flatSym = symbolByDescription(comp, "storeFlattened");
  const flattened = comp[flatSym] as unknown[];
  for (const field of fields) {
    if (field.kind === "scalar") {
      const next = new field.ctor(sab, field.offset, field.length);
      for (const s of Object.getOwnPropertySymbols(field.old as object)) {
        (next as unknown as Record<symbol, unknown>)[s] = (
          field.old as Record<symbol, unknown>
        )[s];
      }
      const idx = flattened.indexOf(field.old);
      if (idx !== -1) flattened[idx] = next;
      comp[field.key] = next;
    } else {
      const parent = new field.ctor(sab, field.offset, field.length);
      const store = field.old as unknown[];
      (store as unknown as Record<symbol, unknown>)[
        symbolByDescription(store, "parentArray")
      ] = parent;
      for (let eid = 0; eid < field.storeSize!; eid++) {
        const sub = (parent as unknown as { subarray: (a: number, b: number) => TypedArray }).subarray(
          eid * field.perEid!,
          (eid + 1) * field.perEid!,
        );
        const oldSub = store[eid] as Record<symbol, unknown>;
        for (const s of Object.getOwnPropertySymbols(oldSub)) {
          (sub as unknown as Record<symbol, unknown>)[s] = oldSub[s];
        }
        store[eid] = sub;
      }
      // $storeFlattened holds the store object itself (same identity),
      // so no entry swap is needed for array stores.
    }
  }
  return component;
}

/**
 * Define a bitECS component whose field stores live in a
 * SharedArrayBuffer. Drop-in replacement for `defineComponent` for
 * data components (schemas with fields). Stores are always sized to
 * SAB_ENTITY_CAPACITY — there is no size parameter, because a component
 * sized differently would be inconsistent with the fixed-capacity SAB
 * layout this module guarantees. Tag components
 * (`defineComponent()` with no schema) do not need this — they carry no
 * data, so call sites keep plain `defineComponent()`.
 */
export function defineSABComponent<T extends ISchema>(
  schema: T,
): ComponentType<T> {
  if (!(SAB_ENTITY_CAPACITY > 0)) {
    throw new Error("sab-store: SAB_ENTITY_CAPACITY must be > 0");
  }
  const comp = defineComponent(schema, SAB_ENTITY_CAPACITY);
  return sabBackComponent(comp);
}

// ---------------------------------------------------------------------------
// Zero-Copy Hybrid Engine Data Plane Memory Arena (ENGINE_IMPLEMENTATION_SPEC.md §2)
// ---------------------------------------------------------------------------

/** Default entity capacity for the standalone/hybrid zero-copy matrix plane. */
export const DATA_PLANE_ENTITY_CAPACITY = 10_000;
export const BYTES_PER_FLOAT = 4;
export const BYTES_PER_INT = 4;
export const CACHE_LINE_BYTES = 64;

/**
 * Structure of Arrays (SoA) / Strided Matrix Layout Map Per Entity Index.
 * Padded to 32 bytes (8 x 4-byte words) per entity for direct SIMD vector alignment.
 */
export const SOA_LAYOUT = {
  // Float32 Fields
  POSITION_X: 0,
  POSITION_Y: 1,
  POSITION_Z: 2,
  VELOCITY_X: 3,
  VELOCITY_Y: 4,
  VELOCITY_Z: 5,
  // Int32 Fields
  HEALTH:     6,
  INTENT_BIT: 7,
  STRIDE:     8, // Total 32 bytes per entity (8 components * 4 bytes)
} as const;

/** Action / Intent bitflags written into INTENT_BIT or passed via the SPSC command ring. */
export const INTENT_FLAGS = {
  NONE:               0,
  FORWARD:            1 << 0, // +Z
  BACKWARD:           1 << 1, // -Z
  LEFT:               1 << 2, // -X
  RIGHT:              1 << 3, // +X
  UP:                 1 << 4, // +Y
  DOWN:               1 << 5, // -Y
  SPRINT:             1 << 6, // 2x speed multiplier
  PERSIST_CHECKPOINT: 1 << 8, // Triggers async persistence transaction on the Secondary Ring
} as const;

/** Byte offsets within the Master SharedArrayBuffer memory arena. */
export const OFFSETS = {
  MATRIX: 0,
  RINGS: DATA_PLANE_ENTITY_CAPACITY * SOA_LAYOUT.STRIDE * BYTES_PER_FLOAT, // Staged right after the matrix array (320,000)
  PERSIST_RING: DATA_PLANE_ENTITY_CAPACITY * SOA_LAYOUT.STRIDE * BYTES_PER_FLOAT + 16_384, // Secondary SPSC ring for Persistence Worker
  TELEMETRY: DATA_PLANE_ENTITY_CAPACITY * SOA_LAYOUT.STRIDE * BYTES_PER_FLOAT + 49_152, // Lockless atomic telemetry words
  BAKE: DATA_PLANE_ENTITY_CAPACITY * SOA_LAYOUT.STRIDE * BYTES_PER_FLOAT + 65_536, // 64KB allocated for thread coordination fields
} as const;

/** Lockless atomic telemetry word indices at OFFSETS.TELEMETRY. */
export const TELEMETRY_SLOTS = {
  TICK_COUNT: 0,
  LAST_TICK_US: 1,
  MAX_TICK_US: 2,
  COMMANDS_PROCESSED: 3,
  PERSIST_ENQUEUED: 4,
  PERSIST_COMMITTED: 5,
  BUDGET_OVERRUNS: 6,
  SHUTDOWN_SIGNAL: 7,
  SPIRAL_EVENTS: 8,
  DROPPED_MS: 9,
  COUNT: 10,
} as const;

export interface MemoryArenaOffsets {
  readonly MATRIX: number;
  readonly RINGS: number;
  readonly PERSIST_RING: number;
  readonly TELEMETRY: number;
  readonly BAKE: number;
  readonly PLANAR_SOA: number;
}

/** Round `byteOffset` up to a 64-byte CPU cache-line boundary. */
export function alignCacheLine(byteOffset: number): number {
  return Math.ceil(byteOffset / CACHE_LINE_BYTES) * CACHE_LINE_BYTES;
}

/** Compute byte-aligned arena offsets for a given `entityCapacity`. */
export function computeArenaOffsets(
  entityCapacity: number = DATA_PLANE_ENTITY_CAPACITY,
): MemoryArenaOffsets {
  const matrixBytes = entityCapacity * SOA_LAYOUT.STRIDE * BYTES_PER_FLOAT;
  const rings = alignCacheLine(matrixBytes);
  const persistRing = rings + 16_384;
  const telemetry = rings + 49_152;
  const bake = rings + 65_536;
  const planarSoA = alignCacheLine(bake);
  return {
    MATRIX: 0,
    RINGS: rings,
    PERSIST_RING: persistRing,
    TELEMETRY: telemetry,
    BAKE: bake,
    PLANAR_SOA: planarSoA,
  };
}

/**
 * Instantiates the absolute, page-aligned master shared memory allocation layer
 * (ENGINE_IMPLEMENTATION_SPEC.md §2).
 */
export function createSharedMemoryPlane(
  entityCapacity: number = DATA_PLANE_ENTITY_CAPACITY,
  heapMegabytes: number = 32,
): SharedArrayBuffer {
  if (!Number.isInteger(entityCapacity) || entityCapacity <= 0) {
    throw new RangeError(`sab-store: entityCapacity must be a positive integer (got ${entityCapacity})`);
  }
  if (!(heapMegabytes > 0)) {
    throw new RangeError(`sab-store: heapMegabytes must be > 0 (got ${heapMegabytes})`);
  }
  const offsets =
    entityCapacity === DATA_PLANE_ENTITY_CAPACITY
      ? OFFSETS
      : computeArenaOffsets(entityCapacity);
  // Matrix Block + 64KB Atomic Rings Configuration Room + 32MB Heap Space for Chunks, Planar SoA & NavMesh Bakes
  const totalBytes = offsets.BAKE + Math.ceil(heapMegabytes * 1024 * 1024);
  return new SharedArrayBuffer(totalBytes);
}

/**
 * DoD Planar SoA views carved from the shared memory plane.
 * Each column is contiguous and 64-byte cache-line aligned so 4-wide SSE2 / 8-wide AVX2
 * vector loads never cross component boundaries or waste L1 cache bandwidth on unused fields.
 */
export interface PlanarSoAViews {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly hp: Int32Array;
  readonly intent: Int32Array;
  /** 1 bit per entity (ceil(entityCapacity / 32) Uint32 words). */
  readonly aliveBitset: Uint32Array;
}

export interface SharedMemoryPlaneViews {
  readonly sab: SharedArrayBuffer;
  readonly entityCapacity: number;
  readonly offsets: MemoryArenaOffsets;
  readonly floatMatrixView: Float32Array;
  readonly intMatrixView: Int32Array;
  readonly telemetryView: Int32Array;
  readonly planar: PlanarSoAViews;
}

/**
 * Attach typed-array views (both interleaved strided Matrix and Planar SoA columns)
 * to a SharedArrayBuffer created by `createSharedMemoryPlane()`.
 */
export function attachSharedMemoryPlane(
  sab: SharedArrayBuffer,
  entityCapacity: number = DATA_PLANE_ENTITY_CAPACITY,
): SharedMemoryPlaneViews {
  const offsets = computeArenaOffsets(entityCapacity);
  const matrixLen = entityCapacity * SOA_LAYOUT.STRIDE;
  const floatMatrixView = new Float32Array(sab, offsets.MATRIX, matrixLen);
  const intMatrixView = new Int32Array(sab, offsets.MATRIX, matrixLen);
  const telemetryView = new Int32Array(sab, offsets.TELEMETRY, TELEMETRY_SLOTS.COUNT);

  const colBytes = alignCacheLine(entityCapacity * BYTES_PER_FLOAT);
  let cursor = offsets.PLANAR_SOA;
  const nextF32 = (): Float32Array => {
    const view = new Float32Array(sab, cursor, entityCapacity);
    cursor += colBytes;
    return view;
  };
  const nextI32 = (): Int32Array => {
    const view = new Int32Array(sab, cursor, entityCapacity);
    cursor += colBytes;
    return view;
  };
  const px = nextF32();
  const py = nextF32();
  const pz = nextF32();
  const vx = nextF32();
  const vy = nextF32();
  const vz = nextF32();
  const hp = nextI32();
  const intent = nextI32();
  const bitsetWords = Math.ceil(entityCapacity / 32);
  const aliveBitset = new Uint32Array(sab, cursor, bitsetWords);

  return {
    sab,
    entityCapacity,
    offsets,
    floatMatrixView,
    intMatrixView,
    telemetryView,
    planar: { px, py, pz, vx, vy, vz, hp, intent, aliveBitset },
  };
}

/** Synchronize the strided matrix view into the Planar SoA columns and alive bitset. */
export function syncMatrixToPlanar(views: SharedMemoryPlaneViews, count: number = views.entityCapacity): void {
  const { floatMatrixView, intMatrixView, planar } = views;
  const n = Math.min(count, views.entityCapacity);
  planar.aliveBitset.fill(0);
  for (let i = 0; i < n; i++) {
    const base = i * SOA_LAYOUT.STRIDE;
    planar.px[i] = floatMatrixView[base + SOA_LAYOUT.POSITION_X];
    planar.py[i] = floatMatrixView[base + SOA_LAYOUT.POSITION_Y];
    planar.pz[i] = floatMatrixView[base + SOA_LAYOUT.POSITION_Z];
    planar.vx[i] = floatMatrixView[base + SOA_LAYOUT.VELOCITY_X];
    planar.vy[i] = floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y];
    planar.vz[i] = floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z];
    const h = intMatrixView[base + SOA_LAYOUT.HEALTH];
    planar.hp[i] = h;
    planar.intent[i] = intMatrixView[base + SOA_LAYOUT.INTENT_BIT];
    if (h > 0) {
      planar.aliveBitset[i >>> 5] |= 1 << (i & 31);
    }
  }
}

/** Synchronize Planar SoA columns back into the strided matrix view. */
export function syncPlanarToMatrix(views: SharedMemoryPlaneViews, count: number = views.entityCapacity): void {
  const { floatMatrixView, intMatrixView, planar } = views;
  const n = Math.min(count, views.entityCapacity);
  for (let i = 0; i < n; i++) {
    const base = i * SOA_LAYOUT.STRIDE;
    floatMatrixView[base + SOA_LAYOUT.POSITION_X] = planar.px[i];
    floatMatrixView[base + SOA_LAYOUT.POSITION_Y] = planar.py[i];
    floatMatrixView[base + SOA_LAYOUT.POSITION_Z] = planar.pz[i];
    floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] = planar.vx[i];
    floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y] = planar.vy[i];
    floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] = planar.vz[i];
    intMatrixView[base + SOA_LAYOUT.HEALTH] = planar.hp[i];
    intMatrixView[base + SOA_LAYOUT.INTENT_BIT] = planar.intent[i];
  }
}


// =============================================================================
// PATCH-02 & PATCH-05: Space-Filling Curves & Generational Slab Allocator
// =============================================================================

export interface EntitySnapshot {
  px?: number;
  py?: number;
  pz?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  hp?: number;
  mana?: number;
  intent?: number;
}

export function writeEntityStateToSAB(
  floatMatrixView: Float32Array,
  entityIndex: number,
  state: Partial<EntitySnapshot>
): void {
  const base = entityIndex * SOA_LAYOUT.STRIDE;
  if (state.px !== undefined) floatMatrixView[base + SOA_LAYOUT.POSITION_X] = state.px;
  if (state.py !== undefined) floatMatrixView[base + SOA_LAYOUT.POSITION_Y] = state.py;
  if (state.pz !== undefined) floatMatrixView[base + SOA_LAYOUT.POSITION_Z] = state.pz;
  if (state.vx !== undefined) floatMatrixView[base + SOA_LAYOUT.VELOCITY_X] = state.vx;
  if (state.vy !== undefined) floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y] = state.vy;
  if (state.vz !== undefined) floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z] = state.vz;
  const intView = new Int32Array(floatMatrixView.buffer, floatMatrixView.byteOffset, floatMatrixView.length);
  if (state.hp !== undefined) {
    intView[base + SOA_LAYOUT.HEALTH] = state.hp;
  }
  if (state.intent !== undefined) {
    intView[base + SOA_LAYOUT.INTENT_BIT] = state.intent;
  }
}

export function readEntityStateFromSAB(
  floatMatrixView: Float32Array,
  entityIndex: number
): {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  intent: number;
} {
  const base = entityIndex * SOA_LAYOUT.STRIDE;
  const intView = new Int32Array(floatMatrixView.buffer, floatMatrixView.byteOffset, floatMatrixView.length);
  return {
    px: floatMatrixView[base + SOA_LAYOUT.POSITION_X],
    py: floatMatrixView[base + SOA_LAYOUT.POSITION_Y],
    pz: floatMatrixView[base + SOA_LAYOUT.POSITION_Z],
    vx: floatMatrixView[base + SOA_LAYOUT.VELOCITY_X],
    vy: floatMatrixView[base + SOA_LAYOUT.VELOCITY_Y],
    vz: floatMatrixView[base + SOA_LAYOUT.VELOCITY_Z],
    hp: intView[base + SOA_LAYOUT.HEALTH],
    intent: intView[base + SOA_LAYOUT.INTENT_BIT],
  };
}

export function setEntityAliveBit(aliveBitset: Uint32Array, entityIndex: number, alive: boolean): void {
  const w = entityIndex >>> 5;
  const b = 1 << (entityIndex & 31);
  if (alive) {
    aliveBitset[w] |= b;
  } else {
    aliveBitset[w] &= ~b;
  }
}

/**
 * Spreads the lower 16 bits of `v` so there is 1 zero bit between each bit.
 * SWAR (SIMD Within A Register) branchless bit-interleaving (Karras 2012).
 */
export function part1By1(v: number): number {
  let x = v & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x >>> 0;
}

/**
 * Compacts every even bit of `v` back into the lower 16 bits (inverse of part1By1).
 */
export function compact1By1(v: number): number {
  let x = v & 0x55555555;
  x = (x | (x >>> 1)) & 0x33333333;
  x = (x | (x >>> 2)) & 0x0f0f0f0f;
  x = (x | (x >>> 4)) & 0x00ff00ff;
  x = (x | (x >>> 8)) & 0x0000ffff;
  return x >>> 0;
}

/**
 * Encodes 2D world coordinates (px, pz) within [-worldHalfExtent, +worldHalfExtent]
 * into a 32-bit Z-order Morton code.
 */
export function encodeMorton2D(
  px: number,
  pz: number,
  worldHalfExtent = 4096
): number {
  const scale = 65535 / (worldHalfExtent * 2);
  const qx = Math.max(0, Math.min(65535, ((px + worldHalfExtent) * scale) | 0));
  const qz = Math.max(0, Math.min(65535, ((pz + worldHalfExtent) * scale) | 0));
  return (part1By1(qx) | (part1By1(qz) << 1)) >>> 0;
}

export function decodeMorton2D(code: number): { qx: number; qz: number } {
  return {
    qx: compact1By1(code),
    qz: compact1By1(code >>> 1),
  };
}

/**
 * Pre-allocated Zero-GC Morton Spatial Sorter using 4-pass 8-bit Radix Sort.
 * Reorders `spatialOrder` (Uint16Array of entity indices) so spatially adjacent
 * entities are contiguous in memory.
 */
export class MortonSpatialIndex {
  public readonly mortonKeys: Uint32Array;
  public readonly spatialOrder: Uint16Array;
  private readonly scratchKeys: Uint32Array;
  private readonly scratchOrder: Uint16Array;
  private readonly histogram = new Uint32Array(256);
  public activeCount = 0;

  constructor(maxEntities: number = DATA_PLANE_ENTITY_CAPACITY) {
    this.mortonKeys = new Uint32Array(maxEntities);
    this.spatialOrder = new Uint16Array(maxEntities);
    this.scratchKeys = new Uint32Array(maxEntities);
    this.scratchOrder = new Uint16Array(maxEntities);
  }

  /**
   * Computes Morton keys from Planar SoA (px, pz, hp) and performs an O(N)
   * zero-allocation radix sort over all alive entities.
   */
  public rebuildFromSoA(
    soa: PlanarSoAViews,
    entityCount: number = DATA_PLANE_ENTITY_CAPACITY,
    worldHalfExtent = 4096
  ): number {
    const { px, pz, hp } = soa;
    let count = 0;
    const n = Math.min(entityCount, px.length);
    for (let i = 0; i < n; i++) {
      if (hp[i] > 0) {
        this.mortonKeys[count] = encodeMorton2D(px[i], pz[i], worldHalfExtent);
        this.spatialOrder[count] = i;
        count++;
      }
    }
    this.activeCount = count;
    if (count <= 1) return count;

    let srcKeys = this.mortonKeys;
    let srcOrder = this.spatialOrder;
    let dstKeys = this.scratchKeys;
    let dstOrder = this.scratchOrder;

    // 4-pass 8-bit LSD Radix Sort (32-bit Morton key)
    for (let shift = 0; shift < 32; shift += 8) {
      this.histogram.fill(0);
      for (let i = 0; i < count; i++) {
        const bucket = (srcKeys[i] >>> shift) & 0xff;
        this.histogram[bucket]++;
      }
      let prefix = 0;
      for (let b = 0; b < 256; b++) {
        const c = this.histogram[b];
        this.histogram[b] = prefix;
        prefix += c;
      }
      for (let i = 0; i < count; i++) {
        const key = srcKeys[i];
        const bucket = (key >>> shift) & 0xff;
        const pos = this.histogram[bucket]++;
        dstKeys[pos] = key;
        dstOrder[pos] = srcOrder[i];
      }
      const tmpK = srcKeys;
      srcKeys = dstKeys;
      dstKeys = tmpK;
      const tmpO = srcOrder;
      srcOrder = dstOrder;
      dstOrder = tmpO;
    }
    return count;
  }

  /**
   * Queries all alive entities within `radius` of `(centerX, centerZ)` using
   * Morton Z-order bounding box binary search + exact Euclidean distance filter.
   * Zero heap allocations: writes matching entity indices into `outEntityIndices`.
   */
  public queryRadius(
    soa: PlanarSoAViews,
    centerX: number,
    centerZ: number,
    radius: number,
    outEntityIndices: Uint16Array,
    worldHalfExtent = 4096
  ): number {
    if (this.activeCount === 0) return 0;
    const minCode = encodeMorton2D(centerX - radius, centerZ - radius, worldHalfExtent);
    const maxCode = encodeMorton2D(centerX + radius, centerZ + radius, worldHalfExtent);

    // Lower-bound binary search for minCode
    let lo = 0;
    let hi = this.activeCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.mortonKeys[mid] < minCode) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const rSq = radius * radius;
    const { px, pz } = soa;
    let found = 0;
    const maxOut = outEntityIndices.length;

    for (let idx = lo; idx < this.activeCount && this.mortonKeys[idx] <= maxCode; idx++) {
      const entityId = this.spatialOrder[idx];
      const dx = px[entityId] - centerX;
      const dz = pz[entityId] - centerZ;
      if (dx * dx + dz * dz <= rSq) {
        outEntityIndices[found++] = entityId;
        if (found >= maxOut) break;
      }
    }
    return found;
  }
}

export function packEntityHandle(index: number, generation: number): number {
  return (((generation & 0xffff) << 16) | (index & 0xffff)) >>> 0;
}

export function unpackEntityHandle(handle: number): {
  index: number;
  generation: number;
} {
  return {
    index: handle & 0xffff,
    generation: (handle >>> 16) & 0xffff,
  };
}

/**
 * Returns the index (0..31) of the least-significant set bit in a non-zero 32-bit word.
 */
function ctz32(word: number): number {
  const lowestBit = (word & -word) >>> 0;
  return 31 - Math.clz32(lowestBit);
}

/**
 * Zero-GC Generational Slab Allocator over the pre-allocated SharedArrayBuffer arena.
 * Prevents ABA stale-index bugs via 16-bit generation counters and allocates slots
 * in O(1) amortized time via a bitset freelist.
 */
export class GenerationalSlabAllocator {
  public readonly maxEntities: number;
  public readonly generations: Uint16Array;
  public readonly occupiedBitset: Uint32Array;
  private activeCount = 0;
  private searchWordHint = 0;

  constructor(maxEntities: number = DATA_PLANE_ENTITY_CAPACITY) {
    this.maxEntities = maxEntities;
    this.generations = new Uint16Array(maxEntities);
    this.generations.fill(1);
    this.occupiedBitset = new Uint32Array(Math.ceil(maxEntities / 32));
  }

  public get size(): number {
    return this.activeCount;
  }

  /**
   * Allocates the lowest available entity slot, initializes its state in the
   * SharedArrayBuffer, and returns its packed 32-bit generational handle.
   * Returns 0 if the arena is full.
   */
  public allocate(
    floatMatrixView?: Float32Array,
    soaViews?: PlanarSoAViews,
    initialState: Partial<EntitySnapshot> = { hp: 100 }
  ): number {
    if (this.activeCount >= this.maxEntities) {
      return 0;
    }

    const numWords = this.occupiedBitset.length;
    for (let step = 0; step < numWords; step++) {
      const wIdx = (this.searchWordHint + step) % numWords;
      const word = this.occupiedBitset[wIdx];
      if (word !== 0xffffffff) {
        const bit = ctz32(~word);
        const entityIndex = (wIdx << 5) + bit;
        if (entityIndex >= this.maxEntities) {
          continue;
        }
        this.occupiedBitset[wIdx] = (word | (1 << bit)) >>> 0;
        this.searchWordHint = wIdx;
        this.activeCount++;

        const gen = this.generations[entityIndex];
        if (floatMatrixView) {
          writeEntityStateToSAB(floatMatrixView, entityIndex, initialState);
        }
        if (soaViews) {
          const hp = initialState.hp ?? 100;
          soaViews.px[entityIndex] = initialState.px ?? 0;
          soaViews.py[entityIndex] = initialState.py ?? 0;
          soaViews.pz[entityIndex] = initialState.pz ?? 0;
          soaViews.vx[entityIndex] = initialState.vx ?? 0;
          soaViews.vy[entityIndex] = initialState.vy ?? 0;
          soaViews.vz[entityIndex] = initialState.vz ?? 0;
          soaViews.hp[entityIndex] = hp;
          if (initialState.intent !== undefined) {
            soaViews.intent[entityIndex] = initialState.intent;
          }
          setEntityAliveBit(soaViews.aliveBitset, entityIndex, hp > 0);
        }
        return packEntityHandle(entityIndex, gen);
      }
    }
    return 0;
  }

  /**
   * Validates whether a packed 32-bit handle refers to a currently live entity
   * of the exact same generation (ABA guard).
   */
  public isValid(handle: number): boolean {
    if (handle === 0) return false;
    const index = handle & 0xffff;
    const gen = (handle >>> 16) & 0xffff;
    if (index >= this.maxEntities) return false;
    const word = this.occupiedBitset[index >>> 5];
    const isOccupied = (word & (1 << (index & 31))) !== 0;
    return isOccupied && this.generations[index] === gen;
  }

  /**
   * Frees the entity slot associated with `handle`, increments its 16-bit
   * generation counter (wrapping 65535 -> 1), and clears its alive bit in SAB.
   * Returns false if `handle` was already stale/freed.
   */
  public free(
    handle: number,
    floatMatrixView?: Float32Array,
    soaViews?: PlanarSoAViews
  ): boolean {
    if (!this.isValid(handle)) {
      return false;
    }
    const index = handle & 0xffff;
    const wIdx = index >>> 5;
    const bit = index & 31;
    this.occupiedBitset[wIdx] &= ~(1 << bit);
    if (wIdx < this.searchWordHint) {
      this.searchWordHint = wIdx;
    }
    this.activeCount--;

    const nextGen = (this.generations[index] + 1) & 0xffff;
    this.generations[index] = nextGen === 0 ? 1 : nextGen;

    if (floatMatrixView) {
      writeEntityStateToSAB(floatMatrixView, index, {
        px: 0,
        py: 0,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        hp: 0,
        intent: 0,
      });
    }
    if (soaViews) {
      soaViews.hp[index] = 0;
      setEntityAliveBit(soaViews.aliveBitset, index, false);
    }
    return true;
  }
}
