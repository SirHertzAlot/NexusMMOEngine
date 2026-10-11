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

#include <cstddef>
#include <cstdint>
#include <vector>

namespace mmo_integrate {

// The single integration kernel shared by both harnesses.
// position += velocity * dt, SoA, f32 — mirrors IntegrateSystem (slice 1.2).
inline void integrate_kernel(const float* vx, const float* vy, const float* vz,
                             float* px, float* py, float* pz, size_t n,
                             float dt) {
  for (size_t i = 0; i < n; ++i) {
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
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

}  // namespace

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
