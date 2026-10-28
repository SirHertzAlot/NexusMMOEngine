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

/**
 * Utility: checks if a number is a power of two.
 * Used for validating ring buffer capacities.
 */
function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Dmitry Vyukov bounded lock‑free MPSC queue with per‑slot sequence numbers.
 * Mirrors the TypeScript spec from PATCH‑03.
 */
export class AtomicMPSCQueue {
  public readonly sab: SharedArrayBuffer;
  public readonly capacity: number;
  public readonly mask: number;
  public readonly slotStrideU32: number;

  private readonly ctrl: Int32Array; // [enqueueIdx, dequeueIdx, droppedCount]
  private readonly seq: Int32Array; // per‑slot sequence numbers
  private readonly data: Uint32Array; // flat data storage

  constructor(
    capacity: number = DEFAULT_RING_CAPACITY,
    slotStrideU32: number = COMMAND_SLOT_UINT32_STRIDE,
    existingSab?: SharedArrayBuffer,
  ) {
    if (!isPowerOfTwo(capacity)) {
      throw new RangeError(`Ring capacity must be a power of 2, received ${capacity}`);
    }
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.slotStrideU32 = slotStrideU32;

    const seqBytes = capacity * 4; // Int32 per slot
    const dataBytes = capacity * slotStrideU32 * 4; // Uint32 per slot * stride
    const totalBytes = MPSC_HEADER_BYTES + seqBytes + dataBytes;

    this.sab = existingSab ?? new SharedArrayBuffer(totalBytes);
    this.ctrl = new Int32Array(this.sab, 0, MPSC_HEADER_BYTES / 4);
    this.seq = new Int32Array(this.sab, MPSC_HEADER_BYTES, capacity);
    this.data = new Uint32Array(
      this.sab,
      MPSC_HEADER_BYTES + seqBytes,
      capacity * slotStrideU32,
    );

    if (!existingSab) {
      for (let i = 0; i < capacity; i++) {
        Atomics.store(this.seq, i, i);
      }
    }
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
          this.data[base + 2] = tickOrMeta >>> 0;
          this.data[base + 3] = argFloatBits >>> 0;
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
  public dequeue(): number | null {
    // Simple shim for SPSC-style dequeue using the MPSC queue.
    // Attempts to drain a single command; returns the entityIndex or null if empty.
    let result: number | null = null;
    this.drainCommands((entityIndex, _, __, ___) => {
      result = entityIndex;
    }, 1);
    return result;
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
    const enq = Atomics.load(this.ctrl, MPSC_ENQUEUE_IDX);
    const deq = Atomics.load(this.ctrl, MPSC_DEQUEUE_IDX);
    return enq >= deq ? enq - deq : this.capacity - deq + enq;
  }

  get droppedCount() {
    return Atomics.load(this.ctrl, MPSC_DROPPED_IDX);
  }
}
