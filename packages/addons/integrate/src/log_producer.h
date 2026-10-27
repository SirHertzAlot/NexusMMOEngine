// SAB Logging Layer — Native C++ Producer (docs/SAB-LOGGING-LAYER-SPEC.md §4 Phase 2)
//
// Header-only record producer that writes the exact 128-byte binary layout
// TypeScript writes (packages/logging/src/logging/producer.ts) into the same
// Vyukov bounded MPSC ring (packages/logging/src/lockless-ring.ts), directly
// on the ring's SharedArrayBuffer memory. No N-API boundary is ever crossed
// per record: the ring pointer is acquired once via logAttachRing and kept as
// a raw base address.
//
// Mirrored constants (must stay in sync with lockless-ring.ts / producer.ts):
//   MPSC_HEADER_BYTES = 192  (enqueue/dequeue/dropped/level-masks control words)
//   records  = 32 x u32 (128 bytes)
//   layout   = header|tick|ts_lo|ts_hi|ent_lo|ent_hi|args[4 x u64]|str[64B]|tags|flags+version

#pragma once

#include <cstdint>
#include <cstddef>
#include <cstring>
#include <chrono>

#if defined(_WIN32)
#include <intrin.h>
#define MMO_LOG_CAS(dst, cmp, val) _InterlockedCompareExchange(reinterpret_cast<volatile long*>(dst), (long)(val), (long)(cmp))
#define MMO_LOG_ADD(dst, val) _InterlockedExchangeAdd(reinterpret_cast<volatile long*>(dst), (long)(val))
#else
#define MMO_LOG_CAS(dst, cmp, val) __sync_val_compare_and_swap(dst, cmp, val)
#define MMO_LOG_ADD(dst, val) __sync_fetch_and_add(dst, val)
#endif

#include "log_codes.h"

namespace mmo::logging {

// Producer control-word indices (lockless-ring.ts MPSC_*_IDX)
constexpr uint32_t MPSC_ENQUEUE_IDX = 0;
constexpr uint32_t MPSC_DEQUEUE_IDX = 16;
constexpr uint32_t MPSC_DROPPED_IDX = 32;
constexpr uint32_t MPSC_LEVEL_MASKS_IDX = 36; // 8 words, one per producer

// Record word layout (log-record.ts RECORD_LAYOUT)
constexpr uint32_t WORD_HEADER = 0;       // [level: u8 | producer: u8 | code: u16]
constexpr uint32_t WORD_TICK = 1;
constexpr uint32_t WORD_TS_LO = 2;
constexpr uint32_t WORD_TS_HI = 3;
constexpr uint32_t WORD_ENT_LO = 4;
constexpr uint32_t WORD_ENT_HI = 5;
constexpr uint32_t WORD_ARGS_START = 6;   // words 6..13 = 4 x u64
constexpr uint32_t WORD_STR_START = 14;   // words 14..29 = 64 inline-string bytes
constexpr uint32_t WORD_ARG_TAGS = 30;
constexpr uint32_t WORD_FLAGS_VERSION = 31;
constexpr uint32_t RECORD_WORDS = 32;

// Argument type tags (log-record.ts ARG_TAGS)
constexpr uint32_t TAG_EMPTY = 0;
constexpr uint32_t TAG_I32 = 1;
constexpr uint32_t TAG_U32 = 2;
constexpr uint32_t TAG_F32 = 3;
constexpr uint32_t TAG_I64 = 4;
constexpr uint32_t TAG_U64 = 5;
constexpr uint32_t TAG_F64 = 6;
constexpr uint32_t TAG_STRING_INTERNED = 7;
constexpr uint32_t TAG_STRING_INLINE = 8;

constexpr uint32_t FLAG_VERSION_WORD_VALUE = 1; // flags = 0, version = 1

// Argument slots for one record: tag + lo/hi payload words.
struct NativeLogArg {
  uint32_t tag = TAG_EMPTY;
  uint32_t lo = 0;
  uint32_t hi = 0;
};

/**
 * One process-wide SAB logging ring attachment.
 * attach() is called once per worker boot; emit paths then run entirely in C++.
 */
class NativeLogProducer {
 public:
  bool attach(void* base, size_t byteLength, uint32_t capacity) {
    if (base == nullptr || capacity < 2 || (capacity & (capacity - 1)) != 0) {
      return false;
    }
    const size_t required = 192u + size_t(capacity) * 4u + size_t(capacity) * RECORD_WORDS * 4u;
    if (byteLength < required) {
      return false;
    }
    base_ = reinterpret_cast<uint32_t*>(base);
    capacity_ = capacity;
    mask_ = capacity - 1;
    stepTick_ = 0;
    telemetryEvery_ = 0; // disabled until explicitly enabled
    emitCount_ = 0;
    cachedNowNs_ = 0;
    sampleClock();
    return true;
  }

  bool attached() const { return base_ != nullptr; }

  uint32_t capacity() const { return capacity_; }

  void setTelemetryEvery(uint32_t every) { telemetryEvery_ = every; }

  uint32_t telemetryEvery() const { return telemetryEvery_; }

  /**
   * Per-record emission with fixed positional arguments (AGENTS.md §6: no
   * arrays, no closures, no per-object N-API traversal). Returns false when
   * the ring rejected the record (full) or the mask filtered it.
   */
  bool emit(uint8_t level, uint8_t producerId, uint16_t code, uint32_t tick,
            uint32_t entLo, uint32_t entHi,
            const NativeLogArg& a0, const NativeLogArg& a1,
            const NativeLogArg& a2, const NativeLogArg& a3) {
    if (base_ == nullptr) return false;

    // Level mask filter (ERROR never masked), mirroring LogProducerClient.emit.
    const int32_t minLevel = loadVolatile(&base_[MPSC_LEVEL_MASKS_IDX + producerId]);
    if (level < minLevel && level < static_cast<uint8_t>(LogLevel::Error)) {
      return false;
    }

    // Amortized monotonic wall clock: one clock syscall every 16 records.
    if ((emitCount_++ & 15u) == 0u) {
      sampleClock();
    }
    const uint32_t tsLo = static_cast<uint32_t>(cachedNowNs_ & 0xffffffffu);
    const uint32_t tsHi = static_cast<uint32_t>((cachedNowNs_ >> 32) & 0xffffffffu);

    // Vyukov bounded MPSC ticket reservation (identical to the TS producer).
    uint32_t pos = loadVolatile(&base_[MPSC_ENQUEUE_IDX]);
    for (;;) {
      uint32_t slotIdx = pos & mask_;
      int32_t seq = loadVolatile(slotSeq(slotIdx));
      int32_t dif = int32_t(uint32_t(seq)) - int32_t(pos);

      if (dif == 0) {
        uint32_t prev = CAS(&base_[MPSC_ENQUEUE_IDX], pos, pos + 1);
        if (prev == pos) {
          uint32_t* slot = slotBase(slotIdx);
          writeRecord(slot, level, producerId, code, tick, entLo, entHi,
                      tsLo, tsHi, a0, a1, a2, a3);
          storeVolatile(slotSeq(slotIdx), pos + 1);
          return true;
        }
        pos = prev;
      } else if (dif < 0) {
        ADD(&base_[MPSC_DROPPED_IDX], 1);
        return false;
      } else {
        pos = loadVolatile(&base_[MPSC_ENQUEUE_IDX]);
      }
    }
  }

  /**
   * Sampled in-kernel telemetry: every `telemetryEvery` accepted step the
   * kernel emits one SIM_KERNEL_TELEMETRY record. Zero cost (single branch)
   * when disabled or not attached.
   */
  inline void maybeKernelTelemetry(uint32_t entityCount, float dtF32) {
    if (telemetryEvery_ == 0u) return;
    const uint32_t step = ++stepTick_;
    if ((step % telemetryEvery_) != 0u) return;
    NativeLogArg entities;
    entities.tag = TAG_U32;
    entities.lo = entityCount;
    NativeLogArg dt;
    dt.tag = TAG_F32;
    std::memcpy(&dt.lo, &dtF32, sizeof(uint32_t));
    NativeLogArg stepArg;
    stepArg.tag = TAG_U32;
    stepArg.lo = step;
    emit(static_cast<uint8_t>(LogLevel::Debug),
         static_cast<uint8_t>(LogProducer::Sim), codes::SIM_KERNEL_TELEMETRY,
         step, 0u, 0u, entities, dt, stepArg, empty_);
  }

 private:
  static uint32_t* slotBase(uint32_t slotIdx) {
    return base_ + 192u / 4u + size_t(capacity_) + size_t(slotIdx) * RECORD_WORDS;
  }
  static volatile int32_t* slotSeq(uint32_t slotIdx) {
    return reinterpret_cast<volatile int32_t*>(base_ + 192u / 4u + slotIdx);
  }
  static uint32_t loadVolatile(const volatile uint32_t* p) { return *p; }
  static int32_t loadVolatile(volatile int32_t* p) { return *p; }
  static void storeVolatile(volatile int32_t* p, int32_t v) { *p = v; }
  static uint32_t CAS(volatile uint32_t* p, uint32_t cmp, uint32_t val) {
    return static_cast<uint32_t>(MMO_LOG_CAS(p, cmp, val));
  }
  static void ADD(volatile uint32_t* p, uint32_t v) { MMO_LOG_ADD(p, v); }

  static void sampleClock() {
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    cachedNowNs_ = std::chrono::nanoseconds(now).count();
  }

  static void writeRecord(uint32_t* slot, uint8_t level, uint8_t producerId, uint16_t code,
                          uint32_t tick, uint32_t entLo, uint32_t entHi,
                          uint32_t tsLo, uint32_t tsHi,
                          const NativeLogArg& a0, const NativeLogArg& a1,
                          const NativeLogArg& a2, const NativeLogArg& a3) {
    slot[WORD_HEADER] = uint32_t(level) | (uint32_t(producerId) << 8) | (uint32_t(code) << 16);
    slot[WORD_TICK] = tick;
    slot[WORD_TS_LO] = tsLo;
    slot[WORD_TS_HI] = tsHi;
    slot[WORD_ENT_LO] = entLo;
    slot[WORD_ENT_HI] = entHi;

    const NativeLogArg* args[4] = { &a0, &a1, &a2, &a3 };
    uint32_t tagsWord = 0;
    for (uint32_t i = 0; i < 4; i++) {
      const uint32_t argsBase = WORD_ARGS_START + i * 2;
      const NativeLogArg& a = *args[i];
      slot[argsBase] = a.lo;
      slot[argsBase + 1] = a.hi;
      tagsWord |= (a.tag & 0xffu) << (i * 8);
    }
    slot[WORD_ARG_TAGS] = tagsWord;
    slot[WORD_FLAGS_VERSION] = FLAG_VERSION_WORD_VALUE;

    std::memset(slot + WORD_STR_START, 0, 64);
  }

  static uint32_t* base_;
  static uint32_t capacity_;
  static uint32_t mask_;
  static uint32_t telemetryEvery_;
  static uint32_t stepTick_;
  static uint32_t emitCount_;
  static int64_t cachedNowNs_;
  static const NativeLogArg empty_;
};

} // namespace mmo::logging
