// Re-export SPSC implementations from logging package
export * from "@mmo-engine/logging/dist/src/lockless-ring.js";

// Additional imports for MPSC constants
import {
  DEFAULT_RING_CAPACITY,
  COMMAND_SLOT_UINT32_STRIDE,
  MPSC_HEADER_BYTES,
  MPSC_ENQUEUE_IDX,
  MPSC_DEQUEUE_IDX,
  MPSC_DROPPED_IDX,
} from "@mmo-engine/logging/dist/src/lockless-ring.js";

/** Common command-token queue interface satisfied by both AtomicSPSCQueue and AtomicMPSCQueue. */
export interface DataPlaneCommandQueue {
  readonly capacity: number;
  enqueue(token: number): boolean;
  enqueueBatch(items: ArrayLike<number>, count?: number): number;
  dequeue(): number | null;
  drainTo(out: Int32Array, maxItems?: number): number;
  size(): number;
  reset(): void;
}

/** Atomic initialization guard word inside the 192-byte MPSC header (words 44..47 are spare). */
const MPSC_INIT_STATE_IDX = 44;

/**
 * Utility: checks if a number is a power of two.
 * Used for validating ring buffer capacities.
 */
function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Dmitry Vyukov bounded lock‑free MPSC queue with per‑slot sequence numbers.
 * Mirrors the TypeScript spec from PATCH‑03 and supports both 4-word structured
 * commands and single-word packed command tokens embedded in a master SAB arena.
 */
export class AtomicMPSCQueue implements DataPlaneCommandQueue {
  public readonly sab: SharedArrayBuffer;
  public readonly byteOffset: number;
  public readonly capacity: number;
  public readonly mask: number;
  public readonly slotStrideU32: number;

  private readonly ctrl: Int32Array; // [0: enqueueIdx, 16: dequeueIdx, 32: droppedCount, 44: initState]
  private readonly seq: Int32Array; // per‑slot sequence numbers
  private readonly data: Uint32Array; // flat data storage

  /** Calculate the exact SAB byte footprint required for an MPSC queue. */
  public static byteLengthFor(
    capacity: number = DEFAULT_RING_CAPACITY,
    slotStrideU32: number = 1,
  ): number {
    return MPSC_HEADER_BYTES + capacity * 4 + capacity * slotStrideU32 * 4;
  }

  /** Attach or initialize a single-word packed command-token MPSC ring inside a shared memory arena. */
  public static attachTokenRing(
    sab: SharedArrayBuffer,
    byteOffset: number,
    capacity: number = DEFAULT_RING_CAPACITY,
  ): AtomicMPSCQueue {
    return new AtomicMPSCQueue(capacity, 1, sab, byteOffset);
  }

  constructor(
    capacity: number = DEFAULT_RING_CAPACITY,
    slotStrideU32: number = COMMAND_SLOT_UINT32_STRIDE,
    existingSab?: SharedArrayBuffer,
    byteOffset: number = 0,
  ) {
    if (!isPowerOfTwo(capacity)) {
      throw new RangeError(`Ring capacity must be a power of 2, received ${capacity}`);
    }
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset % 4 !== 0) {
      throw new RangeError(`AtomicMPSCQueue: byteOffset must be 4-byte aligned (got ${byteOffset})`);
    }
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.slotStrideU32 = slotStrideU32;
    this.byteOffset = byteOffset;

    const seqBytes = capacity * 4; // Int32 per slot
    const dataBytes = capacity * slotStrideU32 * 4; // Uint32 per slot * stride
    const totalBytes = MPSC_HEADER_BYTES + seqBytes + dataBytes;

    if (existingSab && byteOffset + totalBytes > existingSab.byteLength) {
      throw new RangeError(
        `AtomicMPSCQueue: region [${byteOffset}..${byteOffset + totalBytes}) exceeds SAB size ${existingSab.byteLength}`,
      );
    }

    this.sab = existingSab ?? new SharedArrayBuffer(totalBytes);
    this.ctrl = new Int32Array(this.sab, byteOffset, MPSC_HEADER_BYTES / 4);
    this.seq = new Int32Array(this.sab, byteOffset + MPSC_HEADER_BYTES, capacity);
    this.data = new Uint32Array(
      this.sab,
      byteOffset + MPSC_HEADER_BYTES + seqBytes,
      capacity * slotStrideU32,
    );

    if (!existingSab) {
      for (let i = 0; i < capacity; i++) {
        Atomics.store(this.seq, i, i);
      }
      Atomics.store(this.ctrl, MPSC_INIT_STATE_IDX, 2);
    } else {
      const state = Atomics.compareExchange(this.ctrl, MPSC_INIT_STATE_IDX, 0, 1);
      if (state === 0) {
        Atomics.store(this.ctrl, MPSC_ENQUEUE_IDX, 0);
        Atomics.store(this.ctrl, MPSC_DEQUEUE_IDX, 0);
        Atomics.store(this.ctrl, MPSC_DROPPED_IDX, 0);
        for (let i = 0; i < capacity; i++) {
          Atomics.store(this.seq, i, i);
        }
        Atomics.store(this.ctrl, MPSC_INIT_STATE_IDX, 2);
      } else if (state === 1) {
        while (Atomics.load(this.ctrl, MPSC_INIT_STATE_IDX) === 1) {
          // Wait for concurrent creator to finish one-time sequence initialization
        }
      }
    }
  }

  /** Enqueue a single 32-bit packed command token (zero-closure lock-free MPSC). */
  public enqueue(actionPayload: number): boolean {
    const mask = this.mask;
    const stride = this.slotStrideU32;
    let pos = Atomics.load(this.ctrl, 0);
    for (;;) {
      const slotIdx = pos & mask;
      const dif = Atomics.load(this.seq, slotIdx) - pos;
      if (dif === 0) {
        const prev = Atomics.compareExchange(this.ctrl, 0, pos, pos + 1);
        if (prev === pos) {
          this.data[slotIdx * stride] = actionPayload >>> 0;
          Atomics.store(this.seq, slotIdx, pos + 1);
          return true;
        }
        pos = prev;
      } else if (dif < 0) {
        Atomics.add(this.ctrl, 32, 1);
        return false;
      } else {
        pos = Atomics.load(this.ctrl, 0);
      }
    }
  }

  /** Batch-enqueue up to `count` packed tokens without closure overhead. */
  public enqueueBatch(items: ArrayLike<number>, count: number = items.length): number {
    const n = Math.min(count, items.length);
    let written = 0;
    for (let i = 0; i < n; i++) {
      if (!this.enqueue(items[i])) break;
      written++;
    }
    return written;
  }

  /** Enqueue a command (entityIndex, actionCode, tickOrMeta, argFloatBits). */
  public enqueueCommand(
    entityIndex: number,
    actionCode: number,
    tickOrMeta = 0,
    argFloatBits = 0,
  ): boolean {
    const mask = this.mask;
    let pos = Atomics.load(this.ctrl, MPSC_ENQUEUE_IDX);
    for (;;) {
      const slotIdx = pos & mask;
      const seq = Atomics.load(this.seq, slotIdx);
      const dif = seq - pos;
      if (dif === 0) {
        const prev = Atomics.compareExchange(
          this.ctrl,
          MPSC_ENQUEUE_IDX,
          pos,
          pos + 1,
        );
        if (prev === pos) {
          const base = slotIdx * this.slotStrideU32;
          this.data[base] = entityIndex >>> 0;
          this.data[base + 1] = actionCode >>> 0;
          if (this.slotStrideU32 > 2) this.data[base + 2] = tickOrMeta >>> 0;
          if (this.slotStrideU32 > 3) this.data[base + 3] = argFloatBits >>> 0;
          // Publish slot to consumer with release store
          Atomics.store(this.seq, slotIdx, pos + 1);
          return true;
        }
        pos = prev;
      } else if (dif < 0) {
        // Full queue
        Atomics.add(this.ctrl, MPSC_DROPPED_IDX, 1);
        return false;
      } else {
        pos = Atomics.load(this.ctrl, MPSC_ENQUEUE_IDX);
      }
    }
  }

  /** Single-consumer dequeue returning the packed Int32 token or null when empty (zero closures). */
  public dequeue(): number | null {
    const pos = Atomics.load(this.ctrl, 16);
    const slotIdx = pos & this.mask;
    if (Atomics.load(this.seq, slotIdx) !== pos + 1) {
      return null;
    }
    const value = this.data[slotIdx * this.slotStrideU32] | 0;
    Atomics.store(this.seq, slotIdx, pos + this.capacity);
    Atomics.store(this.ctrl, 16, pos + 1);
    return value;
  }

  /** Zero-allocation batch drain into caller-supplied Int32Array. */
  public drainTo(out: Int32Array, maxItems: number = out.length): number {
    const mask = this.mask;
    const cap = this.capacity;
    const stride = this.slotStrideU32;
    const limit = Math.min(maxItems, out.length);
    let pos = Atomics.load(this.ctrl, 16);
    let read = 0;

    while (read < limit) {
      const slotIdx = pos & mask;
      if (Atomics.load(this.seq, slotIdx) !== pos + 1) break;
      out[read++] = this.data[slotIdx * stride] | 0;
      Atomics.store(this.seq, slotIdx, pos + cap);
      pos += 1;
    }

    if (read > 0) {
      Atomics.store(this.ctrl, 16, pos);
    }
    return read;
  }

  /** Drain up to maxDrain commands, invoking visitor for each. */
  public drainCommands(
    visitor: (
      entityIndex: number,
      actionCode: number,
      tickOrMeta: number,
      argFloatBits: number,
    ) => void,
    maxDrain: number = this.capacity,
  ): number {
    const mask = this.mask;
    const cap = this.capacity;
    let pos = Atomics.load(this.ctrl, MPSC_DEQUEUE_IDX);
    let drained = 0;
    while (drained < maxDrain) {
      const slotIdx = pos & mask;
      const seq = Atomics.load(this.seq, slotIdx);
      const dif = seq - (pos + 1);
      if (dif === 0) {
        const base = slotIdx * this.slotStrideU32;
        const entityIndex = this.data[base];
        const actionCode = this.data[base + 1];
        const tickOrMeta = this.data[base + 2];
        const argFloatBits = this.data[base + 3];
        // Mark slot as free for next round
        Atomics.store(this.seq, slotIdx, pos + cap);
        pos += 1;
        drained += 1;
        visitor(entityIndex, actionCode, tickOrMeta, argFloatBits);
      } else {
        break;
      }
    }
    if (drained > 0) {
      Atomics.store(this.ctrl, MPSC_DEQUEUE_IDX, pos);
    }
    return drained;
  }

  /** Approximate current queued element count. */
  public size(): number {
    const enq = Atomics.load(this.ctrl, 0);
    const deq = Atomics.load(this.ctrl, 16);
    const delta = (enq - deq) | 0;
    if (delta <= 0) return 0;
    return delta > this.capacity ? this.capacity : delta;
  }

  /** Reset queue indices and sequence counters (call only when no concurrent producer/consumer is active). */
  public reset(): void {
    Atomics.store(this.ctrl, 0, 0);
    Atomics.store(this.ctrl, 16, 0);
    Atomics.store(this.ctrl, 32, 0);
    for (let i = 0; i < this.capacity; i++) {
      Atomics.store(this.seq, i, i);
    }
    Atomics.store(this.ctrl, MPSC_INIT_STATE_IDX, 2);
  }

  get droppedCount() {
    return Atomics.load(this.ctrl, MPSC_DROPPED_IDX);
  }
}
