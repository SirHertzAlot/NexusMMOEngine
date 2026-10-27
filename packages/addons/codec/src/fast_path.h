#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace mmo_codec {

constexpr uint8_t  FAST_PATH_MAGIC        = 0x46; // 'F'
constexpr uint8_t  FAST_PATH_VERSION      = 1;
constexpr size_t   FAST_PATH_HEADER_BYTES = 12;
constexpr size_t   FAST_PATH_RECORD_BYTES = 32;
constexpr uint32_t U32_MAX_VAL            = 0xffffffff;

#pragma pack(push, 1)
struct FastPathHeader {
  uint8_t  magic;     // 0x46 ('F')
  uint8_t  version;   // 1
  uint16_t reserved;  // 0 (must be zero on decode)
  uint32_t tick;      // little-endian u32
  uint32_t count;     // little-endian u32
};
static_assert(sizeof(FastPathHeader) == FAST_PATH_HEADER_BYTES, "FastPathHeader must be 12 bytes");

struct FastPathRecord {
  uint64_t wireId;    // little-endian u64
  float    px;        // little-endian f32
  float    py;
  float    pz;
  float    lx;
  float    ly;
  float    lz;
};
static_assert(sizeof(FastPathRecord) == FAST_PATH_RECORD_BYTES, "FastPathRecord must be 32 bytes");
#pragma pack(pop)

// Validation and decode result
struct DecodeResult {
  bool ok = false;
  uint32_t tick = 0;
  std::vector<FastPathRecord> entries;
  std::string reason;
};

// Pure C++ encoding of records into v1 frozen layout
bool EncodeFastDeltaCore(uint32_t tick, const FastPathRecord* records, size_t count, uint8_t* outBuf, size_t outLen, std::string& err);

// Pure C++ strict validation & decoding of bytes
DecodeResult DecodeFastDeltaCore(const uint8_t* bytes, size_t length);

} // namespace mmo_codec
