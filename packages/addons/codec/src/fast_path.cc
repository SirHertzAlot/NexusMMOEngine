#include "fast_path.h"
#include <cmath>
#include <cstring>
#include <sstream>
#include <iomanip>

namespace mmo_codec {

static inline bool isAllFinite(const FastPathRecord& r) {
  return std::isfinite(r.px) && std::isfinite(r.py) && std::isfinite(r.pz) &&
         std::isfinite(r.lx) && std::isfinite(r.ly) && std::isfinite(r.lz);
}

bool EncodeFastDeltaCore(uint32_t tick, const FastPathRecord* records, size_t count, uint8_t* outBuf, size_t outLen, std::string& err) {
  if (count > U32_MAX_VAL) {
    err = "too many entries";
    return false;
  }
  const size_t expectedBytes = FAST_PATH_HEADER_BYTES + count * FAST_PATH_RECORD_BYTES;
  if (outLen < expectedBytes) {
    err = "output buffer too small";
    return false;
  }

  FastPathHeader header;
  header.magic = FAST_PATH_MAGIC;
  header.version = FAST_PATH_VERSION;
  header.reserved = 0;
  header.tick = tick;
  header.count = static_cast<uint32_t>(count);

  std::memcpy(outBuf, &header, sizeof(FastPathHeader));

  if (count > 0 && records != nullptr) {
    std::memcpy(outBuf + FAST_PATH_HEADER_BYTES, records, count * sizeof(FastPathRecord));
  }

  return true;
}

DecodeResult DecodeFastDeltaCore(const uint8_t* bytes, size_t length) {
  DecodeResult res;

  if (length < FAST_PATH_HEADER_BYTES) {
    std::ostringstream ss;
    ss << "short buffer (" << length << " < " << FAST_PATH_HEADER_BYTES << " header bytes)";
    res.reason = ss.str();
    res.ok = false;
    return res;
  }

  FastPathHeader header;
  std::memcpy(&header, bytes, sizeof(FastPathHeader));

  if (header.magic != FAST_PATH_MAGIC) {
    std::ostringstream ss;
    ss << "bad magic 0x" << std::hex << static_cast<int>(header.magic)
       << " (expected 0x" << std::hex << static_cast<int>(FAST_PATH_MAGIC) << ")";
    res.reason = ss.str();
    res.ok = false;
    return res;
  }

  if (header.version != FAST_PATH_VERSION) {
    std::ostringstream ss;
    ss << "unsupported version " << static_cast<int>(header.version)
       << " (this codec understands " << static_cast<int>(FAST_PATH_VERSION) << ")";
    res.reason = ss.str();
    res.ok = false;
    return res;
  }

  if (header.reserved != 0) {
    std::ostringstream ss;
    ss << "nonzero reserved field (0x" << std::hex << header.reserved << ")";
    res.reason = ss.str();
    res.ok = false;
    return res;
  }

  const uint32_t count = header.count;
  const uint64_t expectedLen = static_cast<uint64_t>(FAST_PATH_HEADER_BYTES) +
                              static_cast<uint64_t>(count) * static_cast<uint64_t>(FAST_PATH_RECORD_BYTES);

  if (length != expectedLen) {
    std::ostringstream ss;
    ss << "length mismatch: header says " << count << " records (" << expectedLen
       << " bytes), buffer holds " << length;
    res.reason = ss.str();
    res.ok = false;
    return res;
  }

  res.tick = header.tick;
  res.entries.resize(count);

  if (count > 0) {
    const uint8_t* recordData = bytes + FAST_PATH_HEADER_BYTES;
    std::memcpy(res.entries.data(), recordData, count * sizeof(FastPathRecord));

    for (size_t i = 0; i < count; ++i) {
      if (!isAllFinite(res.entries[i])) {
        std::ostringstream ss;
        ss << "non-finite coordinate in record " << i;
        res.reason = ss.str();
        res.ok = false;
        res.entries.clear();
        return res;
      }
    }
  }

  res.ok = true;
  return res;
}

} // namespace mmo_codec
