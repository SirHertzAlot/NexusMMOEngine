// @mmo-engine/addon-physics — N-API shim (Phase 2).
//
// Includes ONLY native/physics_c_api.h (pure C ABI) — never Jolt
// headers. Jolt's compile defines, architecture flags and LTO settings
// live entirely inside the CMake build (see ../cmake/CMakeLists.txt),
// so this translation unit cannot introduce an ABI mismatch.
//
// Boundary shape (bulk, SoA, DOD):
// - addBodies/removeBodies: bulk queues; the native entity->BodyID map
//   never crosses to JS (callers pass u64 wire ids, never BodyIDs).
// - syncBodies -> step -> copyResults per tick. No per-entity N-API in
//   the hot loop: one call moves all bodies.
// - All native-world ops run on the JS thread, never concurrently.
//
// Exceptions are disabled (NAPI_DISABLE_CPP_EXCEPTIONS): invalid input
// throws a JS exception via ThrowAsJavaScriptException and returns
// undefined; no C++ exception ever crosses the boundary. Each method
// throws at most ONCE per call: validators return null on failure and
// the caller bails out immediately, because a second throw while an
// exception is already pending is fatal.

#include <napi.h>

#include <cstddef>
#include <cstdint>
#include <string>

#include "physics_c_api.h"

namespace mmo_physics {

namespace {

// --- typed-array validation (same pattern as addon-procgen) ---

const float *CheckedF32(Napi::Env env, Napi::Value value, const char *name,
                        size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a Float32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Float32Array arr = value.As<Napi::Float32Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env,
                          std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

float *CheckedF32Mut(Napi::Env env, Napi::Value value, const char *name,
                     size_t min_len) {
  return const_cast<float *>(CheckedF32(env, value, name, min_len));
}

const uint64_t *CheckedU64(Napi::Env env, Napi::Value value, const char *name,
                           size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_biguint64_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a BigUint64Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::BigUint64Array arr = value.As<Napi::BigUint64Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env,
                          std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

const uint8_t *CheckedU8(Napi::Env env, Napi::Value value, const char *name,
                         size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a Uint8Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Uint8Array arr = value.As<Napi::Uint8Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env,
                          std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

bool CheckedCount(Napi::Env env, Napi::Value value, int *out) {
  if (!value.IsNumber()) {
    Napi::TypeError::New(env, "count must be a number")
        .ThrowAsJavaScriptException();
    return false;
  }
  const double d = value.As<Napi::Number>().DoubleValue();
  if (d < 0 || d != static_cast<double>(static_cast<int>(d))) {
    Napi::RangeError::New(env, "count must be a non-negative int")
        .ThrowAsJavaScriptException();
    return false;
  }
  *out = static_cast<int>(d);
  return true;
}

} // namespace

class PhysicsWorldWrap : public Napi::ObjectWrap<PhysicsWorldWrap> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function ctor = DefineClass(
        env, "PhysicsWorld",
        {
            InstanceMethod("destroy", &PhysicsWorldWrap::Destroy),
            InstanceMethod("addBodies", &PhysicsWorldWrap::AddBodies),
            InstanceMethod("removeBodies", &PhysicsWorldWrap::RemoveBodies),
            InstanceMethod("syncBodies", &PhysicsWorldWrap::SyncBodies),
            InstanceMethod("step", &PhysicsWorldWrap::Step),
            InstanceMethod("copyResults", &PhysicsWorldWrap::CopyResults),
            InstanceMethod("bodyCount", &PhysicsWorldWrap::BodyCount),
            InstanceMethod("addTerrain", &PhysicsWorldWrap::AddTerrain),
            InstanceMethod("removeTerrain", &PhysicsWorldWrap::RemoveTerrain),
            InstanceMethod("terrainCount", &PhysicsWorldWrap::TerrainCount),
        });
    exports.Set("PhysicsWorld", ctor);
    return exports;
  }

  explicit PhysicsWorldWrap(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<PhysicsWorldWrap>(info),
        mWorld(mj_physics_create()) {}

  // Finalizer backstop: explicit destroy() is preferred, but a
  // forgotten world must still tear down its Jolt PhysicsSystem.
  ~PhysicsWorldWrap() override { destroyNative(); }

private:
  void destroyNative() {
    if (mWorld != nullptr) {
      mj_physics_destroy(mWorld);
      mWorld = nullptr;
    }
  }

  bool requireLive(Napi::Env env) {
    if (mWorld == nullptr) {
      Napi::Error::New(env, "PhysicsWorld has been destroyed")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }

  void Destroy(const Napi::CallbackInfo &info) {
    // Idempotent: safe to call in cleanup paths (afterEach, shutdown
    // hooks) even if the world was already destroyed. The finalizer
    // backstop covers the forgotten-destroy case.
    destroyNative();
  }

  // addBodies({ count, entityIds, shapeKind, halfExtents, radius, mass,
  //   friction, restitution, motionType, layer, pos, quat, linVel, angVel })
  void AddBodies(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    if (!info[0].IsObject()) {
      Napi::TypeError::New(env, "addBodies expects a descriptor object")
          .ThrowAsJavaScriptException();
      return;
    }
    Napi::Object d = info[0].As<Napi::Object>();
    int n = 0;
    if (!CheckedCount(env, d.Get("count"), &n) || n == 0)
      return; // validator threw, or nothing to do
    const size_t un = static_cast<size_t>(n);
    // NOTE: each validator throws at most once and returns null on
    // failure; bail out immediately so a second validator never throws
    // while an exception is already pending (fatal with
    // NAPI_DISABLE_CPP_EXCEPTIONS).
    const uint64_t *entity_ids = CheckedU64(env, d.Get("entityIds"), "entityIds", un);
    if (!entity_ids)
      return;
    const uint8_t *shape_kind = CheckedU8(env, d.Get("shapeKind"), "shapeKind", un);
    if (!shape_kind)
      return;
    const float *half_extents = CheckedF32(env, d.Get("halfExtents"), "halfExtents", 3 * un);
    if (!half_extents)
      return;
    const float *radius = CheckedF32(env, d.Get("radius"), "radius", un);
    if (!radius)
      return;
    const float *mass = CheckedF32(env, d.Get("mass"), "mass", un);
    if (!mass)
      return;
    const float *friction = CheckedF32(env, d.Get("friction"), "friction", un);
    if (!friction)
      return;
    const float *restitution = CheckedF32(env, d.Get("restitution"), "restitution", un);
    if (!restitution)
      return;
    const uint8_t *motion_type = CheckedU8(env, d.Get("motionType"), "motionType", un);
    if (!motion_type)
      return;
    const uint8_t *layer = CheckedU8(env, d.Get("layer"), "layer", un);
    if (!layer)
      return;
    const float *pos = CheckedF32(env, d.Get("pos"), "pos", 3 * un);
    if (!pos)
      return;
    const float *quat = CheckedF32(env, d.Get("quat"), "quat", 4 * un);
    if (!quat)
      return;
    const float *lin_vel = CheckedF32(env, d.Get("linVel"), "linVel", 3 * un);
    if (!lin_vel)
      return;
    const float *ang_vel = CheckedF32(env, d.Get("angVel"), "angVel", 3 * un);
    if (!ang_vel)
      return;
    mj_physics_add_bodies(mWorld, n, entity_ids, shape_kind, half_extents,
                          radius, mass, friction, restitution, motion_type,
                          layer, pos, quat, lin_vel, ang_vel);
  }

  void RemoveBodies(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    const uint64_t *entity_ids =
        CheckedU64(env, info[0], "entityIds", 0);
    if (!entity_ids)
      return;
    size_t len = info[0].As<Napi::TypedArray>().ElementLength();
    mj_physics_remove_bodies(mWorld, static_cast<int>(len), entity_ids);
  }

  // syncBodies(count, entityIds, pos, quat, linVel, angVel, flags, dt)
  void SyncBodies(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    int n = 0;
    if (!CheckedCount(env, info[0], &n) || n == 0)
      return;
    const size_t un = static_cast<size_t>(n);
    const uint64_t *entity_ids = CheckedU64(env, info[1], "entityIds", un);
    if (!entity_ids)
      return;
    const float *pos = CheckedF32(env, info[2], "pos", 3 * un);
    if (!pos)
      return;
    const float *quat = CheckedF32(env, info[3], "quat", 4 * un);
    if (!quat)
      return;
    const float *lin_vel = CheckedF32(env, info[4], "linVel", 3 * un);
    if (!lin_vel)
      return;
    const float *ang_vel = CheckedF32(env, info[5], "angVel", 3 * un);
    if (!ang_vel)
      return;
    const uint8_t *flags = CheckedU8(env, info[6], "flags", un);
    if (!flags)
      return;
    if (!info[7].IsNumber()) {
      Napi::TypeError::New(env, "dt must be a number")
          .ThrowAsJavaScriptException();
      return;
    }
    const float dt = info[7].As<Napi::Number>().FloatValue();
    mj_physics_sync_bodies(mWorld, n, entity_ids, pos, quat, lin_vel,
                           ang_vel, flags, dt);
  }

  void Step(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    if (!info[0].IsNumber() || !info[1].IsNumber()) {
      Napi::TypeError::New(env, "step(dt, subSteps) expects two numbers")
          .ThrowAsJavaScriptException();
      return;
    }
    const float dt = info[0].As<Napi::Number>().FloatValue();
    const int sub_steps = info[1].As<Napi::Number>().Int32Value();
    if (!(dt > 0.0f) || sub_steps < 1) {
      Napi::RangeError::New(env, "step requires dt > 0 and subSteps >= 1")
          .ThrowAsJavaScriptException();
      return;
    }
    mj_physics_step(mWorld, dt, sub_steps);
  }

  // copyResults(count, entityIds, pos, quat, linVel, angVel)
  void CopyResults(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    int n = 0;
    if (!CheckedCount(env, info[0], &n) || n == 0)
      return;
    const size_t un = static_cast<size_t>(n);
    const uint64_t *entity_ids = CheckedU64(env, info[1], "entityIds", un);
    if (!entity_ids)
      return;
    float *pos = CheckedF32Mut(env, info[2], "pos", 3 * un);
    if (!pos)
      return;
    float *quat = CheckedF32Mut(env, info[3], "quat", 4 * un);
    if (!quat)
      return;
    float *lin_vel = CheckedF32Mut(env, info[4], "linVel", 3 * un);
    if (!lin_vel)
      return;
    float *ang_vel = CheckedF32Mut(env, info[5], "angVel", 3 * un);
    if (!ang_vel)
      return;
    mj_physics_copy_results(mWorld, n, entity_ids, pos, quat, lin_vel,
                            ang_vel);
  }

  Napi::Value BodyCount(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_body_count(mWorld));
  }

  // addTerrain(key: bigint, originX, originZ, spacing, samples: Float32Array, friction) -> boolean
  Napi::Value AddTerrain(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    uint64_t key = 0;
    if (!CheckedKey(env, info[0], &key))
      return env.Undefined();
    if (!info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber() ||
        !info[5].IsNumber()) {
      Napi::TypeError::New(
          env, "addTerrain(key, originX, originZ, spacing, samples, friction)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const float *samples = CheckedF32(env, info[4], "samples", 16);
    if (!samples)
      return env.Undefined();
    const size_t len = info[4].As<Napi::Float32Array>().ElementLength();
    int side = 0;
    while (static_cast<size_t>(side + 1) * (side + 1) <= len)
      ++side;
    if (static_cast<size_t>(side) * side != len) {
      Napi::RangeError::New(env, "samples must be a square grid (side*side)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const int ok = mj_physics_add_terrain(
        mWorld, key, info[1].As<Napi::Number>().FloatValue(),
        info[2].As<Napi::Number>().FloatValue(),
        info[3].As<Napi::Number>().FloatValue(), side, samples,
        info[5].As<Napi::Number>().FloatValue());
    return Napi::Boolean::New(env, ok != 0);
  }

  void RemoveTerrain(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    uint64_t key = 0;
    if (!CheckedKey(env, info[0], &key))
      return;
    mj_physics_remove_terrain(mWorld, key);
  }

  Napi::Value TerrainCount(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_terrain_count(mWorld));
  }

  static bool CheckedKey(Napi::Env env, Napi::Value value, uint64_t *out) {
    if (!value.IsBigInt()) {
      Napi::TypeError::New(env, "terrain key must be a bigint")
          .ThrowAsJavaScriptException();
      return false;
    }
    bool lossless = false;
    *out = value.As<Napi::BigInt>().Uint64Value(&lossless);
    if (!lossless) {
      Napi::RangeError::New(env, "terrain key must fit in a u64")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }

  mj_physics_world_t *mWorld;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return PhysicsWorldWrap::Init(env, exports);
}

NODE_API_MODULE(physics, InitAll)

} // namespace mmo_physics
