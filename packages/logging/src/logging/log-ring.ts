/**
 * SAB Logging Layer — Log Ring Module (docs/SAB-LOGGING-LAYER-SPEC.md §2.1, §2.2)
 *
 * Implements the independent lock-free shared memory logging ring over `AtomicMPSCQueue`.
 * Slot stride: 32 x u32 = 128 bytes per record.
 * Default capacity: 16,384 records = 2MB SharedArrayBuffer arena.
 */

import { AtomicMPSCQueue } from "../lockless-ring.js";
import {
  RECORD_WORDS_U32,
  decodeLogRecord,
  type LogRecordView,
} from "./log-record.js";

export const DEFAULT_LOG_RING_CAPACITY = 16384; // 16k records = 2MB buffer

export class LogRingBuffer {
  public readonly queue: AtomicMPSCQueue;
  public readonly capacity: number;
  public readonly sab: SharedArrayBuffer;
  public readonly byteView: Uint8Array;

  constructor(
    capacity: number = DEFAULT_LOG_RING_CAPACITY,
    existingSab?: SharedArrayBuffer,
  ) {
    this.capacity = capacity;
    this.queue = new AtomicMPSCQueue(capacity, RECORD_WORDS_U32, existingSab);
    this.sab = this.queue.sab;
    this.byteView = new Uint8Array(this.sab);
  }

  /**
   * Set minimum log level threshold for a producer (atomic, runtime-changeable).
   * Producers check this in nanoseconds on the hot path before attempting enqueue.
   */
  public setLevelMask(producer: number, minLevel: number): void {
    this.queue.setLevelMask(producer, minLevel);
  }

  /**
   * Get minimum log level threshold for a producer.
   */
  public getLevelMask(producer: number): number {
    return this.queue.getLevelMask(producer);
  }

  /** Total records dropped due to ring saturation. */
  public get droppedCount(): number {
    return this.queue.droppedCount;
  }

  /**
   * Drain up to `max` records from the ring and invoke `visitor` for each.
   * Runs exclusively on the Log Worker thread.
   */
  public drain(
    visitor: (rec: LogRecordView) => void,
    max: number = this.capacity,
  ): number {
    return this.queue.drainRaw((data, base) => {
      const rec = decodeLogRecord(data, base);
      visitor(rec);
    }, max);
  }
}
