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
#include <cmath>
#include <cstdint>
#include <string>

#include "physics_c_api.h"
// -ffast-math assumes no NaN or Inf, so std::isfinite/isnan fold to true; test the bits instead.
static inline bool fp_finite(double x) { unsigned long long b; __builtin_memcpy(&b, &x, sizeof b); return (b & 0x7ff0000000000000ULL) != 0x7ff0000000000000ULL; }
static inline bool fp_nan(double x) { unsigned long long b; __builtin_memcpy(&b, &x, sizeof b); return (b & 0x7ff0000000000000ULL) == 0x7ff0000000000000ULL && (b & 0x000fffffffffffffULL) != 0; }

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

// Phase 2 (zero-copy): bitECS entity indices for the component arrays.
const int32_t *CheckedI32(Napi::Env env, Napi::Value value, const char *name,
                          size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_int32_array) {
    Napi::TypeError::New(env, std::string(name) + " must be an Int32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Int32Array arr = value.As<Napi::Int32Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env,
                          std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

// Max eid in the first n entries (for component-array bounds checks).
// Returns -1 when n == 0. Negative eids are rejected by the caller.
int32_t MaxEid(const int32_t *eids, size_t n) {
  int32_t m = -1;
  for (size_t i = 0; i < n; ++i) {
    if (eids[i] > m)
      m = eids[i];
  }
  return m;
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
            InstanceValue("bodyCapacity", Napi::Number::New(env, mj_physics_body_capacity())),
            InstanceMethod("addTerrain", &PhysicsWorldWrap::AddTerrain),
            InstanceMethod("removeTerrain", &PhysicsWorldWrap::RemoveTerrain),
            InstanceMethod("terrainCount", &PhysicsWorldWrap::TerrainCount),
            InstanceMethod("addRagdolls", &PhysicsWorldWrap::AddRagdolls),
            InstanceMethod("removeRagdolls", &PhysicsWorldWrap::RemoveRagdolls),
            InstanceMethod("copyRagdollRoots", &PhysicsWorldWrap::CopyRagdollRoots),
            InstanceMethod("copyRagdollBodies", &PhysicsWorldWrap::CopyRagdollBodies),
            InstanceMethod("ragdollCount", &PhysicsWorldWrap::RagdollCount),
            InstanceMethod("ragdollUnits", &PhysicsWorldWrap::RagdollUnits),
            InstanceMethod("ragdollBudget", &PhysicsWorldWrap::RagdollBudget),
            InstanceMethod("setRagdollBudget", &PhysicsWorldWrap::SetRagdollBudget),
            InstanceMethod("lastStepErrors", &PhysicsWorldWrap::LastStepErrors),
            InstanceMethod("sleepThreshold", &PhysicsWorldWrap::SleepThreshold),
            InstanceMethod("setSleepThreshold", &PhysicsWorldWrap::SetSleepThreshold),
            InstanceMethod("ragdollActiveBodies", &PhysicsWorldWrap::RagdollActiveBodies),
            InstanceMethod("addCharacter", &PhysicsWorldWrap::AddCharacter),
            InstanceMethod("removeCharacter", &PhysicsWorldWrap::RemoveCharacter),
            InstanceMethod("setCharacterVelocity", &PhysicsWorldWrap::SetCharacterVelocity),
            InstanceMethod("updateCharacter", &PhysicsWorldWrap::UpdateCharacter),
            InstanceMethod("characterPosition", &PhysicsWorldWrap::CharacterPosition),
            InstanceMethod("characterCount", &PhysicsWorldWrap::CharacterCount),
        });
    exports.Set("PhysicsWorld", ctor);
    return exports;
  }

  // Jolt thread pools are capped at 64 workers. 0 keeps the single thread.
  static constexpr int kMaxThreads = 64;

  // The optional threads of createWorld({ threads }). Returns nullptr after
  // throwing a JS TypeError or RangeError, so no world is made for a bad value.
  static mj_physics_world_t *WorldFromArgs(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    int threads = 0;
    if (info.Length() > 0 && !info[0].IsUndefined()) {
      if (!info[0].IsNumber()) {
        Napi::TypeError::New(env,
                             "createWorld({ threads }): threads must be a number")
            .ThrowAsJavaScriptException();
        return nullptr;
      }
      const double v = info[0].As<Napi::Number>().DoubleValue();
      if (!fp_finite(v) || v != std::floor(v) || v < 0.0 ||
          v > static_cast<double>(kMaxThreads)) {
        Napi::RangeError::New(
            env, "createWorld({ threads }): threads must be an integer from 0 to 64")
            .ThrowAsJavaScriptException();
        return nullptr;
      }
      threads = static_cast<int>(v);
    }
    return mj_physics_create_with_threads(threads);
  }

  explicit PhysicsWorldWrap(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<PhysicsWorldWrap>(info),
        mWorld(WorldFromArgs(info)) {}

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
  Napi::Value AddBodies(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    if (!info[0].IsObject()) {
      Napi::TypeError::New(env, "addBodies expects a descriptor object")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object d = info[0].As<Napi::Object>();
    int n = 0;
    if (!CheckedCount(env, d.Get("count"), &n))
      return env.Undefined(); // validator threw
    if (n == 0)
      return Napi::Number::New(env, 0);
    const size_t un = static_cast<size_t>(n);
    // NOTE: each validator throws at most once and returns null on
    // failure; bail out immediately so a second validator never throws
    // while an exception is already pending (fatal with
    // NAPI_DISABLE_CPP_EXCEPTIONS).
    const uint64_t *entity_ids = CheckedU64(env, d.Get("entityIds"), "entityIds", un);
    if (!entity_ids)
      return env.Undefined();
    const uint8_t *shape_kind = CheckedU8(env, d.Get("shapeKind"), "shapeKind", un);
    if (!shape_kind)
      return env.Undefined();
    const float *half_extents = CheckedF32(env, d.Get("halfExtents"), "halfExtents", 3 * un);
    if (!half_extents)
      return env.Undefined();
    const float *radius = CheckedF32(env, d.Get("radius"), "radius", un);
    if (!radius)
      return env.Undefined();
    const float *mass = CheckedF32(env, d.Get("mass"), "mass", un);
    if (!mass)
      return env.Undefined();
    const float *friction = CheckedF32(env, d.Get("friction"), "friction", un);
    if (!friction)
      return env.Undefined();
    const float *restitution = CheckedF32(env, d.Get("restitution"), "restitution", un);
    if (!restitution)
      return env.Undefined();
    const uint8_t *motion_type = CheckedU8(env, d.Get("motionType"), "motionType", un);
    if (!motion_type)
      return env.Undefined();
    const uint8_t *layer = CheckedU8(env, d.Get("layer"), "layer", un);
    if (!layer)
      return env.Undefined();
    const float *pos = CheckedF32(env, d.Get("pos"), "pos", 3 * un);
    if (!pos)
      return env.Undefined();
    const float *quat = CheckedF32(env, d.Get("quat"), "quat", 4 * un);
    if (!quat)
      return env.Undefined();
    const float *lin_vel = CheckedF32(env, d.Get("linVel"), "linVel", 3 * un);
    if (!lin_vel)
      return env.Undefined();
    const float *ang_vel = CheckedF32(env, d.Get("angVel"), "angVel", 3 * un);
    if (!ang_vel)
      return env.Undefined();
    const int dropped = mj_physics_add_bodies(
        mWorld, n, entity_ids, shape_kind, half_extents, radius, mass, friction,
        restitution, motion_type, layer, pos, quat, lin_vel, ang_vel);
    return Napi::Number::New(env, dropped);
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

  // Phase 2 (zero-copy):
  // syncBodies(count, entityIds, eids, px, py, pz, qx, qy, qz, qw, flags, dt)
  // px..qw are the SAB-backed bitECS Transform component arrays, indexed
  // by eids[i]. Component arrays must cover max(eids) or the call throws
  // (an out-of-range eid would otherwise write outside the caller's
  // intent — the arrays are shared, so bounds matter).
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
    const int32_t *eids = CheckedI32(env, info[2], "eids", un);
    if (!eids)
      return;
    const int32_t max_eid = MaxEid(eids, un);
    if (max_eid < 0) {
      Napi::RangeError::New(env, "eids must be non-negative")
          .ThrowAsJavaScriptException();
      return;
    }
    const size_t need = static_cast<size_t>(max_eid) + 1;
    const float *px = CheckedF32(env, info[3], "px", need);
    if (!px)
      return;
    const float *py = CheckedF32(env, info[4], "py", need);
    if (!py)
      return;
    const float *pz = CheckedF32(env, info[5], "pz", need);
    if (!pz)
      return;
    const float *qx = CheckedF32(env, info[6], "qx", need);
    if (!qx)
      return;
    const float *qy = CheckedF32(env, info[7], "qy", need);
    if (!qy)
      return;
    const float *qz = CheckedF32(env, info[8], "qz", need);
    if (!qz)
      return;
    const float *qw = CheckedF32(env, info[9], "qw", need);
    if (!qw)
      return;
    const uint8_t *flags = CheckedU8(env, info[10], "flags", un);
    if (!flags)
      return;
    if (!info[11].IsNumber()) {
      Napi::TypeError::New(env, "dt must be a number")
          .ThrowAsJavaScriptException();
      return;
    }
    const float dt = info[11].As<Napi::Number>().FloatValue();
    mj_physics_sync_bodies(mWorld, n, entity_ids, eids, px, py, pz, qx, qy,
                           qz, qw, flags, dt);
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

  // Phase 2 (zero-copy):
  // copyResults(count, entityIds, eids,
  //             px, py, pz, qx, qy, qz, qw, lx, ly, lz, ax, ay, az)
  // px..az are the SAB-backed bitECS Transform + Velocity component
  // arrays, indexed by eids[i]. C++ writes results directly into them;
  // there is no dense scratch array and no JS copy-back loop.
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
    const int32_t *eids = CheckedI32(env, info[2], "eids", un);
    if (!eids)
      return;
    const int32_t max_eid = MaxEid(eids, un);
    if (max_eid < 0) {
      Napi::RangeError::New(env, "eids must be non-negative")
          .ThrowAsJavaScriptException();
      return;
    }
    const size_t need = static_cast<size_t>(max_eid) + 1;
    float *px = CheckedF32Mut(env, info[3], "px", need);
    if (!px)
      return;
    float *py = CheckedF32Mut(env, info[4], "py", need);
    if (!py)
      return;
    float *pz = CheckedF32Mut(env, info[5], "pz", need);
    if (!pz)
      return;
    float *qx = CheckedF32Mut(env, info[6], "qx", need);
    if (!qx)
      return;
    float *qy = CheckedF32Mut(env, info[7], "qy", need);
    if (!qy)
      return;
    float *qz = CheckedF32Mut(env, info[8], "qz", need);
    if (!qz)
      return;
    float *qw = CheckedF32Mut(env, info[9], "qw", need);
    if (!qw)
      return;
    float *lx = CheckedF32Mut(env, info[10], "lx", need);
    if (!lx)
      return;
    float *ly = CheckedF32Mut(env, info[11], "ly", need);
    if (!ly)
      return;
    float *lz = CheckedF32Mut(env, info[12], "lz", need);
    if (!lz)
      return;
    float *ax = CheckedF32Mut(env, info[13], "ax", need);
    if (!ax)
      return;
    float *ay = CheckedF32Mut(env, info[14], "ay", need);
    if (!ay)
      return;
    float *az = CheckedF32Mut(env, info[15], "az", need);
    if (!az)
      return;
    mj_physics_copy_results(mWorld, n, entity_ids, eids, px, py, pz, qx, qy,
                            qz, qw, lx, ly, lz, ax, ay, az);
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

  // addRagdolls(ids: BigUint64Array, rigKind: number, pos: Float32Array)
  // pos holds 3 floats per id: where each rig's root is dropped. Throws a
  // RangeError if the batch would exceed the world's ragdoll budget, repeats an
  // id or reuses one already present, or the rig kind is unknown. A refused
  // batch changes nothing.
  void AddRagdolls(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    if (info.Length() < 3 || !info[1].IsNumber()) {
      Napi::TypeError::New(env, "addRagdolls(ids, rigKind, pos)")
          .ThrowAsJavaScriptException();
      return;
    }
    const uint64_t *ids = CheckedU64(env, info[0], "ids", 0);
    if (!ids)
      return;
    const size_t len = info[0].As<Napi::TypedArray>().ElementLength();
    const float *pos = CheckedF32(env, info[2], "pos", 3 * len);
    if (!pos)
      return;
    const int rig_kind = info[1].As<Napi::Number>().Int32Value();
    const int status = mj_physics_add_ragdolls(
        mWorld, static_cast<int>(len), ids, rig_kind, pos);
    switch (status) {
    case MJ_RAGDOLL_OK:
      return;
    case MJ_RAGDOLL_OVER_BUDGET:
      Napi::RangeError::New(
          env, "ragdoll budget exceeded: " +
                   std::to_string(mj_physics_ragdoll_units(mWorld)) + " of " +
                   std::to_string(mj_physics_ragdoll_budget(mWorld)) +
                   " units in use")
          .ThrowAsJavaScriptException();
      return;
    case MJ_RAGDOLL_DUPLICATE:
      Napi::RangeError::New(
          env, "ragdoll id is already present or repeated in the batch")
          .ThrowAsJavaScriptException();
      return;
    case MJ_RAGDOLL_BAD_KIND:
      Napi::RangeError::New(
          env, "unknown rig kind: use RagdollRig.Full or RagdollRig.Light")
          .ThrowAsJavaScriptException();
      return;
    default:
      Napi::Error::New(env, "could not build a ragdoll rig")
          .ThrowAsJavaScriptException();
      return;
    }
  }

  // removeRagdolls(ids: BigUint64Array). Unknown ids are ignored.
  void RemoveRagdolls(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    const uint64_t *ids = CheckedU64(env, info[0], "ids", 0);
    if (!ids)
      return;
    const size_t len = info[0].As<Napi::TypedArray>().ElementLength();
    mj_physics_remove_ragdolls(mWorld, static_cast<int>(len), ids);
  }

  // copyRagdollRoots(ids: BigUint64Array, pos: Float32Array): writes each rig's
  // root position into pos (3 floats per id). An unknown id gives NaN.
  void CopyRagdollRoots(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    if (info.Length() < 2) {
      Napi::TypeError::New(env, "copyRagdollRoots(ids, pos)")
          .ThrowAsJavaScriptException();
      return;
    }
    const uint64_t *ids = CheckedU64(env, info[0], "ids", 0);
    if (!ids)
      return;
    const size_t len = info[0].As<Napi::TypedArray>().ElementLength();
    float *pos = CheckedF32Mut(env, info[1], "pos", 3 * len);
    if (!pos)
      return;
    mj_physics_copy_ragdoll_roots(mWorld, static_cast<int>(len), ids, pos);
  }

  // copyRagdollBodies(ids: BigUint64Array, out: Float32Array): number. Writes 13
  // floats per body of each rig, in ids order (see index.d.ts), and returns the
  // floats written. An unknown id, or an out too short for all of them, throws a
  // RangeError and writes nothing.
  Napi::Value CopyRagdollBodies(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    if (info.Length() < 2) {
      Napi::TypeError::New(env, "copyRagdollBodies(ids, out)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (!info[0].IsTypedArray() ||
        info[0].As<Napi::TypedArray>().TypedArrayType() !=
            napi_biguint64_array) {
      Napi::TypeError::New(env, "ids must be a BigUint64Array")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (!info[1].IsTypedArray() ||
        info[1].As<Napi::TypedArray>().TypedArrayType() != napi_float32_array) {
      Napi::TypeError::New(env, "out must be a Float32Array")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // An empty typed array may have no data pointer. That is fine: with no ids,
    // or no room, the C side never reads or writes through it.
    const Napi::BigUint64Array ids = info[0].As<Napi::BigUint64Array>();
    Napi::Float32Array out = info[1].As<Napi::Float32Array>();
    const int written = mj_physics_copy_ragdoll_bodies(
        mWorld, static_cast<int>(ids.ElementLength()), ids.Data(), out.Data(),
        static_cast<int>(out.ElementLength()));
    if (written < 0) {
      Napi::RangeError::New(env, "copyRagdollBodies: an id is unknown, or out is too short for every body of those rigs")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return Napi::Number::New(env, written);
  }

  Napi::Value RagdollCount(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_ragdoll_count(mWorld));
  }

  Napi::Value RagdollUnits(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_ragdoll_units(mWorld));
  }

  // sleepThreshold(): the world's point-velocity sleep threshold, in m/s.
  Napi::Value SleepThreshold(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_sleep_threshold(mWorld));
  }

  // setSleepThreshold(metresPerSecond: number). A world starts at 0.05 (the sleep
  // benchmark's choice; Jolt's own is 0.03); a larger value lets resting bodies sleep sooner.
  void SetSleepThreshold(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    if (info.Length() < 1 || !info[0].IsNumber()) {
      Napi::TypeError::New(env, "setSleepThreshold(metresPerSecond)")
          .ThrowAsJavaScriptException();
      return;
    }
    const double v = info[0].As<Napi::Number>().DoubleValue();
    if (!fp_finite(v) || v < 0.0) {
      Napi::RangeError::New(env, "sleep threshold must be a finite number >= 0")
          .ThrowAsJavaScriptException();
      return;
    }
    mj_physics_set_sleep_threshold(mWorld, static_cast<float>(v));
  }

  // ragdollActiveBodies(): ragdoll bodies that are simulating (not asleep).
  Napi::Value RagdollActiveBodies(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_ragdoll_active_bodies(mWorld));
  }

  Napi::Value RagdollBudget(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_ragdoll_budget(mWorld));
  }

  // setRagdollBudget(units: number). A lower budget refuses new rigs; rigs
  // already present stay.
  void SetRagdollBudget(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    if (info.Length() < 1 || !info[0].IsNumber()) {
      Napi::TypeError::New(env, "setRagdollBudget(units)")
          .ThrowAsJavaScriptException();
      return;
    }
    const double units = info[0].As<Napi::Number>().DoubleValue();
    if (!(units >= 0.0) || units > 2147483647.0 || std::floor(units) != units) {
      Napi::RangeError::New(env, "ragdoll budget must be a whole number >= 0")
          .ThrowAsJavaScriptException();
      return;
    }
    mj_physics_set_ragdoll_budget(mWorld, static_cast<int>(units));
  }

  // lastStepErrors(): Jolt's update errors for the last step(), OR-ed over its
  // substeps, as UpdateError bits. Zero when every contact was kept.
  Napi::Value LastStepErrors(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_physics_last_step_errors(mWorld));
  }

  // addCharacter(id: bigint, radius, halfHeight, x, y, z) -> boolean
  Napi::Value AddCharacter(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    uint64_t id = 0;
    if (!CheckedKey(env, info[0], &id, "character id"))
      return env.Undefined();
    if (!info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber() ||
        !info[4].IsNumber() || !info[5].IsNumber()) {
      Napi::TypeError::New(env, "addCharacter(id, radius, halfHeight, x, y, z)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const int ok = mj_character_add(
        mWorld, id, info[1].As<Napi::Number>().FloatValue(),
        info[2].As<Napi::Number>().FloatValue(),
        info[3].As<Napi::Number>().FloatValue(),
        info[4].As<Napi::Number>().FloatValue(),
        info[5].As<Napi::Number>().FloatValue());
    return Napi::Boolean::New(env, ok != 0);
  }

  // removeCharacter(id: bigint). Unknown ids are ignored.
  void RemoveCharacter(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    uint64_t id = 0;
    if (!CheckedKey(env, info[0], &id, "character id"))
      return;
    mj_character_remove(mWorld, id);
  }

  // setCharacterVelocity(id: bigint, vx, vy, vz)
  void SetCharacterVelocity(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    uint64_t id = 0;
    if (!CheckedKey(env, info[0], &id, "character id"))
      return;
    if (!info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber()) {
      Napi::TypeError::New(env, "setCharacterVelocity(id, vx, vy, vz)")
          .ThrowAsJavaScriptException();
      return;
    }
    mj_character_set_velocity(mWorld, id,
                              info[1].As<Napi::Number>().FloatValue(),
                              info[2].As<Napi::Number>().FloatValue(),
                              info[3].As<Napi::Number>().FloatValue());
  }

  // updateCharacter(id: bigint, dt, gx, gy, gz): one Jolt update of the character.
  void UpdateCharacter(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return;
    uint64_t id = 0;
    if (!CheckedKey(env, info[0], &id, "character id"))
      return;
    if (!info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber() ||
        !info[4].IsNumber()) {
      Napi::TypeError::New(env, "updateCharacter(id, dt, gx, gy, gz)")
          .ThrowAsJavaScriptException();
      return;
    }
    mj_character_update(mWorld, id, info[1].As<Napi::Number>().FloatValue(),
                        info[2].As<Napi::Number>().FloatValue(),
                        info[3].As<Napi::Number>().FloatValue(),
                        info[4].As<Napi::Number>().FloatValue());
  }

  // characterPosition(id: bigint) -> [x, y, z]; each axis NaN for an unknown id.
  Napi::Value CharacterPosition(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    uint64_t id = 0;
    if (!CheckedKey(env, info[0], &id, "character id"))
      return env.Undefined();
    float p[3] = {0.0f, 0.0f, 0.0f};
    mj_character_position(mWorld, id, p);
    Napi::Array out = Napi::Array::New(env, 3);
    for (uint32_t i = 0; i < 3; ++i)
      out.Set(i, Napi::Number::New(env, p[i]));
    return out;
  }

  Napi::Value CharacterCount(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!requireLive(env))
      return env.Undefined();
    return Napi::Number::New(env, mj_character_count(mWorld));
  }

  // `what` names the id in the error text: terrain keys and character ids
  // share this check.
  static bool CheckedKey(Napi::Env env, Napi::Value value, uint64_t *out,
                         const char *what = "terrain key") {
    if (!value.IsBigInt()) {
      Napi::TypeError::New(env, std::string(what) + " must be a bigint")
          .ThrowAsJavaScriptException();
      return false;
    }
    bool lossless = false;
    *out = value.As<Napi::BigInt>().Uint64Value(&lossless);
    if (!lossless) {
      Napi::RangeError::New(env, std::string(what) + " must fit in a u64")
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
