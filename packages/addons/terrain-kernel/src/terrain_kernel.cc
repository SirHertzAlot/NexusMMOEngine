// @mmo-engine/addon-terrain-kernel — grid-level terrain kernel (P2-P4).
//
// N-API surface over the pure-C++ kernel in src/kernel/:
//   bakeHeightfield(params, height, flow)   — P2 grid API (+ P4 stages)
//   computeTectonics(params, uplift, strain) — P3 Voronoi plates
//   thermalErode / fluvialErode / dropletErode — P4 erosion operators
//   computeFlow(height, w, d, cell, weight, flow) — kernel drainage
//
// Zero-copy: all grids are caller-provided Float32Arrays. No C++
// exception ever crosses the boundary (NAPI_DISABLE_CPP_EXCEPTIONS);
// invalid input throws a JS TypeError/RangeError.

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "terrain_kernel/erosion.h"
#include "terrain_kernel/grid.h"
#include "terrain_kernel/hydrology.h"
#include "terrain_kernel/tectonics.h"

namespace mmo_terrain_kernel {

constexpr int kMaxDim = 4096;
constexpr int64_t kMaxCells = 16777216;  // 4096 x 4096

namespace {

// ---- validation helpers (same discipline as addon-procgen) ----

bool IsFiniteNumber(Napi::Value v) {
  return v.IsNumber() && std::isfinite(v.As<Napi::Number>().DoubleValue());
}

bool CheckedGrid(Napi::Env env, Napi::Value wv, Napi::Value dv,
                 Napi::Value cellv, int* W, int* D, double* cell) {
  for (auto [v, name] : {std::pair<Napi::Value, const char*>(wv, "width"),
                         {dv, "depth"}}) {
    if (!v.IsNumber()) {
      Napi::TypeError::New(env, std::string(name) + " must be a number")
          .ThrowAsJavaScriptException();
      return false;
    }
    const double d = v.As<Napi::Number>().DoubleValue();
    if (std::trunc(d) != d || d < 1 || d > kMaxDim) {
      Napi::RangeError::New(
          env, std::string(name) + " must be an integer in [1, 4096]")
          .ThrowAsJavaScriptException();
      return false;
    }
  }
  *W = static_cast<int>(wv.As<Napi::Number>().DoubleValue());
  *D = static_cast<int>(dv.As<Napi::Number>().DoubleValue());
  if (static_cast<int64_t>(*W) * *D > kMaxCells) {
    Napi::RangeError::New(env, "width * depth must be <= 16777216")
        .ThrowAsJavaScriptException();
    return false;
  }
  if (!IsFiniteNumber(cellv)) {
    Napi::TypeError::New(env, "cell must be a finite number")
        .ThrowAsJavaScriptException();
    return false;
  }
  const double c = cellv.As<Napi::Number>().DoubleValue();
  if (c <= 0) {
    Napi::RangeError::New(env, "cell must be > 0").ThrowAsJavaScriptException();
    return false;
  }
  *cell = c;
  return true;
}

float* CheckedGridBuffer(Napi::Env env, Napi::Value value, const char* name,
                         size_t want) {
  if (!value.IsTypedArray()) {
    Napi::TypeError::New(env, std::string(name) + " must be a TypedArray")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::TypedArray ta = value.As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a Float32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Float32Array arr = ta.As<Napi::Float32Array>();
  if (arr.ElementLength() != want) {
    Napi::RangeError::New(
        env, std::string(name) + " must hold exactly width*depth floats")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

bool CheckedSeed(Napi::Env env, Napi::Value value, const char* name,
                 uint64_t* out) {
  if (!value.IsBigInt()) {
    Napi::TypeError::New(env, std::string(name) + " must be a bigint")
        .ThrowAsJavaScriptException();
    return false;
  }
  bool lossless = false;
  *out = value.As<Napi::BigInt>().Uint64Value(&lossless);
  if (!lossless) {
    Napi::RangeError::New(env, std::string(name) + " must be a u64 bigint")
        .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

bool CheckedFinite(Napi::Env env, Napi::Value value, const char* name,
                   double* out) {
  if (!IsFiniteNumber(value)) {
    Napi::TypeError::New(env, std::string(name) + " must be a finite number")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = value.As<Napi::Number>().DoubleValue();
  return true;
}

bool CheckedCount(Napi::Env env, Napi::Value value, const char* name, int* out,
                  int lo, int hi) {
  double d = 0;
  if (!CheckedFinite(env, value, name, &d)) return false;
  if (std::trunc(d) != d || d < lo || d > hi) {
    Napi::RangeError::New(
        env, std::string(name) + " must be an integer in range")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = static_cast<int>(d);
  return true;
}

}  // namespace

// bakeHeightfield(params, height, flow) -> undefined
//
// params = {
//   seed: bigint (u64), width, depth, cell, seaLevel,
//   stages: [{ op: 'identity'|'thermal'|'fluvial'|'droplet', ...op params }],
//   rainShare?: Float32Array,   // required by fluvial/droplet stages
//   dropletSeed?: bigint,        // defaults to seed
// }
// height: Float32Array(W*D), metres, in/out. flow: Float32Array(W*D), m^2, out.
Napi::Value BakeHeightfield(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 3) {
    Napi::TypeError::New(env, "bakeHeightfield expects 3 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!info[0].IsObject()) {
    Napi::TypeError::New(env, "params must be an object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object params = info[0].As<Napi::Object>();

  uint64_t seed = 0;
  if (!CheckedSeed(env, params.Get("seed"), "seed", &seed))
    return env.Undefined();
  int W = 0, D = 0;
  double cell = 0;
  if (!CheckedGrid(env, params.Get("width"), params.Get("depth"),
                   params.Get("cell"), &W, &D, &cell))
    return env.Undefined();
  double seaLevel = 0;
  if (!CheckedFinite(env, params.Get("seaLevel"), "seaLevel", &seaLevel))
    return env.Undefined();

  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  float* height = CheckedGridBuffer(env, info[1], "height", N);
  if (!height) return env.Undefined();
  float* flow = CheckedGridBuffer(env, info[2], "flow", N);
  if (!flow) return env.Undefined();

  Napi::Value stagesV = params.Get("stages");
  if (!stagesV.IsArray()) {
    Napi::TypeError::New(env, "stages must be an array")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array stages = stagesV.As<Napi::Array>();

  Napi::Value rainV = params.Get("rainShare");
  float* rainShare = nullptr;
  if (!rainV.IsUndefined()) {
    rainShare = CheckedGridBuffer(env, rainV, "rainShare", N);
    if (!rainShare) return env.Undefined();
  }
  uint64_t dropletSeed = seed;
  Napi::Value dsV = params.Get("dropletSeed");
  if (!dsV.IsUndefined() && !CheckedSeed(env, dsV, "dropletSeed", &dropletSeed))
    return env.Undefined();

  const terrain_kernel::Grid grid{W, D, cell};
  // Validate rain availability BEFORE running anything: fluvial/droplet
  // dereference rainShare, so a missing buffer must throw, never crash.
  bool needRain = false;
  for (uint32_t s = 0; s < stages.Length(); ++s) {
    Napi::Value sv = stages.Get(s);
    if (!sv.IsObject()) {
      Napi::TypeError::New(env, "each stage must be an object")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Value opV = sv.As<Napi::Object>().Get("op");
    if (!opV.IsString()) {
      Napi::TypeError::New(env, "each stage needs a string 'op'")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const std::string op = opV.As<Napi::String>().Utf8Value();
    if (op == "fluvial" || op == "droplet") needRain = true;
  }
  if (needRain && !rainShare) {
    Napi::TypeError::New(env, "fluvial/droplet stages require rainShare")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  for (uint32_t s = 0; s < stages.Length(); ++s) {
    Napi::Object st = stages.Get(s).As<Napi::Object>();
    const std::string op = st.Get("op").As<Napi::String>().Utf8Value();
    if (op == "identity") {
      continue;  // no-op: height passes through untouched
    } else if (op == "thermal") {
      double talusDeg = 0;
      int passes = 0;
      if (!CheckedFinite(env, st.Get("talusDeg"), "talusDeg", &talusDeg) ||
          !CheckedCount(env, st.Get("passes"), "passes", &passes, 0, 10000))
        return env.Undefined();
      terrain_kernel::thermalErosion(height, grid, talusDeg, passes);
    } else if (op == "fluvial") {
      int passes = 0;
      double strength = 0;
      if (!CheckedCount(env, st.Get("passes"), "passes", &passes, 0, 10000) ||
          !CheckedFinite(env, st.Get("strength"), "strength", &strength))
        return env.Undefined();
      terrain_kernel::fluvialErosion(height, grid, seaLevel, rainShare, passes,
                                    strength);
    } else if (op == "droplet") {
      int droplets = 0;
      double strength = 0;
      if (!CheckedCount(env, st.Get("droplets"), "droplets", &droplets, 0,
                        100000000) ||
          !CheckedFinite(env, st.Get("strength"), "strength", &strength))
        return env.Undefined();
      terrain_kernel::dropletErosion(height, grid, seaLevel, rainShare,
                                    droplets, strength, dropletSeed);
    } else {
      Napi::RangeError::New(env, "unknown stage op: " + op)
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // Flow output: rain-weighted upstream area over the final heightfield,
  // via the kernel's own depression filling + drainage.
  std::vector<float> filled(N);
  terrain_kernel::fillDepressions(height, filled.data(), grid);
  terrain_kernel::Drainage drain;
  terrain_kernel::computeDrainage(filled.data(), grid, &drain);
  terrain_kernel::accumulate(drain, grid, rainShare, flow);
  return env.Undefined();
}

// computeTectonics(params, uplift, strain) -> undefined
//
// params = { seed: bigint (u64), width, depth, cell,
//            plateCount?, maxUpliftM?, riftDepthM?, boundaryWidthM? }
Napi::Value ComputeTectonics(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 3) {
    Napi::TypeError::New(env, "computeTectonics expects 3 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!info[0].IsObject()) {
    Napi::TypeError::New(env, "params must be an object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object params = info[0].As<Napi::Object>();
  uint64_t seed = 0;
  if (!CheckedSeed(env, params.Get("seed"), "seed", &seed))
    return env.Undefined();
  int W = 0, D = 0;
  double cell = 0;
  if (!CheckedGrid(env, params.Get("width"), params.Get("depth"),
                   params.Get("cell"), &W, &D, &cell))
    return env.Undefined();

  terrain_kernel::TectonicParams tp;
  tp.seed = seed;
  Napi::Value v;
  v = params.Get("plateCount");
  if (!v.IsUndefined() && !CheckedCount(env, v, "plateCount", &tp.plateCount, 2, 256))
    return env.Undefined();
  v = params.Get("maxUpliftM");
  if (!v.IsUndefined() && !CheckedFinite(env, v, "maxUpliftM", &tp.maxUpliftM))
    return env.Undefined();
  v = params.Get("riftDepthM");
  if (!v.IsUndefined() && !CheckedFinite(env, v, "riftDepthM", &tp.riftDepthM))
    return env.Undefined();
  v = params.Get("boundaryWidthM");
  if (!v.IsUndefined() &&
      !CheckedFinite(env, v, "boundaryWidthM", &tp.boundaryWidthM))
    return env.Undefined();

  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  float* uplift = CheckedGridBuffer(env, info[1], "uplift", N);
  if (!uplift) return env.Undefined();
  float* strain = CheckedGridBuffer(env, info[2], "strain", N);
  if (!strain) return env.Undefined();

  terrain_kernel::computeTectonics(tp, terrain_kernel::Grid{W, D, cell},
                                  uplift, strain);
  return env.Undefined();
}

// thermalErode(height, width, depth, cell, talusDeg, passes) -> undefined
Napi::Value ThermalErode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 6) {
    Napi::TypeError::New(env, "thermalErode expects 6 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  int W = 0, D = 0;
  double cell = 0;
  if (!CheckedGrid(env, info[1], info[2], info[3], &W, &D, &cell))
    return env.Undefined();
  double talusDeg = 0;
  int passes = 0;
  if (!CheckedFinite(env, info[4], "talusDeg", &talusDeg) ||
      !CheckedCount(env, info[5], "passes", &passes, 0, 10000))
    return env.Undefined();
  float* h =
      CheckedGridBuffer(env, info[0], "height",
                        static_cast<size_t>(W) * static_cast<size_t>(D));
  if (!h) return env.Undefined();
  terrain_kernel::thermalErosion(h, terrain_kernel::Grid{W, D, cell}, talusDeg,
                                passes);
  return env.Undefined();
}

// fluvialErode(height, width, depth, cell, seaLevel, rainShare, passes,
//              strength) -> deepestCutM
Napi::Value FluvialErode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 8) {
    Napi::TypeError::New(env, "fluvialErode expects 8 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  int W = 0, D = 0;
  double cell = 0;
  if (!CheckedGrid(env, info[1], info[2], info[3], &W, &D, &cell))
    return env.Undefined();
  double seaLevel = 0, strength = 0;
  int passes = 0;
  if (!CheckedFinite(env, info[4], "seaLevel", &seaLevel) ||
      !CheckedCount(env, info[6], "passes", &passes, 0, 10000) ||
      !CheckedFinite(env, info[7], "strength", &strength))
    return env.Undefined();
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  float* h = CheckedGridBuffer(env, info[0], "height", N);
  if (!h) return env.Undefined();
  float* rain = CheckedGridBuffer(env, info[5], "rainShare", N);
  if (!rain) return env.Undefined();
  const double deepest = terrain_kernel::fluvialErosion(
      h, terrain_kernel::Grid{W, D, cell}, seaLevel, rain, passes, strength);
  return Napi::Number::New(env, deepest);
}

// dropletErode(height, width, depth, cell, seaLevel, rainShare, droplets,
//              strength, seed) -> { meanM, maxM }
Napi::Value DropletErode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 9) {
    Napi::TypeError::New(env, "dropletErode expects 9 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  int W = 0, D = 0;
  double cell = 0;
  if (!CheckedGrid(env, info[1], info[2], info[3], &W, &D, &cell))
    return env.Undefined();
  double seaLevel = 0, strength = 0;
  int droplets = 0;
  uint64_t seed = 0;
  if (!CheckedFinite(env, info[4], "seaLevel", &seaLevel) ||
      !CheckedCount(env, info[6], "droplets", &droplets, 0, 100000000) ||
      !CheckedFinite(env, info[7], "strength", &strength) ||
      !CheckedSeed(env, info[8], "seed", &seed))
    return env.Undefined();
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  float* h = CheckedGridBuffer(env, info[0], "height", N);
  if (!h) return env.Undefined();
  float* rain = CheckedGridBuffer(env, info[5], "rainShare", N);
  if (!rain) return env.Undefined();
  const terrain_kernel::DropletStats stats = terrain_kernel::dropletErosion(
      h, terrain_kernel::Grid{W, D, cell}, seaLevel, rain, droplets, strength,
      seed);
  Napi::Object out = Napi::Object::New(env);
  out.Set("meanM", stats.meanM);
  out.Set("maxM", stats.maxM);
  return out;
}

// computeFlow(height, width, depth, cell, weight|null, flow) -> undefined
Napi::Value ComputeFlow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 6) {
    Napi::TypeError::New(env, "computeFlow expects 6 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  int W = 0, D = 0;
  double cell = 0;
  if (!CheckedGrid(env, info[1], info[2], info[3], &W, &D, &cell))
    return env.Undefined();
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  float* h = CheckedGridBuffer(env, info[0], "height", N);
  if (!h) return env.Undefined();
  float* weight = nullptr;
  if (!info[4].IsNull()) {
    weight = CheckedGridBuffer(env, info[4], "weight", N);
    if (!weight) return env.Undefined();
  }
  float* flow = CheckedGridBuffer(env, info[5], "flow", N);
  if (!flow) return env.Undefined();
  const terrain_kernel::Grid grid{W, D, cell};
  std::vector<float> filled(N);
  terrain_kernel::fillDepressions(h, filled.data(), grid);
  terrain_kernel::Drainage drain;
  terrain_kernel::computeDrainage(filled.data(), grid, &drain);
  terrain_kernel::accumulate(drain, grid, weight, flow);
  return env.Undefined();
}

Napi::Value LibraryInfo(const Napi::CallbackInfo& info) {
  return Napi::String::New(
      info.Env(),
      "terrain-kernel P2-P4: grid bake API, Voronoi tectonics, thermal / "
      "fluvial / droplet erosion (ports of terrain/erosion.ts, MIT engine)");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("bakeHeightfield", Napi::Function::New(env, BakeHeightfield));
  exports.Set("computeTectonics", Napi::Function::New(env, ComputeTectonics));
  exports.Set("thermalErode", Napi::Function::New(env, ThermalErode));
  exports.Set("fluvialErode", Napi::Function::New(env, FluvialErode));
  exports.Set("dropletErode", Napi::Function::New(env, DropletErode));
  exports.Set("computeFlow", Napi::Function::New(env, ComputeFlow));
  exports.Set("libraryInfo", Napi::Function::New(env, LibraryInfo));
  return exports;
}

NODE_API_MODULE(terrain_kernel, Init)

}  // namespace mmo_terrain_kernel
