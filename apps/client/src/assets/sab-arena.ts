/**
 * SAB arena — the shared-memory handoff for the client asset pipeline (SAB Phase 6).
 *
 * A worker decodes an asset (meshopt-compressed GLB geometry) and writes the
 * decoded, tightly-packed attribute bytes into this arena; the main thread
 * then builds THREE.BufferGeometry attributes as typed-array *views* over
 * the same SharedArrayBuffer — no copy of the vertex data on the main
 * thread, and the decode itself never runs there.
 *
 * Protocol (single producer = worker, single consumer = main thread, one
 * arena per decode job):
 *   EMPTY -> WRITING -> READY -> CONSUMED, or WRITING -> ERROR.
 * The header lives in the first 64 bytes as an Int32Array so both sides
 * observe state transitions through Atomics. The main thread must never
 * Atomics.wait (it would block the event loop); it polls via awaitReady().
 *
 * Layout: [header: 16 x Int32][payload: bump-allocated, 8-byte aligned].
 * The allocator is a bump allocator on purpose: one job writes once, the
 * main thread consumes, the arena is discarded. No free-list, no reuse.
 */

export const SAB_ARENA_MAGIC = 0x53414241; // 'SABA'
export const SAB_ARENA_VERSION = 1;
export const SAB_ARENA_HEADER_BYTES = 64;
export const SAB_ARENA_HEADER_WORDS = SAB_ARENA_HEADER_BYTES / 4;

export enum SabArenaState {
  Empty = 0,
  Writing = 1,
  Ready = 2,
  Consumed = 3,
  Error = 4,
}

/** Header word indices (Int32Array over the first 64 bytes). */
const H = {
  Magic: 0,
  Version: 1,
  State: 2,
  /** Total arena bytes including the header. */
  Capacity: 3,
  /** Payload bytes allocated so far (excludes the header). */
  Used: 4,
  /** Number of alloc() calls served. */
  AllocCount: 5,
  /** On Error: how many payload bytes the job actually needed. */
  NeededBytes: 6,
} as const;

/** alloc() ran past the arena's capacity. Retry with a bigger arena. */
export class SabOverflowError extends Error {
  readonly neededBytes: number;
  constructor(neededBytes: number) {
    super(`SAB arena overflow: need ${neededBytes} payload bytes`);
    this.name = "SabOverflowError";
    this.neededBytes = neededBytes;
  }
}

function requireSab(): typeof SharedArrayBuffer {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error("SharedArrayBuffer is unavailable in this environment");
  }
  return SharedArrayBuffer;
}

export class SabArena {
  readonly sab: SharedArrayBuffer;
  private readonly header: Int32Array;

  /** Allocate a fresh arena. Requires SharedArrayBuffer (cross-origin isolated). */
  static create(capacityBytes: number): SabArena {
    const sab = new (requireSab())(Math.max(SAB_ARENA_HEADER_BYTES, capacityBytes));
    const arena = new SabArena(sab);
    arena.header[H.Magic] = SAB_ARENA_MAGIC;
    arena.header[H.Version] = SAB_ARENA_VERSION;
    arena.header[H.Capacity] = sab.byteLength;
    Atomics.store(arena.header, H.State, SabArenaState.Empty);
    return arena;
  }

  /** Wrap an existing SharedArrayBuffer (e.g. one received from the main thread). */
  static wrap(sab: SharedArrayBuffer): SabArena {
    return new SabArena(sab);
  }

  private constructor(sab: SharedArrayBuffer) {
    if (sab.byteLength < SAB_ARENA_HEADER_BYTES) {
      throw new Error(`SAB arena too small: ${sab.byteLength} < ${SAB_ARENA_HEADER_BYTES}`);
    }
    this.sab = sab;
    this.header = new Int32Array(sab, 0, SAB_ARENA_HEADER_WORDS);
  }

  get capacityBytes(): number {
    return Atomics.load(this.header, H.Capacity);
  }

  get usedBytes(): number {
    return Atomics.load(this.header, H.Used);
  }

  get state(): SabArenaState {
    return Atomics.load(this.header, H.State) as SabArenaState;
  }

  get neededBytes(): number {
    return Atomics.load(this.header, H.NeededBytes);
  }

  /** Producer: claim the arena for writing. */
  beginWrite(): void {
    Atomics.store(this.header, H.State, SabArenaState.Writing);
  }

  /**
   * Bump-allocate `bytes` payload bytes, 8-byte aligned so any TypedArray
   * view (Float32/Uint32/Uint16/...) over the result is alignment-valid.
   * Returns the absolute byte offset within the SAB (header included).
   * @throws SabOverflowError when the arena cannot hold the allocation.
   */
  alloc(bytes: number, alignment = 8): number {
    const used = Atomics.load(this.header, H.Used);
    const aligned = (used + alignment - 1) & ~(alignment - 1);
    const offset = SAB_ARENA_HEADER_BYTES + aligned;
    if (offset + bytes > this.sab.byteLength) {
      throw new SabOverflowError(aligned + bytes);
    }
    Atomics.store(this.header, H.Used, aligned + bytes);
    Atomics.add(this.header, H.AllocCount, 1);
    return offset;
  }

  /** Copy `data` into the arena at `offset` (from alloc). */
  write(offset: number, data: Uint8Array): void {
    new Uint8Array(this.sab, offset, data.byteLength).set(data);
  }

  /** Zero-copy view over arena bytes. The view keeps the SAB alive. */
  view(offset: number, byteLength: number): Uint8Array {
    return new Uint8Array(this.sab, offset, byteLength);
  }

  /** Zero-copy typed view over arena bytes. Offset must satisfy the type's alignment (alloc guarantees 8). */
  typed<T extends { new (buffer: ArrayBufferLike, byteOffset: number, length: number): unknown }>(
    Ctor: T,
    offset: number,
    count: number,
  ): InstanceType<T> {
    return new Ctor(this.sab, offset, count) as InstanceType<T>;
  }

  /** Producer: the payload is complete — publish it to the consumer. */
  publish(): void {
    Atomics.store(this.header, H.State, SabArenaState.Ready);
    Atomics.notify(this.header, H.State, 1);
  }

  /** Producer: the job failed (e.g. overflow). `neededBytes` lets the caller retry bigger. */
  markError(neededBytes: number): void {
    Atomics.store(this.header, H.NeededBytes, neededBytes);
    Atomics.store(this.header, H.State, SabArenaState.Error);
    Atomics.notify(this.header, H.State, 1);
  }

  /** Consumer: mark the payload consumed (diagnostics / reuse guard). */
  markConsumed(): void {
    Atomics.store(this.header, H.State, SabArenaState.Consumed);
  }

  /**
   * Consumer (main thread): wait until the arena reaches READY or ERROR.
   * Polls — Atomics.wait is illegal on the main thread — so the event loop
   * stays responsive while the worker decodes.
   */
  async awaitReady(timeoutMs = 30_000, pollMs = 1): Promise<SabArenaState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = this.state;
      if (s === SabArenaState.Ready || s === SabArenaState.Error) return s;
      if (Date.now() > deadline) throw new Error(`SAB arena timed out after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
