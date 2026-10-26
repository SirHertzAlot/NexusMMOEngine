// @mmo-engine/addon-integrate — bulk Transform/Velocity integration for the
// slice-1.5 validation benchmark (Phase 1 plan §6).
//
// Two shapes behind one narrow, data-oriented N-API boundary:
//
//   Harness A (the chosen architecture): the bitECS world stays in JS and
//   each tick makes ONE call —
//     integrate(px, py, pz, vx, vy, vz, count, dt)
//   operating directly on the JS-owned Float32Array SoA stores. N-API
//   TypedArray access is zero-copy (a raw pointer into the JS heap), so
//   the only marshalling cost is argument validation + the call itself.
//
//   Harness B (the alternative): a pure C++ world behind one call —
//     stepWorld(handle, dt)
//   The world is created once from initial data (createWorld copies the
//   six SoA arrays into C++ vectors); per-tick there is no data movement
//   at all.
//
// Both harnesses run the SAME integrate_kernel, so the benchmark measures
// the boundary/world-location cost, not two different implementations.
//
// Exceptions are disabled (NAPI_DISABLE_CPP_EXCEPTIONS): invalid input
// throws a JS exception via ThrowAsJavaScriptException and returns
// undefined; no C++ exception ever crosses the boundary.

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

#if defined(__AVX2__) || defined(_M_X64) || defined(__x86_64__)
#include <immintrin.h>
#define MMO_HAS_AVX2 1
#endif
#if defined(_M_X64) || defined(__x86_64__) || defined(__SSE2__)
#include <emmintrin.h>
#define MMO_HAS_SSE2 1
#else
#define MMO_HAS_SSE2 0
#endif

namespace mmo_integrate {

// Hardware AVX2 8-Wide FMA3 Kernel Implementation (PATCH-01)
#if defined(__AVX2__)
inline __m256 fma3_integrate_kernel(__m256 p, __m256 v, __m256 dt) {
  return _mm256_fmadd_ps(v, dt, p);
}
#endif


// Stride structural dimensions matching TypeScript SOA_LAYOUT schema bounds
constexpr size_t SOA_STRIDE    = 8;
constexpr size_t OFFSET_PX     = 0;
constexpr size_t OFFSET_PY     = 1;
constexpr size_t OFFSET_PZ     = 2;
constexpr size_t OFFSET_VX     = 3;
constexpr size_t OFFSET_VY     = 4;
constexpr size_t OFFSET_VZ     = 5;
constexpr size_t OFFSET_HP     = 6;
constexpr size_t OFFSET_INTENT = 7;

// Intent bitflags for fused intent-to-velocity decoding
constexpr int32_t INTENT_FORWARD  = 1 << 0; // +Z
constexpr int32_t INTENT_BACKWARD = 1 << 1; // -Z
constexpr int32_t INTENT_LEFT     = 1 << 2; // -X
constexpr int32_t INTENT_RIGHT    = 1 << 3; // +X
constexpr int32_t INTENT_UP       = 1 << 4; // +Y
constexpr int32_t INTENT_DOWN     = 1 << 5; // -Y
constexpr int32_t INTENT_SPRINT   = 1 << 6; // 2x speed multiplier

// The single integration kernel shared by both harnesses.
// position += velocity * dt, SoA, f32 — mirrors IntegrateSystem (slice 1.2).
inline void integrate_kernel(const float* __restrict vx,
                             const float* __restrict vy,
                             const float* __restrict vz,
                             float* __restrict px,
                             float* __restrict py,
                             float* __restrict pz,
                             size_t n,
                             float dt) {
#if MMO_HAS_SSE2
  const __m128 dt_v = _mm_set1_ps(dt);
  size_t i = 0;
  for (; i + 4 <= n; i += 4) {
    __m128 px_v = _mm_loadu_ps(px + i);
    __m128 py_v = _mm_loadu_ps(py + i);
    __m128 pz_v = _mm_loadu_ps(pz + i);
    __m128 vx_v = _mm_loadu_ps(vx + i);
    __m128 vy_v = _mm_loadu_ps(vy + i);
    __m128 vz_v = _mm_loadu_ps(vz + i);
    _mm_storeu_ps(px + i, _mm_add_ps(px_v, _mm_mul_ps(vx_v, dt_v)));
    _mm_storeu_ps(py + i, _mm_add_ps(py_v, _mm_mul_ps(vy_v, dt_v)));
    _mm_storeu_ps(pz + i, _mm_add_ps(pz_v, _mm_mul_ps(vz_v, dt_v)));
  }
  for (; i < n; ++i) {
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
  }
#else
  for (size_t i = 0; i < n; ++i) {
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
  }
#endif
}

/**
 * Pure native execution algorithm processing direct pointers on raw memory bytes
 * (ENGINE_IMPLEMENTATION_SPEC.md Section 4).
 * The loop structure maximizes sequential data alignment for optimized hardware parsing.
 */
inline void NativeIntegrateSystem(float* __restrict matrix,
                                  const int32_t* __restrict intMatrix,
                                  size_t entityCount,
                                  float dt) {
  for (size_t i = 0; i < entityCount; ++i) {
    const size_t baseIdx = i * SOA_STRIDE;

    // Skip dead entity processing loops immediately
    if (intMatrix[baseIdx + OFFSET_HP] <= 0) {
      continue;
    }

    // Fetch position & velocity elements sequentially
    const float px = matrix[baseIdx + OFFSET_PX];
    const float py = matrix[baseIdx + OFFSET_PY];
    const float pz = matrix[baseIdx + OFFSET_PZ];
    const float vx = matrix[baseIdx + OFFSET_VX];
    const float vy = matrix[baseIdx + OFFSET_VY];
    const float vz = matrix[baseIdx + OFFSET_VZ];

    // Execute step computations
    matrix[baseIdx + OFFSET_PX] = px + vx * dt;
    matrix[baseIdx + OFFSET_PY] = py + vy * dt;
    matrix[baseIdx + OFFSET_PZ] = pz + vz * dt;
  }
}

/**
 * DoD Planar SoA Branchless SIMD Integration Kernel.
 * Processes 4 entities per iteration via SSE2 without any branches on HP > 0,
 * eliminating CPU branch-misprediction penalties under arbitrary alive/dead entropy.
 */
inline void NativeIntegrateSoASystem(float* __restrict px,
                                     float* __restrict py,
                                     float* __restrict pz,
                                     const float* __restrict vx,
                                     const float* __restrict vy,
                                     const float* __restrict vz,
                                     const int32_t* __restrict hp,
                                     size_t entityCount,
                                     float dt) {
#if MMO_HAS_SSE2
  const __m128 dt_v = _mm_set1_ps(dt);
  const __m128i zero_i = _mm_setzero_si128();
  size_t i = 0;
  for (; i + 4 <= entityCount; i += 4) {
    __m128i hp_v = _mm_loadu_si128(reinterpret_cast<const __m128i*>(hp + i));
    __m128 alive_mask = _mm_castsi128_ps(_mm_cmpgt_epi32(hp_v, zero_i));

    __m128 px_v = _mm_loadu_ps(px + i);
    __m128 py_v = _mm_loadu_ps(py + i);
    __m128 pz_v = _mm_loadu_ps(pz + i);
    __m128 vx_v = _mm_loadu_ps(vx + i);
    __m128 vy_v = _mm_loadu_ps(vy + i);
    __m128 vz_v = _mm_loadu_ps(vz + i);

    __m128 nx = _mm_add_ps(px_v, _mm_mul_ps(vx_v, dt_v));
    __m128 ny = _mm_add_ps(py_v, _mm_mul_ps(vy_v, dt_v));
    __m128 nz = _mm_add_ps(pz_v, _mm_mul_ps(vz_v, dt_v));

    _mm_storeu_ps(px + i, _mm_or_ps(_mm_and_ps(alive_mask, nx), _mm_andnot_ps(alive_mask, px_v)));
    _mm_storeu_ps(py + i, _mm_or_ps(_mm_and_ps(alive_mask, ny), _mm_andnot_ps(alive_mask, py_v)));
    _mm_storeu_ps(pz + i, _mm_or_ps(_mm_and_ps(alive_mask, nz), _mm_andnot_ps(alive_mask, pz_v)));
  }
  for (; i < entityCount; ++i) {
    if (hp[i] <= 0) continue;
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
  }
#else
  for (size_t i = 0; i < entityCount; ++i) {
    if (hp[i] <= 0) continue;
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
  }
#endif
}

/**
 * Fused DoD Intent-Decode + Integration Kernel.
 * Translates non-zero INTENT_BIT bitmasks into velocity vectors and integrates
 * positions in a single cache-coherent pass over the SharedArrayBuffer matrix.
 */
inline void NativeApplyIntentsAndStep(float* __restrict matrix,
                                      int32_t* __restrict intMatrix,
                                      size_t entityCount,
                                      float dt,
                                      float baseSpeed) {
  for (size_t i = 0; i < entityCount; ++i) {
    const size_t baseIdx = i * SOA_STRIDE;
    if (intMatrix[baseIdx + OFFSET_HP] <= 0) {
      continue;
    }

    const int32_t intent = intMatrix[baseIdx + OFFSET_INTENT];
    if (intent != 0) {
      const float speed = (intent & INTENT_SPRINT) ? (baseSpeed * 2.0f) : baseSpeed;
      float vx = 0.0f;
      float vy = 0.0f;
      float vz = 0.0f;
      if (intent & INTENT_RIGHT)    vx += speed;
      if (intent & INTENT_LEFT)     vx -= speed;
      if (intent & INTENT_UP)       vy += speed;
      if (intent & INTENT_DOWN)     vy -= speed;
      if (intent & INTENT_FORWARD)  vz += speed;
      if (intent & INTENT_BACKWARD) vz -= speed;
      matrix[baseIdx + OFFSET_VX] = vx;
      matrix[baseIdx + OFFSET_VY] = vy;
      matrix[baseIdx + OFFSET_VZ] = vz;
    }

    matrix[baseIdx + OFFSET_PX] += matrix[baseIdx + OFFSET_VX] * dt;
    matrix[baseIdx + OFFSET_PY] += matrix[baseIdx + OFFSET_VY] * dt;
    matrix[baseIdx + OFFSET_PZ] += matrix[baseIdx + OFFSET_VZ] * dt;
  }
}

namespace {

// Returns nullptr + throws a JS TypeError when `value` is not a
// Float32Array; otherwise returns the raw (zero-copy) data pointer.
float* CheckedF32Data(Napi::Env env, Napi::Value value, const char* name,
                      size_t* out_len) {
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
  *out_len = arr.ElementLength();
  return arr.Data();
}

int32_t* CheckedI32Data(Napi::Env env, Napi::Value value, const char* name,
                        size_t* out_len) {
  if (!value.IsTypedArray()) {
    Napi::TypeError::New(env, std::string(name) + " must be a TypedArray")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::TypedArray ta = value.As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_int32_array) {
    Napi::TypeError::New(env, std::string(name) + " must be an Int32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Int32Array arr = ta.As<Napi::Int32Array>();
  *out_len = arr.ElementLength();
  return arr.Data();
}

}  // namespace

// stepSimulation(floatMatrixView, entityCount, dt) -> boolean
// Exact zero-copy C++ simulation core entry point from ENGINE_IMPLEMENTATION_SPEC.md §4.
Napi::Value StepSimulation(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Air-tight parameter assertion checks before extracting pointers
  if (info.Length() < 3 || !info[0].IsTypedArray() || !info[1].IsNumber() ||
      !info[2].IsNumber()) {
    Napi::TypeError::New(
        env, "Parameters mismatched. Expecting (Float32Array, Uint32, Float).")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(
        env, "Parameters mismatched. Expecting (Float32Array, Uint32, Float).")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Float32Array jsArray = info[0].As<Napi::Float32Array>();
  size_t entityCount = info[1].As<Napi::Number>().Uint32Value();
  float dt = info[2].As<Napi::Number>().FloatValue();

  if (entityCount * SOA_STRIDE > jsArray.ElementLength()) {
    Napi::RangeError::New(
        env, "entityCount * SOA_STRIDE exceeds Float32Array length")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // True Zero-Copy Interception: Pull raw native hardware memory array references
  float* dataPointerFloat = jsArray.Data();
  int32_t* dataPointerInt = reinterpret_cast<int32_t*>(dataPointerFloat);

  // Invoke compiled simulation processing core
  NativeIntegrateSystem(dataPointerFloat, dataPointerInt, entityCount, dt);

  return Napi::Boolean::New(env, true);
}

// stepSimulationSoA(px, py, pz, vx, vy, vz, hp, entityCount, dt) -> boolean
// DoD Planar SoA branchless SIMD kernel entry point.
Napi::Value StepSimulationSoA(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 9 || !info[7].IsNumber() || !info[8].IsNumber()) {
    Napi::TypeError::New(
        env,
        "stepSimulationSoA expects (px, py, pz, vx, vy, vz, hp, entityCount, dt)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  size_t lens[6];
  float* p[6];
  const char* names[6] = {"px", "py", "pz", "vx", "vy", "vz"};
  for (int i = 0; i < 6; ++i) {
    p[i] = CheckedF32Data(env, info[i], names[i], &lens[i]);
    if (p[i] == nullptr) return env.Null();
  }
  size_t hpLen = 0;
  int32_t* hp = CheckedI32Data(env, info[6], "hp", &hpLen);
  if (hp == nullptr) return env.Null();

  const size_t entityCount = info[7].As<Napi::Number>().Uint32Value();
  const float dt = info[8].As<Napi::Number>().FloatValue();
  for (int i = 0; i < 6; ++i) {
    if (entityCount > lens[i]) {
      Napi::RangeError::New(env, "entityCount exceeds float array length")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
  }
  if (entityCount > hpLen) {
    Napi::RangeError::New(env, "entityCount exceeds hp array length")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  NativeIntegrateSoASystem(p[0], p[1], p[2], p[3], p[4], p[5], hp, entityCount,
                           dt);
  return Napi::Boolean::New(env, true);
}

// applyIntentsAndStep(floatMatrixView, entityCount, dt, baseSpeed) -> boolean
Napi::Value ApplyIntentsAndStep(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsTypedArray() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsNumber()) {
    Napi::TypeError::New(
        env,
        "applyIntentsAndStep expects (Float32Array, Uint32, Float, Float)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, "First argument must be a Float32Array")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Float32Array jsArray = info[0].As<Napi::Float32Array>();
  const size_t entityCount = info[1].As<Napi::Number>().Uint32Value();
  const float dt = info[2].As<Napi::Number>().FloatValue();
  const float baseSpeed = info[3].As<Napi::Number>().FloatValue();

  if (entityCount * SOA_STRIDE > jsArray.ElementLength()) {
    Napi::RangeError::New(
        env, "entityCount * SOA_STRIDE exceeds Float32Array length")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  float* dataPointerFloat = jsArray.Data();
  int32_t* dataPointerInt = reinterpret_cast<int32_t*>(dataPointerFloat);
  NativeApplyIntentsAndStep(dataPointerFloat, dataPointerInt, entityCount, dt,
                            baseSpeed);
  return Napi::Boolean::New(env, true);
}

// integrate(px, py, pz, vx, vy, vz, count, dt) -> undefined
// Harness A entry point: bulk integration over JS-owned SoA buffers.
Napi::Value Integrate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 8) {
    Napi::TypeError::New(env, "integrate expects 8 arguments")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t lens[6];
  float* p[6];
  const char* names[6] = {"px", "py", "pz", "vx", "vy", "vz"};
  for (int i = 0; i < 6; ++i) {
    p[i] = CheckedF32Data(env, info[i], names[i], &lens[i]);
    if (p[i] == nullptr) return env.Undefined();  // exception already thrown
  }
  if (!info[6].IsNumber() || !info[7].IsNumber()) {
    Napi::TypeError::New(env, "count and dt must be numbers")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const size_t count = info[6].As<Napi::Number>().Uint32Value();
  const float dt = info[7].As<Napi::Number>().FloatValue();
  for (int i = 0; i < 6; ++i) {
    if (count > lens[i]) {
      Napi::RangeError::New(env, "count exceeds input array length")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  // p[0..2] = px,py,pz (written); p[3..5] = vx,vy,vz (read).
  integrate_kernel(p[3], p[4], p[5], p[0], p[1], p[2], count, dt);
  return env.Undefined();
}

// noop() -> undefined. Empty N-API call used to isolate boundary overhead.
Napi::Value Noop(const Napi::CallbackInfo& info) {
  return info.Env().Undefined();
}

// ---- Harness B: pure C++ world -------------------------------------------

struct World {
  size_t n;
  std::vector<float> px, py, pz, vx, vy, vz;
  ~World() = default;
};

void DestroyWorld(Napi::Env /*env*/, World* world) { delete world; }

// createWorld(px, py, pz, vx, vy, vz) -> External<World>
// Copies the six SoA arrays into C++ storage ONCE at setup. Per-tick
// stepWorld then touches no JS memory at all.
Napi::Value CreateWorld(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 6) {
    Napi::TypeError::New(env, "createWorld expects 6 Float32Arrays")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t lens[6];
  const float* src[6];
  const char* names[6] = {"px", "py", "pz", "vx", "vy", "vz"};
  for (int i = 0; i < 6; ++i) {
    size_t len = 0;
    float* data = CheckedF32Data(env, info[i], names[i], &len);
    if (data == nullptr) return env.Undefined();
    lens[i] = len;
    src[i] = data;
  }
  for (int i = 1; i < 6; ++i) {
    if (lens[i] != lens[0]) {
      Napi::RangeError::New(env, "all input arrays must have equal length")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  World* world = new (std::nothrow) World();
  if (world == nullptr) {
    Napi::Error::New(env, "out of memory").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  world->n = lens[0];
  world->px.assign(src[0], src[0] + world->n);
  world->py.assign(src[1], src[1] + world->n);
  world->pz.assign(src[2], src[2] + world->n);
  world->vx.assign(src[3], src[3] + world->n);
  world->vy.assign(src[4], src[4] + world->n);
  world->vz.assign(src[5], src[5] + world->n);
  // Finalizer-owned: the world is freed when the External is GC'd.
  return Napi::External<World>::New(env, world, DestroyWorld);
}

World* CheckedWorld(Napi::Env env, Napi::Value value) {
  if (!value.IsExternal()) {
    Napi::TypeError::New(env, "expected a world handle")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return value.As<Napi::External<World>>().Data();
}

// stepWorld(handle, dt) -> undefined. One call per tick, no data movement.
Napi::Value StepWorld(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 2 || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "stepWorld(handle, dt) expected")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  World* world = CheckedWorld(env, info[0]);
  if (world == nullptr) return env.Undefined();
  const float dt = info[1].As<Napi::Number>().FloatValue();
  integrate_kernel(world->vx.data(), world->vy.data(), world->vz.data(),
                   world->px.data(), world->py.data(), world->pz.data(),
                   world->n, dt);
  return env.Undefined();
}

// copyPositions(handle, ox, oy, oz) -> undefined. Setup/teardown-time only:
// copies C++ positions out for the correctness check. Never on the hot path.
Napi::Value CopyPositions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 4) {
    Napi::TypeError::New(env, "copyPositions(handle, ox, oy, oz) expected")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  World* world = CheckedWorld(env, info[0]);
  if (world == nullptr) return env.Undefined();
  size_t lens[3];
  float* out[3];
  const char* names[3] = {"ox", "oy", "oz"};
  for (int i = 0; i < 3; ++i) {
    out[i] = CheckedF32Data(env, info[i + 1], names[i], &lens[i]);
    if (out[i] == nullptr) return env.Undefined();
    if (lens[i] < world->n) {
      Napi::RangeError::New(env, "output array too short")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  for (size_t i = 0; i < world->n; ++i) {
    out[0][i] = world->px[i];
    out[1][i] = world->py[i];
    out[2][i] = world->pz[i];
  }
  return env.Undefined();
}

// worldSize(handle) -> number.
Napi::Value DeleteWorld(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1) {
    Napi::TypeError::New(env, "deleteWorld(handle) expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  World* world = CheckedWorld(env, info[0]);
  if (world == nullptr) return env.Undefined();
  delete world;
  return env.Undefined();
}

Napi::Value WorldSize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1) {
    Napi::TypeError::New(env, "worldSize(handle) expected")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  World* world = CheckedWorld(env, info[0]);
  if (world == nullptr) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(world->n));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("integrate", Napi::Function::New(env, Integrate));
  exports.Set("stepSimulation", Napi::Function::New(env, StepSimulation));
  exports.Set("stepSimulationSoA", Napi::Function::New(env, StepSimulationSoA));
  exports.Set("applyIntentsAndStep", Napi::Function::New(env, ApplyIntentsAndStep));
  exports.Set("noop", Napi::Function::New(env, Noop));
  exports.Set("createWorld", Napi::Function::New(env, CreateWorld));
  exports.Set("stepWorld", Napi::Function::New(env, StepWorld));
  exports.Set("copyPositions", Napi::Function::New(env, CopyPositions));
  exports.Set("worldSize", Napi::Function::New(env, WorldSize));
  exports.Set("deleteWorld", Napi::Function::New(env, DeleteWorld));
  return exports;
}

NODE_API_MODULE(integrate, Init)

}  // namespace mmo_integrate

