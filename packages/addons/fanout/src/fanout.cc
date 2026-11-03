// Native fan-out. Two calls per tick replace the per-session JavaScript:
//
//   assemble(...)     writes every session's DeltaSet envelope (type 0x25) into one
//                     caller-owned arena, byte-identical to encodeEnvelope(DeltaSet,
//                     encodeDeltaSet(...)) in packages/protocol.
//   selectNames(...)  picks, per session, the wire ids it has not been told the name of
//                     yet, from native per-session sets (replaces the BigInt Set in
//                     Gateway.deliverNamesFor); takeWanted copies the chosen ids out.
//
// All buffers are owned by JavaScript (typed arrays); the addon holds only the name table
// and the per-session sent sets.
#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr uint8_t kDeltaSetType = 0x25;

std::vector<std::string> g_names;  // sector name index -> utf8 bytes

// Open-addressing set of u64 wire ids. Key 0 is stored out of line (flag) so 0 can be a value.
class IdSet {
 public:
  bool insert(uint64_t k) {  // true when newly added
    if (k == 0) {
      if (has_zero_) return false;
      has_zero_ = true;
      return true;
    }
    if ((count_ + 1) * 10 > slots_.size() * 7) grow();
    return put(k);
  }
  void clear() {
    std::fill(slots_.begin(), slots_.end(), 0);
    count_ = 0;
    has_zero_ = false;
  }

 private:
  static size_t mix(uint64_t k) {
    k ^= k >> 33;
    k *= 0xff51afd7ed558ccdULL;
    k ^= k >> 33;
    return static_cast<size_t>(k);
  }
  bool put(uint64_t k) {
    size_t mask = slots_.size() - 1;
    size_t i = mix(k) & mask;
    while (slots_[i] != 0) {
      if (slots_[i] == k) return false;
      i = (i + 1) & mask;
    }
    slots_[i] = k;
    count_++;
    return true;
  }
  void grow() {
    std::vector<uint64_t> old;
    old.swap(slots_);
    slots_.assign(old.empty() ? 64 : old.size() * 2, 0);
    count_ = 0;
    for (uint64_t k : old)
      if (k != 0) put(k);
  }
  std::vector<uint64_t> slots_;
  size_t count_ = 0;
  bool has_zero_ = false;
};

std::vector<uint64_t> g_want;  // ids selectNames chose this tick, session by session
std::vector<IdSet> g_sent;  // session slot -> ids already named

Napi::Value SetName(const Napi::CallbackInfo& info) {
  uint32_t idx = info[0].As<Napi::Number>().Uint32Value();
  auto buf = info[1].As<Napi::TypedArrayOf<uint8_t>>();
  if (g_names.size() <= idx) g_names.resize(idx + 1);
  g_names[idx].assign(reinterpret_cast<const char*>(buf.Data()), buf.ByteLength());
  return info.Env().Undefined();
}

struct Payload {
  const uint8_t* p;
  uint32_t n;
};

// assemble(tick, arena, out, desc, descLen, payloads) -> sessions written, or -bytesNeeded
// desc, per session: count, replace, then count x (kind, nameIdx, payloadIdx).
// out gets (offset, length) per session.
Napi::Value Assemble(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t tick = info[0].As<Napi::Number>().Uint32Value();
  auto arena = info[1].As<Napi::TypedArrayOf<uint8_t>>();
  auto out = info[2].As<Napi::TypedArrayOf<int32_t>>();
  auto desc = info[3].As<Napi::TypedArrayOf<int32_t>>();
  int32_t descLen = info[4].As<Napi::Number>().Int32Value();
  auto payloadArr = info[5].As<Napi::Array>();

  uint32_t np = payloadArr.Length();
  std::vector<Payload> payloads(np);
  for (uint32_t i = 0; i < np; i++) {
    Napi::Value v = payloadArr.Get(i);
    auto u = v.As<Napi::TypedArrayOf<uint8_t>>();
    payloads[i] = {u.Data(), static_cast<uint32_t>(u.ByteLength())};
  }

  const int32_t* d = desc.Data();
  uint8_t* base = arena.Data();
  size_t cap = arena.ByteLength();
  size_t pos = 0;
  int32_t sessions = 0;
  int32_t i = 0;
  while (i < descLen) {
    int32_t count = d[i], replace = d[i + 1];
    const int32_t* e = d + i + 2;
    size_t size = 1 + 7;
    for (int32_t k = 0; k < count; k++) size += 6 + g_names[e[k * 3 + 1]].size() + payloads[e[k * 3 + 2]].n;
    if (pos + size <= cap) {
      uint8_t* o = base + pos;
      *o++ = kDeltaSetType;
      std::memcpy(o, &tick, 4);  // little endian hosts only (x64, arm64)
      o += 4;
      *o++ = replace ? 1 : 0;
      uint16_t c16 = static_cast<uint16_t>(count);
      std::memcpy(o, &c16, 2);
      o += 2;
      for (int32_t k = 0; k < count; k++) {
        const std::string& nm = g_names[e[k * 3 + 1]];
        const Payload& pl = payloads[e[k * 3 + 2]];
        *o++ = static_cast<uint8_t>(e[k * 3]);
        *o++ = static_cast<uint8_t>(nm.size());
        std::memcpy(o, nm.data(), nm.size());
        o += nm.size();
        std::memcpy(o, &pl.n, 4);
        o += 4;
        if (pl.n) std::memcpy(o, pl.p, pl.n);
        o += pl.n;
      }
      out[sessions * 2] = static_cast<int32_t>(pos);
      out[sessions * 2 + 1] = static_cast<int32_t>(size);
    }
    pos += size;
    sessions++;
    i += 2 + count * 3;
  }
  if (pos > cap) return Napi::Number::New(env, -static_cast<double>(pos));
  return Napi::Number::New(env, sessions);
}

// selectNames(sectorStart, sectorLen, ids, desc, descLen, pids, wantCount) -> total ids chosen
//   sectorStart/Len (Int32Array) and ids (BigUint64Array): this tick's named entities by sector index.
//   desc (Int32Array), per session: slot, hasPlayer, nSectors, nPinned, then nSectors sector indices.
//   pids (BigUint64Array), per session: the player id when hasPlayer, then nPinned ids.
//   wantCount (Int32Array) gets the count chosen per session; takeWanted(out) copies the ids out.
Napi::Value SelectNames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto secStart = info[0].As<Napi::TypedArrayOf<int32_t>>();
  auto secLen = info[1].As<Napi::TypedArrayOf<int32_t>>();
  auto ids = info[2].As<Napi::TypedArrayOf<uint64_t>>();
  auto desc = info[3].As<Napi::TypedArrayOf<int32_t>>();
  int32_t descLen = info[4].As<Napi::Number>().Int32Value();
  auto pids = info[5].As<Napi::TypedArrayOf<uint64_t>>();
  auto wantCount = info[6].As<Napi::TypedArrayOf<int32_t>>();

  const int32_t* d = desc.Data();
  const int32_t* ss = secStart.Data();
  const int32_t* sl = secLen.Data();
  const uint64_t* idv = ids.Data();
  const uint64_t* pv = pids.Data();
  g_want.clear();
  int32_t sessions = 0;
  int32_t i = 0;
  while (i < descLen) {
    int32_t slot = d[i], hasPlayer = d[i + 1], nSec = d[i + 2], nPin = d[i + 3];
    if (static_cast<size_t>(slot) >= g_sent.size()) g_sent.resize(slot + 1);
    IdSet& sent = g_sent[slot];
    size_t before = g_want.size();
    if (hasPlayer) {
      uint64_t id = *pv++;
      if (sent.insert(id)) g_want.push_back(id);
    }
    for (int32_t s = 0; s < nSec; s++) {
      int32_t sec = d[i + 4 + s];
      const uint64_t* p = idv + ss[sec];
      for (int32_t k = 0; k < sl[sec]; k++)
        if (sent.insert(p[k])) g_want.push_back(p[k]);
    }
    for (int32_t k = 0; k < nPin; k++) {
      uint64_t id = *pv++;
      if (sent.insert(id)) g_want.push_back(id);
    }
    wantCount[sessions] = static_cast<int32_t>(g_want.size() - before);
    sessions++;
    i += 4 + nSec;
  }
  return Napi::Number::New(env, static_cast<double>(g_want.size()));
}

Napi::Value TakeWanted(const Napi::CallbackInfo& info) {
  auto out = info[0].As<Napi::TypedArrayOf<uint64_t>>();
  size_t n = std::min(out.ElementLength(), g_want.size());
  if (n) std::memcpy(out.Data(), g_want.data(), n * 8);
  return info.Env().Undefined();
}

Napi::Value Release(const Napi::CallbackInfo& info) {
  uint32_t slot = info[0].As<Napi::Number>().Uint32Value();
  if (slot < g_sent.size()) g_sent[slot].clear();
  return info.Env().Undefined();
}

Napi::Value Version(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), "0.1.0"); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setName", Napi::Function::New(env, SetName));
  exports.Set("assemble", Napi::Function::New(env, Assemble));
  exports.Set("selectNames", Napi::Function::New(env, SelectNames));
  exports.Set("takeWanted", Napi::Function::New(env, TakeWanted));
  exports.Set("release", Napi::Function::New(env, Release));
  exports.Set("version", Napi::Function::New(env, Version));
  return exports;
}

}  // namespace

NODE_API_MODULE(fanout, Init)
