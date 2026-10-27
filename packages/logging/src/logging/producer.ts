/**
 * SAB Logging Layer — Producer Client (docs/SAB-LOGGING-LAYER-SPEC.md §2.1, §2.2)
 *
 * Sacred producer path:
 * - Checks atomic level mask (nanoseconds, branchless check).
 * - Enqueues fixed 128-byte binary record into `AtomicMPSCQueue` via direct atomic CAS.
 * - Zero string formatting, zero heap allocation, zero syscalls, zero closures, zero arrays.
 */

import { performance } from "node:perf_hooks";
import { LogLevel, type LogProducer } from "./log-codes.js";
import type { LogRingBuffer } from "./log-ring.js";
import {
  MPSC_ENQUEUE_IDX,
  MPSC_DROPPED_IDX,
  MPSC_LEVEL_MASKS_IDX,
} from "../lockless-ring.js";

// Layout offsets (words)
const HEADER_WORD = 0;
const TICK_WORD = 1;
const TIMESTAMP_LO_WORD = 2;
const TIMESTAMP_HI_WORD = 3;
const ENTITY_REF_LO_WORD = 4;
const ENTITY_REF_HI_WORD = 5;
const ARGS_START_WORD = 6;
const INLINE_STR_START_WORD = 14;
const ARG_TAGS_WORD = 30;
const FLAGS_VERSION_WORD = 31;

// Argument type tags
const TAG_EMPTY = 0;
const TAG_I32 = 1;
const TAG_U32 = 2;
const TAG_I64 = 4;
const TAG_STRING_INLINE = 8;

export class LogProducerClient {
  public readonly producerId: LogProducer;
  public readonly ring: LogRingBuffer;

  private readonly ctrl: Int32Array;
  private readonly seq: Int32Array;
  private readonly data: Uint32Array;
  private readonly byteView: Uint8Array;
  private readonly mask: number;
  private readonly slotStrideU32: number;
  private readonly dataByteOffset: number;

  private emitCount: number = 0;
  private cachedNowNs: number = 0;

  constructor(producerId: LogProducer, ring: LogRingBuffer) {
    this.producerId = producerId;
    this.ring = ring;

    this.ctrl = ring.queue.ctrl;
    this.seq = ring.queue.seq;
    this.data = ring.queue.data;
    this.byteView = ring.byteView;
    this.mask = ring.queue.mask;
    this.slotStrideU32 = ring.queue.slotStrideU32;
    this.dataByteOffset = this.data.byteOffset;
    this.cachedNowNs = (performance.timeOrigin + performance.now()) * 1_000_000;
  }

  /**
   * Sacred hot path log emission.
   * Runs in tens of nanoseconds with zero GC allocation.
   */
  public emit(
    level: LogLevel,
    code: number,
    entityRef?: bigint,
    a0?: number | bigint | string | boolean,
    a1?: number | bigint | string | boolean,
    a2?: number | bigint | string | boolean,
    a3?: number | bigint | string | boolean,
    tick: number = 0,
  ): boolean {
    // 1. Level Mask Filter (ERROR is never masked off)
    const minLevel = Atomics.load(this.ctrl, MPSC_LEVEL_MASKS_IDX + this.producerId);
    if (level < minLevel && level < LogLevel.ERROR) {
      return false;
    }

    // Amortized epoch-based timestamp, comparable across threads (refresh every 16 emits to eliminate OS QPC clock trap latency)
    if ((this.emitCount++ & 15) === 0) {
      this.cachedNowNs = (performance.timeOrigin + performance.now()) * 1_000_000;
    }
    const tsLo = this.cachedNowNs >>> 0;
    const tsHi = (this.cachedNowNs / 4294967296) >>> 0;

    let entLo = 0;
    let entHi = 0;
    if (entityRef !== undefined && entityRef !== 0n) {
      entLo = Number(entityRef & 0xffffffffn);
      entHi = Number((entityRef >> 32n) & 0xffffffffn);
    }

    // 2. Direct Vyukov MPSC Ticket Reservation Loop (Zero closures, zero object allocations)
    const mask = this.mask;
    let pos = Atomics.load(this.ctrl, MPSC_ENQUEUE_IDX);

    for (;;) {
      const slotIdx = pos & mask;
      const s = Atomics.load(this.seq, slotIdx);
      const dif = s - pos;

      if (dif === 0) {
        const prev = Atomics.compareExchange(this.ctrl, MPSC_ENQUEUE_IDX, pos, pos + 1);
        if (prev === pos) {
          // Slot acquired! Write 32 words (128 bytes) in-place
          const base = slotIdx * this.slotStrideU32;

          // Word 0: [level: u8 | producer: u8 | code: u16]
          this.data[base + HEADER_WORD] =
            (level & 0xff) |
            ((this.producerId & 0xff) << 8) |
            ((code & 0xffff) << 16);

          // Word 1: tick
          this.data[base + TICK_WORD] = tick >>> 0;

          // Words 2..3: timestamp_ns (64-bit)
          this.data[base + TIMESTAMP_LO_WORD] = tsLo;
          this.data[base + TIMESTAMP_HI_WORD] = tsHi;

          // Words 4..5: entity_ref (64-bit)
          this.data[base + ENTITY_REF_LO_WORD] = entLo;
          this.data[base + ENTITY_REF_HI_WORD] = entHi;

          // Inline string offsets & destinations
          const strByteOffset = this.dataByteOffset + (base + INLINE_STR_START_WORD) * 4;
          let strOffset = 0;

          // Words 6..13: args[4] (4 x 64-bit)
          const argsBase = base + ARGS_START_WORD;
          let tagsWord = 0;

          // Pack a0
          if (a0 !== undefined) {
            if (typeof a0 === "string") {
              tagsWord |= TAG_STRING_INLINE;
              const len = a0.length < 64 ? a0.length : 64;
              for (let c = 0; c < len; c++) {
                this.byteView[strByteOffset + c] = a0.charCodeAt(c);
              }
              this.data[argsBase] = len << 16;
              this.data[argsBase + 1] = 0;
              strOffset = len;
              if (strOffset < 64) this.byteView[strByteOffset + strOffset++] = 0;
            } else if (typeof a0 === "number") {
              tagsWord |= TAG_I32;
              this.data[argsBase] = a0 >>> 0;
              this.data[argsBase + 1] = 0;
            } else if (typeof a0 === "bigint") {
              tagsWord |= TAG_I64;
              this.data[argsBase] = Number(a0 & 0xffffffffn);
              this.data[argsBase + 1] = Number((a0 >> 32n) & 0xffffffffn);
            } else {
              tagsWord |= TAG_U32;
              this.data[argsBase] = a0 ? 1 : 0;
              this.data[argsBase + 1] = 0;
            }
          } else {
            this.data[argsBase] = 0;
            this.data[argsBase + 1] = 0;
          }

          // Pack a1
          if (a1 !== undefined) {
            if (typeof a1 === "string") {
              tagsWord |= (TAG_STRING_INLINE << 8);
              const remaining = 64 - strOffset;
              const len = a1.length < remaining ? a1.length : remaining;
              const dest = strByteOffset + strOffset;
              for (let c = 0; c < len; c++) {
                this.byteView[dest + c] = a1.charCodeAt(c);
              }
              this.data[argsBase + 2] = (strOffset & 0xffff) | ((len & 0xffff) << 16);
              this.data[argsBase + 3] = 0;
              strOffset += len;
              if (strOffset < 64) this.byteView[strByteOffset + strOffset++] = 0;
            } else if (typeof a1 === "number") {
              tagsWord |= (TAG_I32 << 8);
              this.data[argsBase + 2] = a1 >>> 0;
              this.data[argsBase + 3] = 0;
            } else if (typeof a1 === "bigint") {
              tagsWord |= (TAG_I64 << 8);
              this.data[argsBase + 2] = Number(a1 & 0xffffffffn);
              this.data[argsBase + 3] = Number((a1 >> 32n) & 0xffffffffn);
            } else {
              tagsWord |= (TAG_U32 << 8);
              this.data[argsBase + 2] = a1 ? 1 : 0;
              this.data[argsBase + 3] = 0;
            }
          } else {
            this.data[argsBase + 2] = 0;
            this.data[argsBase + 3] = 0;
          }

          // Pack a2
          if (a2 !== undefined) {
            if (typeof a2 === "string") {
              tagsWord |= (TAG_STRING_INLINE << 16);
              const remaining = 64 - strOffset;
              const len = a2.length < remaining ? a2.length : remaining;
              const dest = strByteOffset + strOffset;
              for (let c = 0; c < len; c++) {
                this.byteView[dest + c] = a2.charCodeAt(c);
              }
              this.data[argsBase + 4] = (strOffset & 0xffff) | ((len & 0xffff) << 16);
              this.data[argsBase + 5] = 0;
              strOffset += len;
              if (strOffset < 64) this.byteView[strByteOffset + strOffset++] = 0;
            } else if (typeof a2 === "number") {
              tagsWord |= (TAG_I32 << 16);
              this.data[argsBase + 4] = a2 >>> 0;
              this.data[argsBase + 5] = 0;
            } else if (typeof a2 === "bigint") {
              tagsWord |= (TAG_I64 << 16);
              this.data[argsBase + 4] = Number(a2 & 0xffffffffn);
              this.data[argsBase + 5] = Number((a2 >> 32n) & 0xffffffffn);
            } else {
              tagsWord |= (TAG_U32 << 16);
              this.data[argsBase + 4] = a2 ? 1 : 0;
              this.data[argsBase + 5] = 0;
            }
          } else {
            this.data[argsBase + 4] = 0;
            this.data[argsBase + 5] = 0;
          }

          // Pack a3
          if (a3 !== undefined) {
            if (typeof a3 === "string") {
              tagsWord |= (TAG_STRING_INLINE << 24);
              const remaining = 64 - strOffset;
              const len = a3.length < remaining ? a3.length : remaining;
              const dest = strByteOffset + strOffset;
              for (let c = 0; c < len; c++) {
                this.byteView[dest + c] = a3.charCodeAt(c);
              }
              this.data[argsBase + 6] = (strOffset & 0xffff) | ((len & 0xffff) << 16);
              this.data[argsBase + 7] = 0;
              strOffset += len;
              if (strOffset < 64) this.byteView[strByteOffset + strOffset++] = 0;
            } else if (typeof a3 === "number") {
              tagsWord |= (TAG_I32 << 24);
              this.data[argsBase + 6] = a3 >>> 0;
              this.data[argsBase + 7] = 0;
            } else if (typeof a3 === "bigint") {
              tagsWord |= (TAG_I64 << 24);
              this.data[argsBase + 6] = Number(a3 & 0xffffffffn);
              this.data[argsBase + 7] = Number((a3 >> 32n) & 0xffffffffn);
            } else {
              tagsWord |= (TAG_U32 << 24);
              this.data[argsBase + 6] = a3 ? 1 : 0;
              this.data[argsBase + 7] = 0;
            }
          } else {
            this.data[argsBase + 6] = 0;
            this.data[argsBase + 7] = 0;
          }

          if (strOffset === 0) {
            this.byteView[strByteOffset] = 0;
          }

          // Word 30: arg_tags
          this.data[base + ARG_TAGS_WORD] = tagsWord >>> 0;

          // Word 31: flags (u16) | version (u16)
          this.data[base + FLAGS_VERSION_WORD] = 1;

          // Commit slot sequence to notify readers
          Atomics.store(this.seq, slotIdx, pos + 1);
          return true;
        }
        pos = prev;
      } else if (dif < 0) {
        // Bounded ring full: increment drop counter and drop record
        Atomics.add(this.ctrl, MPSC_DROPPED_IDX, 1);
        return false;
      } else {
        pos = Atomics.load(this.ctrl, MPSC_ENQUEUE_IDX);
      }
    }
  }
}
