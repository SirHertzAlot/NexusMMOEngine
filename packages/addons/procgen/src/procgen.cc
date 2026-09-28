// @mmo-engine/addon-procgen — procedural chunk heightmaps (slice 1.6).
//
// N-API wrapper over vendored FastNoise2 (MIT; see
// third_party/FastNoise2/VENDORING.md). A narrow, stateless, pure-function
// boundary:
//
//   generateChunk(seed: bigint, cx: i32, cz: i32, lod: u8, out: Float32Array,
//                 frequency?: number)
//
// writes 16x16 height samples into the caller-provided buffer, zero-copy
// (DOD — no copies, no native object lifetimes). Same (seed, cx, cz, lod,
// frequency) -> bit-identical output. Values are normalized to [-1, 1];
// callers scale to world units.
//
// Terrain constants (configurable noise graphs are Phase 2 work):
// - Noise: FastNoise2 Simplex (feature scale 1/frequency, default
//   kDefaultFrequency) -> FractalFBm (kOctaves), soft-clipped into
//   (-1, 1).
//   Note Simplex's own default feature scale is 100 (frequency 0.01), so
//   the frequency must be set on the Simplex node, not layered on top.
// - Chunk: 16x16 samples sharing their edges with the neighbours. Sample
//   (i, j) is evaluated at noise-space (x0 + i*step, z0 + j*step) with
//   x0 = cx*15*step, z0 = cz*15*step, step = 1 << lod — so sample 15 of
//   chunk cx and sample 0 of chunk cx+1 are the SAME integer coordinate
//   and bit-identical (seamless borders). Frequency is applied inside the
//   node graph (Simplex feature scale), never to the grid coordinates, so edge
//   positions stay exact integers at any frequency. Consumers place
//   sample i at local world position i*16/15 (the full 16-unit chunk).
// - Seed: low 32 bits of the bigint seed (FastNoise2 seeds are int32).
//
// Exceptions are disabled (NAPI_DISABLE_CPP_EXCEPTIONS): invalid input
// throws a JS exception via ThrowAsJavaScriptException and returns
// undefined; no C++ exception ever crosses the boundary.

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <cstdint>

#include <FastNoise/FastNoise.h>

namespace mmo_procgen {

constexpr int kChunkSize = 16;
constexpr int kChunkSamples = kChunkSize * kChunkSize;
// Noise-space cells per chunk: 16 samples span 15 intervals, and the last
// row/column is shared with the next chunk.
constexpr int kChunkCells = kChunkSize - 1;
constexpr int kMaxLod = 8;
// Hill wavelength ~1/frequency noise units (~53 world units at 0.02).
constexpr double kDefaultFrequency = 0.02;
// 3 octaves at lacunarity 2: the finest octave's period (1/(4*0.02) =
// 12.5 units) stays well above the ~1-unit sample spacing, so terrain
// detail is resolved instead of aliasing into per-sample jitter.
constexpr int kOctaves = 3;
constexpr float kGain = 0.5f;
constexpr float kLacunarity = 2.0f;

namespace {

// Returns nullptr + throws a JS TypeError when `value` is not a
// Float32Array of at least kChunkSamples elements; otherwise returns the
// raw (zero-copy) data pointer.
float* CheckedOutBuffer(Napi::Env env, Napi::Value value) {
  if (!value.IsTypedArray()) {
    Napi::TypeError::New(env, "out must be a TypedArray")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::TypedArray ta = value.As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, "out must be a Float32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Float32Array arr = ta.As<Napi::Float32Array>();
  if (arr.ElementLength() < static_cast<size_t>(kChunkSamples)) {
    Napi::RangeError::New(env, "out must hold at least 256 floats")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

// Validates a JS number as an int32 coordinate; returns false + throws on
// any violation.
bool CheckedCoord(Napi::Env env, Napi::Value value, const char* name,
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

}  // namespace

// generateChunk(seed: bigint, cx, cz, lod, out: Float32Array,
//               frequency?: number) -> undefined
Napi::Value GenerateChunk(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 5 && info.Length() != 6) {
    Napi::TypeError::New(env, "generateChunk expects 5 or 6 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!info[0].IsBigInt()) {
    Napi::TypeError::New(env, "seed must be a bigint")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool lossless = false;
  const uint64_t seed64 = info[0].As<Napi::BigInt>().Uint64Value(&lossless);
  if (!lossless) {
    Napi::RangeError::New(env, "seed must be a u64 bigint")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // FastNoise2 seeds are int32: take the low 32 bits, documented.
  const int32_t seed = static_cast<int32_t>(seed64 & 0xffffffffULL);

  int32_t cx = 0, cz = 0;
  if (!CheckedCoord(env, info[1], "cx", &cx)) return env.Undefined();
  if (!CheckedCoord(env, info[2], "cz", &cz)) return env.Undefined();

  if (!info[3].IsNumber()) {
    Napi::TypeError::New(env, "lod must be a number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double lodD = info[3].As<Napi::Number>().DoubleValue();
  if (std::trunc(lodD) != lodD || lodD < 0 || lodD > kMaxLod) {
    Napi::RangeError::New(env, "lod must be an integer in [0, 8]")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int lod = static_cast<int>(lodD);

  float* out = CheckedOutBuffer(env, info[4]);
  if (out == nullptr) return env.Undefined();  // exception already thrown

  double frequency = kDefaultFrequency;
  if (info.Length() == 6 && !info[5].IsUndefined()) {
    if (!info[5].IsNumber()) {
      Napi::TypeError::New(env, "frequency must be a number")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    frequency = info[5].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(frequency) || frequency <= 0 || frequency > 1) {
      Napi::RangeError::New(env, "frequency must be in (0, 1]")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // Integer noise-space grid: exact in float for |cx|, |cz| < ~2^19 at
  // LOD 0 (15 * 2^19 < 2^24), far past any float32 world position.
  const float step = static_cast<float>(1 << lod);
  const float x0 = static_cast<float>(cx) * kChunkCells * step;
  const float z0 = static_cast<float>(cz) * kChunkCells * step;

  // Stateless: the graph is built per call. Chunk generation is
  // on-demand (callers cache per chunk), so construction cost is noise
  // next to 256 samples of SIMD noise. No native state escapes.
  auto simplex = FastNoise::New<FastNoise::Simplex>();
  simplex->SetScale(static_cast<float>(1.0 / frequency));
  auto fbm = FastNoise::New<FastNoise::FractalFBm>();
  fbm->SetSource(simplex);
  fbm->SetOctaveCount(kOctaves);
  fbm->SetGain(kGain);
  fbm->SetLacunarity(kLacunarity);
  fbm->GenUniformGrid2D(out, x0, z0, kChunkSize, kChunkSize, step, step,
                        seed);
  // Raw FBm output is NOT bounded to [-1, 1] (measured: p99 |v| ~1.3,
  // max ~1.6), and hard-clamping it flattens ~10% of the terrain into
  // plateaus. Soft-clip with v / sqrt(1 + v^2): smooth, monotonic, keeps
  // peaks rounded, strictly inside (-1, 1). Only IEEE correctly-rounded
  // ops (mul/add/sqrt/div) — no libm transcendentals — so the result is
  // identical across platforms and compilers.
  for (int k = 0; k < kChunkSamples; ++k) {
    const float v = out[k];
    out[k] = v / std::sqrt(1.0f + v * v);
  }
  return env.Undefined();
}

// libraryInfo() -> string. Provenance for logs/debugging.
Napi::Value LibraryInfo(const Napi::CallbackInfo& info) {
  return Napi::String::New(
      info.Env(),
      "FastNoise2 (MIT, vendored; see third_party/FastNoise2/VENDORING.md)");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("generateChunk", Napi::Function::New(env, GenerateChunk));
  exports.Set("libraryInfo", Napi::Function::New(env, LibraryInfo));
  exports.Set("CHUNK_SIZE", Napi::Number::New(env, kChunkSize));
  exports.Set("CHUNK_SAMPLES", Napi::Number::New(env, kChunkSamples));
  exports.Set("MAX_LOD", Napi::Number::New(env, kMaxLod));
  exports.Set("DEFAULT_FREQUENCY", Napi::Number::New(env, kDefaultFrequency));
  return exports;
}

NODE_API_MODULE(procgen, Init)

}  // namespace mmo_procgen
