#include <napi.h>
#include "fast_path.h"
#include <unordered_set>
#include <vector>

namespace mmo_codec {

// Helper to throw FastPathError
void ThrowFastPathError(Napi::Env env, const std::string& message) {
  Napi::Error err = Napi::Error::New(env, "fast-path: " + message);
  err.Set("name", Napi::String::New(env, "FastPathError"));
  err.ThrowAsJavaScriptException();
}

void ThrowRangeError(Napi::Env env, const std::string& message) {
  Napi::RangeError err = Napi::RangeError::New(env, "fast-path: " + message);
  err.ThrowAsJavaScriptException();
}

static inline bool CheckTick(Napi::Env env, const Napi::Value& val, uint32_t& outTick) {
  if (!val.IsNumber()) {
    ThrowRangeError(env, "tick must be a u32 integer (got non-number)");
    return false;
  }
  double d = val.As<Napi::Number>().DoubleValue();
  if (d < 0.0 || d > static_cast<double>(U32_MAX_VAL) || std::floor(d) != d) {
    std::string s = val.ToString().Utf8Value();
    ThrowRangeError(env, "tick must be a u32 integer (got " + s + ")");
    return false;
  }
  outTick = static_cast<uint32_t>(d);
  return true;
}

// ---------------------------------------------------------------------------
// encodeFastDelta(tick, entries) -> Uint8Array
// ---------------------------------------------------------------------------
Napi::Value EncodeFastDelta(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    ThrowFastPathError(env, "encodeFastDelta requires (tick, entries)");
    return env.Null();
  }

  uint32_t tick = 0;
  if (!CheckTick(env, info[0], tick)) {
    return env.Null();
  }

  if (!info[1].IsArray()) {
    ThrowFastPathError(env, "entries must be an array");
    return env.Null();
  }

  Napi::Array entriesArr = info[1].As<Napi::Array>();
  uint32_t count = entriesArr.Length();

  std::vector<FastPathRecord> records(count);
  for (uint32_t i = 0; i < count; ++i) {
    Napi::Value item = entriesArr.Get(i);
    if (!item.IsObject()) {
      ThrowFastPathError(env, "entry must be an object");
      return env.Null();
    }
    Napi::Object obj = item.As<Napi::Object>();

    // wireId
    Napi::Value wireIdVal = obj.Get("wireId");
    uint64_t wireId = 0;
    if (wireIdVal.IsBigInt()) {
      bool lossless = false;
      wireId = wireIdVal.As<Napi::BigInt>().Uint64Value(&lossless);
    } else if (wireIdVal.IsNumber()) {
      wireId = static_cast<uint64_t>(wireIdVal.As<Napi::Number>().Int64Value());
    }

    records[i].wireId = wireId;
    records[i].px = static_cast<float>(obj.Get("px").As<Napi::Number>().FloatValue());
    records[i].py = static_cast<float>(obj.Get("py").As<Napi::Number>().FloatValue());
    records[i].pz = static_cast<float>(obj.Get("pz").As<Napi::Number>().FloatValue());
    records[i].lx = static_cast<float>(obj.Get("lx").As<Napi::Number>().FloatValue());
    records[i].ly = static_cast<float>(obj.Get("ly").As<Napi::Number>().FloatValue());
    records[i].lz = static_cast<float>(obj.Get("lz").As<Napi::Number>().FloatValue());
  }

  size_t totalBytes = FAST_PATH_HEADER_BYTES + count * FAST_PATH_RECORD_BYTES;
  Napi::Uint8Array outArr = Napi::Uint8Array::New(env, totalBytes);

  std::string err;
  if (!EncodeFastDeltaCore(tick, records.data(), count, outArr.Data(), totalBytes, err)) {
    ThrowFastPathError(env, err);
    return env.Null();
  }

  return outArr;
}

// ---------------------------------------------------------------------------
// decodeFastDelta(bytes) -> { tick, entries }
// ---------------------------------------------------------------------------
Napi::Value DecodeFastDelta(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    ThrowFastPathError(env, "decodeFastDelta requires a Uint8Array argument");
    return env.Null();
  }

  Napi::TypedArray typedArr = info[0].As<Napi::TypedArray>();
  const uint8_t* data = reinterpret_cast<const uint8_t*>(typedArr.ArrayBuffer().Data()) + typedArr.ByteOffset();
  size_t len = typedArr.ByteLength();

  DecodeResult res = DecodeFastDeltaCore(data, len);
  if (!res.ok) {
    ThrowFastPathError(env, res.reason);
    return env.Null();
  }

  Napi::Object resultObj = Napi::Object::New(env);
  resultObj.Set("tick", Napi::Number::New(env, res.tick));

  uint32_t count = static_cast<uint32_t>(res.entries.size());
  Napi::Array entriesArr = Napi::Array::New(env, count);

  for (uint32_t i = 0; i < count; ++i) {
    const FastPathRecord& r = res.entries[i];
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("wireId", Napi::BigInt::New(env, r.wireId));
    entry.Set("px", Napi::Number::New(env, r.px));
    entry.Set("py", Napi::Number::New(env, r.py));
    entry.Set("pz", Napi::Number::New(env, r.pz));
    entry.Set("lx", Napi::Number::New(env, r.lx));
    entry.Set("ly", Napi::Number::New(env, r.ly));
    entry.Set("lz", Napi::Number::New(env, r.lz));
    entriesArr.Set(i, entry);
  }

  resultObj.Set("entries", entriesArr);
  return resultObj;
}

// ---------------------------------------------------------------------------
// tryDecodeFastDelta(bytes) -> { ok: true, tick, entries } | { ok: false, reason }
// ---------------------------------------------------------------------------
Napi::Value TryDecodeFastDelta(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::Object errRes = Napi::Object::New(env);
    errRes.Set("ok", Napi::Boolean::New(env, false));
    errRes.Set("reason", Napi::String::New(env, "fast-path: expected Uint8Array"));
    return errRes;
  }

  Napi::TypedArray typedArr = info[0].As<Napi::TypedArray>();
  const uint8_t* data = reinterpret_cast<const uint8_t*>(typedArr.ArrayBuffer().Data()) + typedArr.ByteOffset();
  size_t len = typedArr.ByteLength();

  DecodeResult res = DecodeFastDeltaCore(data, len);
  Napi::Object resultObj = Napi::Object::New(env);

  if (!res.ok) {
    resultObj.Set("ok", Napi::Boolean::New(env, false));
    resultObj.Set("reason", Napi::String::New(env, "fast-path: " + res.reason));
    return resultObj;
  }

  resultObj.Set("ok", Napi::Boolean::New(env, true));
  resultObj.Set("tick", Napi::Number::New(env, res.tick));

  uint32_t count = static_cast<uint32_t>(res.entries.size());
  Napi::Array entriesArr = Napi::Array::New(env, count);

  for (uint32_t i = 0; i < count; ++i) {
    const FastPathRecord& r = res.entries[i];
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("wireId", Napi::BigInt::New(env, r.wireId));
    entry.Set("px", Napi::Number::New(env, r.px));
    entry.Set("py", Napi::Number::New(env, r.py));
    entry.Set("pz", Napi::Number::New(env, r.pz));
    entry.Set("lx", Napi::Number::New(env, r.lx));
    entry.Set("ly", Napi::Number::New(env, r.ly));
    entry.Set("lz", Napi::Number::New(env, r.lz));
    entriesArr.Set(i, entry);
  }

  resultObj.Set("entries", entriesArr);
  return resultObj;
}

// ---------------------------------------------------------------------------
// encodeFastDeltaFromSoA(tick, transforms, velocities) -> Uint8Array | null
// ---------------------------------------------------------------------------
Napi::Value EncodeFastDeltaFromSoA(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3) {
    ThrowFastPathError(env, "encodeFastDeltaFromSoA requires (tick, transforms, velocities)");
    return env.Null();
  }

  uint32_t tick = 0;
  if (!CheckTick(env, info[0], tick)) {
    return env.Null();
  }

  if (!info[1].IsObject() || !info[2].IsObject()) {
    ThrowFastPathError(env, "transforms and velocities must be objects");
    return env.Null();
  }

  Napi::Object tObj = info[1].As<Napi::Object>();
  Napi::Object vObj = info[2].As<Napi::Object>();

  Napi::Value tEidsVal = tObj.Get("eids");
  Napi::Value vEidsVal = vObj.Get("eids");

  if (!tEidsVal.IsArray() && !tEidsVal.IsTypedArray()) {
    ThrowFastPathError(env, "transforms.eids must be an array or TypedArray");
    return env.Null();
  }
  if (!vEidsVal.IsArray() && !vEidsVal.IsTypedArray()) {
    ThrowFastPathError(env, "velocities.eids must be an array or TypedArray");
    return env.Null();
  }

  // Build slot set for velocity
  std::unordered_set<uint32_t> vSlots;
  if (vEidsVal.IsArray()) {
    Napi::Array arr = vEidsVal.As<Napi::Array>();
    uint32_t len = arr.Length();
    vSlots.reserve(len);
    for (uint32_t i = 0; i < len; ++i) {
      vSlots.insert(arr.Get(i).As<Napi::Number>().Uint32Value());
    }
  } else {
    Napi::TypedArray ta = vEidsVal.As<Napi::TypedArray>();
    uint32_t len = ta.ElementLength();
    vSlots.reserve(len);
    if (ta.TypedArrayType() == napi_uint32_array || ta.TypedArrayType() == napi_int32_array) {
      const uint32_t* ptr = reinterpret_cast<const uint32_t*>(reinterpret_cast<const uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset());
      for (uint32_t i = 0; i < len; ++i) vSlots.insert(ptr[i]);
    } else {
      Napi::Array arr = Napi::Array::New(env, len);
      for (uint32_t i = 0; i < len; ++i) {
        vSlots.insert(ta.Get(i).As<Napi::Number>().Uint32Value());
      }
    }
  }

  Napi::Function wireIdOf = tObj.Get("wireIdOf").As<Napi::Function>();
  Napi::Value pxCol = tObj.Get("px");
  Napi::Value pyCol = tObj.Get("py");
  Napi::Value pzCol = tObj.Get("pz");
  Napi::Value lxCol = vObj.Get("lx");
  Napi::Value lyCol = vObj.Get("ly");
  Napi::Value lzCol = vObj.Get("lz");

  std::vector<FastPathRecord> entries;

  auto getCol = [](const Napi::Value& col, uint32_t idx) -> float {
    if (col.IsTypedArray()) {
      Napi::TypedArray ta = col.As<Napi::TypedArray>();
      if (ta.TypedArrayType() == napi_float64_array) {
        const double* ptr = reinterpret_cast<const double*>(reinterpret_cast<const uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset());
        return static_cast<float>(ptr[idx]);
      } else if (ta.TypedArrayType() == napi_float32_array) {
        const float* ptr = reinterpret_cast<const float*>(reinterpret_cast<const uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset());
        return ptr[idx];
      }
    }
    return col.As<Napi::Object>().Get(idx).As<Napi::Number>().FloatValue();
  };

  uint32_t tLen = tEidsVal.IsArray() ? tEidsVal.As<Napi::Array>().Length() : tEidsVal.As<Napi::TypedArray>().ElementLength();

  for (uint32_t i = 0; i < tLen; ++i) {
    uint32_t eid = tEidsVal.IsArray() ? tEidsVal.As<Napi::Array>().Get(i).As<Napi::Number>().Uint32Value() : tEidsVal.As<Napi::TypedArray>().Get(i).As<Napi::Number>().Uint32Value();
    if (vSlots.find(eid) == vSlots.end()) continue;

    Napi::Value wVal = wireIdOf.Call(tObj, { Napi::Number::New(env, eid) });
    uint64_t wireId = 0;
    if (wVal.IsBigInt()) {
      bool lossless = false;
      wireId = wVal.As<Napi::BigInt>().Uint64Value(&lossless);
    } else if (wVal.IsNumber()) {
      wireId = static_cast<uint64_t>(wVal.As<Napi::Number>().Int64Value());
    }

    FastPathRecord r;
    r.wireId = wireId;
    r.px = getCol(pxCol, eid);
    r.py = getCol(pyCol, eid);
    r.pz = getCol(pzCol, eid);
    r.lx = getCol(lxCol, eid);
    r.ly = getCol(lyCol, eid);
    r.lz = getCol(lzCol, eid);
    entries.push_back(r);
  }

  if (entries.empty()) {
    return env.Null();
  }

  size_t totalBytes = FAST_PATH_HEADER_BYTES + entries.size() * FAST_PATH_RECORD_BYTES;
  Napi::Uint8Array outArr = Napi::Uint8Array::New(env, totalBytes);

  std::string err;
  if (!EncodeFastDeltaCore(tick, entries.data(), entries.size(), outArr.Data(), totalBytes, err)) {
    ThrowFastPathError(env, err);
    return env.Null();
  }

  return outArr;
}

// ---------------------------------------------------------------------------
// Zero-Copy Native Direct Buffer Encoder: encodeFastDeltaSoABulk
// ---------------------------------------------------------------------------
Napi::Value EncodeFastDeltaSoABulk(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // (tick, tEids, tWireIds, px, py, pz, vEids, lx, ly, lz)
  if (info.Length() < 10) {
    ThrowFastPathError(env, "encodeFastDeltaSoABulk requires 10 TypedArray arguments");
    return env.Null();
  }

  uint32_t tick = info[0].As<Napi::Number>().Uint32Value();
  auto tEids = info[1].As<Napi::TypedArrayOf<uint32_t>>();
  auto tWireIds = info[2].As<Napi::BigUint64Array>();
  auto px = info[3].As<Napi::Float64Array>();
  auto py = info[4].As<Napi::Float64Array>();
  auto pz = info[5].As<Napi::Float64Array>();
  auto vEids = info[6].As<Napi::TypedArrayOf<uint32_t>>();
  auto lx = info[7].As<Napi::Float64Array>();
  auto ly = info[8].As<Napi::Float64Array>();
  auto lz = info[9].As<Napi::Float64Array>();

  size_t tCount = tEids.ElementLength();
  size_t vCount = vEids.ElementLength();

  std::unordered_set<uint32_t> vSlots;
  vSlots.reserve(vCount);
  const uint32_t* vData = vEids.Data();
  for (size_t i = 0; i < vCount; ++i) vSlots.insert(vData[i]);

  const uint32_t* tData = tEids.Data();
  const uint64_t* wireData = reinterpret_cast<const uint64_t*>(tWireIds.Data());
  const double* pxD = px.Data();
  const double* pyD = py.Data();
  const double* pzD = pz.Data();
  const double* lxD = lx.Data();
  const double* lyD = ly.Data();
  const double* lzD = lz.Data();

  std::vector<FastPathRecord> records;
  records.reserve(tCount);

  for (size_t i = 0; i < tCount; ++i) {
    uint32_t eid = tData[i];
    if (vSlots.find(eid) == vSlots.end()) continue;

    FastPathRecord r;
    r.wireId = wireData[eid];
    r.px = static_cast<float>(pxD[eid]);
    r.py = static_cast<float>(pyD[eid]);
    r.pz = static_cast<float>(pzD[eid]);
    r.lx = static_cast<float>(lxD[eid]);
    r.ly = static_cast<float>(lyD[eid]);
    r.lz = static_cast<float>(lzD[eid]);
    records.push_back(r);
  }

  if (records.empty()) return env.Null();

  size_t totalBytes = FAST_PATH_HEADER_BYTES + records.size() * FAST_PATH_RECORD_BYTES;
  Napi::Uint8Array out = Napi::Uint8Array::New(env, totalBytes);
  std::string err;
  EncodeFastDeltaCore(tick, records.data(), records.size(), out.Data(), totalBytes, err);
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("encodeFastDelta", Napi::Function::New(env, EncodeFastDelta));
  exports.Set("decodeFastDelta", Napi::Function::New(env, DecodeFastDelta));
  exports.Set("tryDecodeFastDelta", Napi::Function::New(env, TryDecodeFastDelta));
  exports.Set("encodeFastDeltaFromSoA", Napi::Function::New(env, EncodeFastDeltaFromSoA));
  exports.Set("encodeFastDeltaSoABulk", Napi::Function::New(env, EncodeFastDeltaSoABulk));

  exports.Set("FAST_PATH_MAGIC", Napi::Number::New(env, FAST_PATH_MAGIC));
  exports.Set("FAST_PATH_VERSION", Napi::Number::New(env, FAST_PATH_VERSION));
  exports.Set("FAST_PATH_HEADER_BYTES", Napi::Number::New(env, FAST_PATH_HEADER_BYTES));
  exports.Set("FAST_PATH_RECORD_BYTES", Napi::Number::New(env, FAST_PATH_RECORD_BYTES));

  return exports;
}

NODE_API_MODULE(codec, Init)

} // namespace mmo_codec
