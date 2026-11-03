// Native fan-out. One Fanout object per Gateway (its name table and per-session sets are its own).
// Two calls per tick replace the per-session JavaScript:
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
#include <unordered_map>
#include <vector>

namespace {

constexpr uint8_t kDeltaSetType = 0x25;

inline uint64_t Mix64(uint64_t k) {
  k ^= k >> 33;
  k *= 0xff51afd7ed558ccdULL;
  k ^= k >> 33;
  k *= 0xc4ceb9fe1a85ec53ULL;
  k ^= k >> 33;
  return k;
}


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


struct Payload {
  const uint8_t* p;
  uint32_t n;
};

class Fanout : public Napi::ObjectWrap<Fanout> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Fanout",
                       {InstanceMethod("setName", &Fanout::SetName), InstanceMethod("assemble", &Fanout::Assemble),
                        InstanceMethod("selectNames", &Fanout::SelectNames), InstanceMethod("takeWanted", &Fanout::TakeWanted),
                        InstanceMethod("release", &Fanout::Release), InstanceMethod("stats", &Fanout::Stats)});
  }
  explicit Fanout(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Fanout>(info) {}

 private:
  std::vector<std::string> names_;  // sector name index -> utf8 bytes
  std::vector<uint64_t> want_;      // ids selectNames chose this tick, session by session
  struct Session {
    IdSet sent;                         // wire ids already named
    std::vector<uint64_t> sectorSeen;   // sector index -> hash of the id list last fully scanned (0 = never)
  };
  std::vector<Session> sent_;           // session slot -> state
  std::vector<uint64_t> sectorHash_;    // this tick: sector index -> order-independent hash of its id list
  std::vector<uint64_t> prevHash_;      // last call's sectorHash_
  std::unordered_map<uint64_t, int32_t> prevSector_;  // last call: id -> sector index
  std::vector<uint64_t> added_;         // this call: ids new to their sector, grouped by sector
  std::vector<int32_t> addedStart_, addedLen_;
  uint64_t statRefs_ = 0, statSkipped_ = 0, statScannedIds_ = 0, statCalls_ = 0;

Napi::Value SetName(const Napi::CallbackInfo& info) {
  uint32_t idx = info[0].As<Napi::Number>().Uint32Value();
  auto buf = info[1].As<Napi::TypedArrayOf<uint8_t>>();
  if (names_.size() <= idx) names_.resize(idx + 1);
  names_[idx].assign(reinterpret_cast<const char*>(buf.Data()), buf.ByteLength());
  return info.Env().Undefined();
}

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
    for (int32_t k = 0; k < count; k++) size += 6 + names_[e[k * 3 + 1]].size() + payloads[e[k * 3 + 2]].n;
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
        const std::string& nm = names_[e[k * 3 + 1]];
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
  want_.clear();
  statCalls_++;
  // One pass over this tick's ids: an order-independent hash per sector (sum and xor of mixed ids, plus the
  // count). A session that last scanned a sector at the same hash has every id of it in its sent set already.
  size_t nSectors = secStart.ElementLength();
  if (sectorHash_.size() < nSectors) sectorHash_.resize(nSectors);
  for (size_t sec = 0; sec < nSectors; sec++) {
    uint64_t sum = 0, x = 0;
    const uint64_t* p = idv + ss[sec];
    for (int32_t k = 0; k < sl[sec]; k++) {
      uint64_t m = Mix64(p[k]);
      sum += m;
      x ^= (m << 17) | (m >> 47);
    }
    uint64_t h = Mix64(sum ^ Mix64(x) ^ (static_cast<uint64_t>(sl[sec]) << 40));
    sectorHash_[sec] = h == 0 ? 1 : h;
  }
  // Ids that were not in the same sector last call. A session that was current for a sector last call
  // (its seen hash equals last call's) only has to look at these.
  if (prevHash_.size() < nSectors) prevHash_.resize(nSectors, 0);
  addedStart_.assign(nSectors, 0);
  addedLen_.assign(nSectors, 0);
  added_.clear();
  for (size_t sec = 0; sec < nSectors; sec++) {
    addedStart_[sec] = static_cast<int32_t>(added_.size());
    const uint64_t* p = idv + ss[sec];
    for (int32_t k = 0; k < sl[sec]; k++) {
      auto it = prevSector_.find(p[k]);
      if (it == prevSector_.end() || it->second != static_cast<int32_t>(sec)) added_.push_back(p[k]);
    }
    addedLen_[sec] = static_cast<int32_t>(added_.size()) - addedStart_[sec];
  }
  prevSector_.clear();
  for (size_t sec = 0; sec < nSectors; sec++) {
    const uint64_t* p = idv + ss[sec];
    for (int32_t k = 0; k < sl[sec]; k++) prevSector_[p[k]] = static_cast<int32_t>(sec);
  }
  int32_t sessions = 0;
  int32_t i = 0;
  while (i < descLen) {
    int32_t slot = d[i], hasPlayer = d[i + 1], nSec = d[i + 2], nPin = d[i + 3];
    if (static_cast<size_t>(slot) >= sent_.size()) sent_.resize(slot + 1);
    Session& sess = sent_[slot];
    IdSet& sent = sess.sent;
    if (sess.sectorSeen.size() < nSectors) sess.sectorSeen.resize(nSectors, 0);
    size_t before = want_.size();
    if (hasPlayer) {
      uint64_t id = *pv++;
      if (sent.insert(id)) want_.push_back(id);
    }
    for (int32_t s = 0; s < nSec; s++) {
      int32_t sec = d[i + 4 + s];
      statRefs_++;
      uint64_t seen = sess.sectorSeen[sec];
      if (seen == sectorHash_[sec]) { statSkipped_++; continue; }
      sess.sectorSeen[sec] = sectorHash_[sec];
      const uint64_t* p;
      int32_t n;
      if (seen != 0 && seen == prevHash_[sec]) {  // current as of last call: only the new ids
        p = added_.data() + addedStart_[sec];
        n = addedLen_[sec];
      } else {
        p = idv + ss[sec];
        n = sl[sec];
      }
      statScannedIds_ += n;
      for (int32_t k = 0; k < n; k++)
        if (sent.insert(p[k])) want_.push_back(p[k]);
    }
    for (int32_t k = 0; k < nPin; k++) {
      uint64_t id = *pv++;
      if (sent.insert(id)) want_.push_back(id);
    }
    wantCount[sessions] = static_cast<int32_t>(want_.size() - before);
    sessions++;
    i += 4 + nSec;
  }
  prevHash_.assign(sectorHash_.begin(), sectorHash_.begin() + nSectors);
  return Napi::Number::New(env, static_cast<double>(want_.size()));
}

Napi::Value TakeWanted(const Napi::CallbackInfo& info) {
  auto out = info[0].As<Napi::TypedArrayOf<uint64_t>>();
  size_t n = std::min(out.ElementLength(), want_.size());
  if (n) std::memcpy(out.Data(), want_.data(), n * 8);
  return info.Env().Undefined();
}

Napi::Value Stats(const Napi::CallbackInfo& info) {
  Napi::Object o = Napi::Object::New(info.Env());
  o.Set("calls", static_cast<double>(statCalls_));
  o.Set("sectorRefs", static_cast<double>(statRefs_));
  o.Set("sectorRefsSkipped", static_cast<double>(statSkipped_));
  o.Set("idsScanned", static_cast<double>(statScannedIds_));
  return o;
}

Napi::Value Release(const Napi::CallbackInfo& info) {
  uint32_t slot = info[0].As<Napi::Number>().Uint32Value();
  if (slot < sent_.size()) {
    sent_[slot].sent.clear();
    std::fill(sent_[slot].sectorSeen.begin(), sent_[slot].sectorSeen.end(), 0);
  }
  return info.Env().Undefined();
}
};

Napi::Value Version(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), "0.1.0"); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("Fanout", Fanout::Init(env));
  exports.Set("version", Napi::Function::New(env, Version));
  return exports;
}

}  // namespace

NODE_API_MODULE(fanout, Init)
