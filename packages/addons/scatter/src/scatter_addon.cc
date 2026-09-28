// scatter_addon.cc — N-API wrapper for the PCG scatter executor.
//
// scatterChunk(args) executes a *cooked* scatter plan (produced by the
// @mmo-engine/scatter cooker) for one chunk and returns spawn records.
// This runs at chunk-load time, never on the tick hot path.
//
//   scatterChunk({
//     plan:    CookedPlan,   // { nodes: [{ id, type, settings }], order: [id] }
//     worldSeed: number,     // u32
//     cx: number, cz: number,// int32 chunk coords
//     heights: Float64Array, // row-major gridN x gridN height tile
//     gridN: number, gridOx: number, gridOz: number, gridStep: number,
//   }) -> Array<{ x,y,z, yaw,pitch,roll, sx,sy,sz,
//                  asset, variantSeed, seed, attrs }>
//
// Exceptions are disabled (NAPI_DISABLE_CPP_EXCEPTIONS): invalid input
// throws a JS exception via ThrowAsJavaScriptException and returns
// undefined; the core itself reports errors via status codes.

#include <napi.h>

#include <cmath>
#include <string>

#include "scatter_core.h"

namespace mmo_scatter {

namespace {

// --- checked JS value readers (false + JS throw on violation) ---

bool CheckedNumber(Napi::Env env, Napi::Object obj, const char* key,
                   double* out) {
  Napi::Value v = obj.Get(key);
  if (!v.IsNumber()) {
    Napi::TypeError::New(env, std::string("settings.") + key +
                                  " must be a number")
        .ThrowAsJavaScriptException();
    return false;
  }
  const double d = v.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(d)) {
    Napi::RangeError::New(env, std::string("settings.") + key +
                                   " must be finite")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = d;
  return true;
}

bool CheckedUint32(Napi::Env env, Napi::Object obj, const char* key,
                   uint32_t* out) {
  double d = 0;
  if (!CheckedNumber(env, obj, key, &d)) return false;
  if (std::trunc(d) != d || d < 0 || d >= 4294967296.0) {
    Napi::RangeError::New(env, std::string("settings.") + key +
                                   " must be a u32")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = static_cast<uint32_t>(d);
  return true;
}

bool CheckedString(Napi::Env env, Napi::Object obj, const char* key,
                   std::string* out) {
  Napi::Value v = obj.Get(key);
  if (!v.IsString()) {
    Napi::TypeError::New(env, std::string("settings.") + key +
                                  " must be a string")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = v.As<Napi::String>().Utf8Value();
  return true;
}

bool CheckedInt32(Napi::Env env, Napi::Value value, const char* name,
                  int32_t* out) {
  if (!value.IsNumber()) {
    Napi::TypeError::New(env, std::string(name) + " must be a number")
        .ThrowAsJavaScriptException();
    return false;
  }
  const double d = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(d) || std::trunc(d) != d || d < -2147483648.0 ||
      d > 2147483647.0) {
    Napi::RangeError::New(env, std::string(name) + " must be an int32")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = static_cast<int32_t>(d);
  return true;
}

// Parse one node's settings into spec. Returns false + JS throw on any
// shape violation (the cooker guarantees validity; this is defense in
// depth at the native boundary).
bool ParseNode(Napi::Env env, const std::string& id, const std::string& type,
               Napi::Object settings, NodeSpec* spec) {
  if (type == "gridSampler") {
    spec->type = NodeType::GridSampler;
    return CheckedNumber(env, settings, "spacing", &spec->spacing) &&
           CheckedNumber(env, settings, "jitter", &spec->jitter) &&
           CheckedUint32(env, settings, "seed", &spec->seed);
  }
  if (type == "densityFilter") {
    spec->type = NodeType::DensityFilter;
    return CheckedNumber(env, settings, "density", &spec->density) &&
           CheckedUint32(env, settings, "seed", &spec->seed);
  }
  if (type == "slopeFilter") {
    spec->type = NodeType::SlopeFilter;
    return CheckedNumber(env, settings, "maxSlope", &spec->maxSlope);
  }
  if (type == "attributeFilter") {
    spec->type = NodeType::AttributeFilter;
    return CheckedString(env, settings, "attribute", &spec->attribute) &&
           CheckedNumber(env, settings, "min", &spec->minVal) &&
           CheckedNumber(env, settings, "max", &spec->maxVal);
  }
  if (type == "setAttribute") {
    spec->type = NodeType::SetAttribute;
    return CheckedString(env, settings, "attribute", &spec->attribute) &&
           CheckedNumber(env, settings, "value", &spec->value);
  }
  if (type == "transformPoints") {
    spec->type = NodeType::TransformPoints;
    return CheckedNumber(env, settings, "yawMin", &spec->yawMin) &&
           CheckedNumber(env, settings, "yawMax", &spec->yawMax) &&
           CheckedNumber(env, settings, "scaleMin", &spec->scaleMin) &&
           CheckedNumber(env, settings, "scaleMax", &spec->scaleMax) &&
           CheckedUint32(env, settings, "seed", &spec->seed);
  }
  if (type == "meshSpawner") {
    spec->type = NodeType::MeshSpawner;
    if (!CheckedUint32(env, settings, "seed", &spec->seed)) return false;
    Napi::Value ev = settings.Get("entries");
    if (!ev.IsArray()) {
      Napi::TypeError::New(env, "settings.entries must be an array")
          .ThrowAsJavaScriptException();
      return false;
    }
    Napi::Array arr = ev.As<Napi::Array>();
    if (arr.Length() == 0) {
      Napi::RangeError::New(env, "settings.entries must not be empty")
          .ThrowAsJavaScriptException();
      return false;
    }
    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value item = arr[i];
      if (!item.IsObject()) {
        Napi::TypeError::New(env, "settings.entries[i] must be an object")
            .ThrowAsJavaScriptException();
        return false;
      }
      Napi::Object eo = item.As<Napi::Object>();
      SpawnEntry e;
      if (!CheckedString(env, eo, "asset", &e.asset)) return false;
      if (!CheckedNumber(env, eo, "weight", &e.weight)) return false;
      if (!(e.weight > 0)) {
        Napi::RangeError::New(env, "settings.entries[i].weight must be > 0")
            .ThrowAsJavaScriptException();
        return false;
      }
      spec->entries.push_back(std::move(e));
    }
    return true;
  }
  Napi::TypeError::New(env, "unknown node type \"" + type + "\" for node \"" +
                                id + "\"")
      .ThrowAsJavaScriptException();
  return false;
}

}  // namespace

Napi::Value ScatterChunkJs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "scatterChunk expects one argument object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object args = info[0].As<Napi::Object>();

  // --- plan ---
  Napi::Value planV = args.Get("plan");
  if (!planV.IsObject()) {
    Napi::TypeError::New(env, "args.plan must be an object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object plan = planV.As<Napi::Object>();
  Napi::Value nodesV = plan.Get("nodes");
  Napi::Value orderV = plan.Get("order");
  if (!nodesV.IsArray() || !orderV.IsArray()) {
    Napi::TypeError::New(env, "plan.nodes and plan.order must be arrays")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array nodesArr = nodesV.As<Napi::Array>();
  Napi::Array orderArr = orderV.As<Napi::Array>();
  if (nodesArr.Length() == 0 || orderArr.Length() == 0) {
    Napi::RangeError::New(env, "plan must contain at least one node")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // id -> parsed spec
  struct NamedSpec {
    std::string id;
    NodeSpec spec;
  };
  std::vector<NamedSpec> byId;
  byId.reserve(nodesArr.Length());
  int spawnerCount = 0;
  for (uint32_t i = 0; i < nodesArr.Length(); i++) {
    Napi::Value nv = nodesArr[i];
    if (!nv.IsObject()) {
      Napi::TypeError::New(env, "plan.nodes[i] must be an object")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object no = nv.As<Napi::Object>();
    Napi::Value idV = no.Get("id");
    Napi::Value typeV = no.Get("type");
    Napi::Value settingsV = no.Get("settings");
    if (!idV.IsString() || !typeV.IsString() || !settingsV.IsObject()) {
      Napi::TypeError::New(
          env, "plan node needs string id/type and object settings")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    NamedSpec ns;
    ns.id = idV.As<Napi::String>().Utf8Value();
    const std::string type = typeV.As<Napi::String>().Utf8Value();
    if (!ParseNode(env, ns.id, type, settingsV.As<Napi::Object>(),
                   &ns.spec)) {
      return env.Undefined();  // ParseNode already threw
    }
    if (ns.spec.type == NodeType::MeshSpawner) spawnerCount++;
    byId.push_back(std::move(ns));
  }
  if (spawnerCount != 1) {
    Napi::RangeError::New(env, "plan must contain exactly one spawner")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // order -> execution sequence
  std::vector<NodeSpec> ordered;
  ordered.reserve(orderArr.Length());
  for (uint32_t i = 0; i < orderArr.Length(); i++) {
    Napi::Value idV = orderArr[i];
    if (!idV.IsString()) {
      Napi::TypeError::New(env, "plan.order[i] must be a string")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const std::string id = idV.As<Napi::String>().Utf8Value();
    bool found = false;
    for (const auto& ns : byId) {
      if (ns.id == id) {
        ordered.push_back(ns.spec);
        found = true;
        break;
      }
    }
    if (!found) {
      Napi::RangeError::New(env, "plan.order references unknown node \"" +
                                      id + "\"")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  if (ordered.front().type != NodeType::GridSampler) {
    Napi::RangeError::New(env, "plan must start with a sampler")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // --- scalars ---
  ScatterArgs sargs;
  double worldSeedD = 0;
  {
    Napi::Value v = args.Get("worldSeed");
    if (!v.IsNumber()) {
      Napi::TypeError::New(env, "args.worldSeed must be a number")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    worldSeedD = v.As<Napi::Number>().DoubleValue();
  }
  if (!std::isfinite(worldSeedD) || std::trunc(worldSeedD) != worldSeedD ||
      worldSeedD < 0 || worldSeedD >= 4294967296.0) {
    Napi::RangeError::New(env, "args.worldSeed must be a u32")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  sargs.worldSeed = static_cast<uint32_t>(worldSeedD);
  if (!CheckedInt32(env, args.Get("cx"), "args.cx", &sargs.cx) ||
      !CheckedInt32(env, args.Get("cz"), "args.cz", &sargs.cz)) {
    return env.Undefined();
  }

  // --- height tile ---
  Napi::Value hV = args.Get("heights");
  if (!hV.IsTypedArray() ||
      hV.As<Napi::TypedArray>().TypedArrayType() != napi_float64_array) {
    Napi::TypeError::New(env, "args.heights must be a Float64Array")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Float64Array heights = hV.As<Napi::Float64Array>();
  double gridND = 0, gridOx = 0, gridOz = 0, gridStep = 0;
  {
    Napi::Value v = args.Get("gridN");
    if (!v.IsNumber()) {
      Napi::TypeError::New(env, "args.gridN must be a number")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    gridND = v.As<Napi::Number>().DoubleValue();
  }
  if (std::trunc(gridND) != gridND || gridND < 2 || gridND > 4096) {
    Napi::RangeError::New(env, "args.gridN must be an integer >= 2")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int gridN = static_cast<int>(gridND);
  if (heights.ElementLength() <
      static_cast<size_t>(gridN) * static_cast<size_t>(gridN)) {
    Napi::RangeError::New(env, "args.heights must hold gridN*gridN doubles")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Value oxV = args.Get("gridOx");
  Napi::Value ozV = args.Get("gridOz");
  Napi::Value stepV = args.Get("gridStep");
  if (!oxV.IsNumber() || !ozV.IsNumber() || !stepV.IsNumber()) {
    Napi::TypeError::New(env, "args.gridOx/gridOz/gridStep must be numbers")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  gridOx = oxV.As<Napi::Number>().DoubleValue();
  gridOz = ozV.As<Napi::Number>().DoubleValue();
  gridStep = stepV.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(gridOx) || !std::isfinite(gridOz) ||
      !std::isfinite(gridStep) || !(gridStep > 0)) {
    Napi::RangeError::New(env, "args.gridStep must be a positive number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  sargs.heights.data = heights.Data();
  sargs.heights.gridN = gridN;
  sargs.heights.ox = gridOx;
  sargs.heights.oz = gridOz;
  sargs.heights.step = gridStep;

  // --- execute ---
  std::vector<SpawnRecord> records;
  std::string err;
  if (!ScatterChunk(ordered, sargs, records, err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // --- output records ---
  Napi::Array out = Napi::Array::New(env, records.size());
  for (size_t i = 0; i < records.size(); i++) {
    const SpawnRecord& r = records[i];
    Napi::Object o = Napi::Object::New(env);
    o.Set("x", r.x);
    o.Set("y", r.y);
    o.Set("z", r.z);
    o.Set("yaw", r.yaw);
    o.Set("pitch", r.pitch);
    o.Set("roll", r.roll);
    o.Set("sx", r.sx);
    o.Set("sy", r.sy);
    o.Set("sz", r.sz);
    o.Set("asset", r.asset);
    o.Set("variantSeed", static_cast<double>(r.variantSeed));
    o.Set("seed", static_cast<double>(r.seed));
    Napi::Object attrs = Napi::Object::New(env);
    for (const auto& kv : r.attrs) attrs.Set(kv.first, kv.second);
    o.Set("attrs", attrs);
    out[i] = o;
  }
  return out;
}

// --- hash primitive exports (golden-vector testing) ---

Napi::Value HashU32Js(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "hashU32 expects one number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double d = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(d) || std::trunc(d) != d || d < 0 ||
      d >= 4294967296.0) {
    Napi::RangeError::New(env, "hashU32 expects a u32")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::Number::New(env,
                           static_cast<double>(HashU32(static_cast<uint32_t>(d))));
}

Napi::Value Hash01Js(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "hash01 expects one number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double d = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(d) || std::trunc(d) != d || d < 0 ||
      d >= 4294967296.0) {
    Napi::RangeError::New(env, "hash01 expects a u32")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::Number::New(env, Hash01(static_cast<uint32_t>(d)));
}

Napi::Value DeriveChunkSeedJs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 3 || !info[0].IsNumber() || !info[1].IsNumber() ||
      !info[2].IsNumber()) {
    Napi::TypeError::New(env, "deriveChunkSeed expects (u32, int32, int32)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double w = info[0].As<Napi::Number>().DoubleValue();
  int32_t cx = 0, cz = 0;
  if (!std::isfinite(w) || std::trunc(w) != w || w < 0 ||
      w >= 4294967296.0 || !CheckedInt32(env, info[1], "cx", &cx) ||
      !CheckedInt32(env, info[2], "cz", &cz)) {
    if (!env.IsExceptionPending()) {
      Napi::RangeError::New(env, "deriveChunkSeed expects (u32, int32, int32)")
          .ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }
  return Napi::Number::New(
      env, static_cast<double>(
               DeriveChunkSeed(static_cast<uint32_t>(w), cx, cz)));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("scatterChunk", Napi::Function::New(env, ScatterChunkJs));
  exports.Set("hashU32", Napi::Function::New(env, HashU32Js));
  exports.Set("hash01", Napi::Function::New(env, Hash01Js));
  exports.Set("deriveChunkSeed",
              Napi::Function::New(env, DeriveChunkSeedJs));
  return exports;
}

NODE_API_MODULE(scatter, Init)

}  // namespace mmo_scatter
