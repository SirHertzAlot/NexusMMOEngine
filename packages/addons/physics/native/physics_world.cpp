// @mmo-engine/addon-physics — native Jolt world (Phase 2).
//
// Compiled by CMake (see ../cmake/CMakeLists.txt), NOT by node-gyp, so
// Jolt's compile defines, architecture flags and LTO settings apply
// uniformly to Jolt and to this translation unit. Exposed to the N-API
// shim through the C ABI in physics_c_api.h — the shim never includes
// Jolt headers, so no define/flag replication is needed there.
//
// Threading: every exported function must be called from the JS thread
// only. Jolt's internal job threads are its own business; the world is
// never touched concurrently from two threads.
//
// Determinism: Jolt is deterministic given the same binary and the
// same mutating-API call order (Jolt Docs/Architecture.md,
// "Deterministic Simulation"). The JS side sorts entity ids before
// addBodies so insertion order is deterministic regardless of bitECS
// query order. Broadphase queries, contact listeners and
// GetActiveBodies() are deliberately NOT used here — Jolt documents
// their result ordering as nondeterministic (multithreaded), so any
// future use must collect-and-sort before the results feed game logic.

#include "physics_c_api.h"

#include <Jolt/Jolt.h>

#include <Jolt/Core/Factory.h>
#include <Jolt/Core/JobSystemSingleThreaded.h>
#include <Jolt/Core/TempAllocator.h>
#include <Jolt/Physics/Body/BodyCreationSettings.h>
#include <Jolt/Physics/Body/BodyInterface.h>
#include <Jolt/Physics/Collision/BroadPhase/BroadPhaseLayer.h>
#include <Jolt/Physics/Collision/ObjectLayerPairFilterTable.h>
#include <Jolt/Physics/Collision/Shape/BoxShape.h>
#include <Jolt/Physics/Collision/Shape/HeightFieldShape.h>
#include <Jolt/Physics/Collision/Shape/SphereShape.h>
#include <Jolt/Physics/Collision/Shape/CapsuleShape.h>
#include <Jolt/Physics/Collision/Shape/RotatedTranslatedShape.h>
#include <Jolt/Physics/PhysicsSystem.h>
#include <Jolt/RegisterTypes.h>

#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace {

// Jolt global setup exactly once per process (RegisterDefaultAllocator
// + type registration + factory). std::call_once: creating two physics
// worlds in one process is safe.
void InitJoltOnce() {
  static std::once_flag flag;
  std::call_once(flag, []() {
    JPH::RegisterDefaultAllocator();
    JPH::Factory::sInstance = new JPH::Factory();
    JPH::RegisterTypes();
  });
}

// --- Layers ----------------------------------------------------------------
// Two object layers, following the HelloWorld sample pattern:
//   0 = NON_MOVING (static geometry; never collides with itself)
//   1 = MOVING     (dynamic/kinematic bodies; collides with everything)
// The JS BodyConfig.layer maps: 0 -> NON_MOVING, anything else -> MOVING.

namespace Layers {
static constexpr JPH::ObjectLayer NON_MOVING = 0;
static constexpr JPH::ObjectLayer MOVING = 1;
static constexpr JPH::ObjectLayer NUM_LAYERS = 2;
} // namespace Layers

class ObjectLayerPairFilterImpl : public JPH::ObjectLayerPairFilter {
public:
  bool ShouldCollide(JPH::ObjectLayer inObject1,
                     JPH::ObjectLayer inObject2) const override {
    // Static-vs-static pairs never need collision detection.
    return inObject1 == Layers::MOVING || inObject2 == Layers::MOVING;
  }
};

class BPLayerInterfaceImpl : public JPH::BroadPhaseLayerInterface {
public:
  BPLayerInterfaceImpl() {
    // Map each object layer to a broadphase layer (classic HelloWorld
    // sample pattern: no heap allocation, no leak).
    mObjectToBroadPhase[Layers::NON_MOVING] = JPH::BroadPhaseLayer(0);
    mObjectToBroadPhase[Layers::MOVING] = JPH::BroadPhaseLayer(1);
  }
  JPH::uint GetNumBroadPhaseLayers() const override { return 2; }
  JPH::BroadPhaseLayer GetBroadPhaseLayer(
      JPH::ObjectLayer inLayer) const override {
    JPH_ASSERT(inLayer < Layers::NUM_LAYERS);
    return mObjectToBroadPhase[inLayer];
  }
#if defined(JPH_EXTERNAL_PROFILE) || defined(JPH_PROFILE_ENABLED)
  const char *GetBroadPhaseLayerName(
      JPH::BroadPhaseLayer inLayer) const override {
    return inLayer == JPH::BroadPhaseLayer(0) ? "NON_MOVING" : "MOVING";
  }
#endif
private:
  JPH::BroadPhaseLayer mObjectToBroadPhase[Layers::NUM_LAYERS];
};

class ObjectVsBroadPhaseLayerFilterImpl
    : public JPH::ObjectVsBroadPhaseLayerFilter {
public:
  bool ShouldCollide(JPH::ObjectLayer inLayer1,
                     JPH::BroadPhaseLayer inLayer2) const override {
    // NON_MOVING objects only need to check against the MOVING
    // broadphase layer (they never collide with each other); MOVING
    // objects check against everything.
    if (inLayer1 == Layers::NON_MOVING)
      return inLayer2 == JPH::BroadPhaseLayer(1);
    return true;
  }
};

} // namespace

// --- Native world ------------------------------------------------------------

struct mj_physics_world {
  static constexpr int kMaxBodies = 65536;
  static constexpr int kNumBodyMutexes = 0;
  static constexpr int kMaxBodyPairs = 65536;
  static constexpr int kMaxContactConstraints = 10240;
  static constexpr size_t kTempAllocatorBytes = 10 * 1024 * 1024;

  struct BodyRecord {
    JPH::BodyID body_id;
    uint8_t motion_type;
  };

  mj_physics_world() {
    InitJoltOnce();
    mTempAllocator =
        std::make_unique<JPH::TempAllocatorImpl>(kTempAllocatorBytes);
    // Single-threaded job system: maximum determinism, no per-world
    // thread-pool overhead. A thread pool is a future tuning knob if
    // physics ever shows up in tick profiles (see README).
    mJobSystem =
        std::make_unique<JPH::JobSystemSingleThreaded>(JPH::cMaxPhysicsJobs);
    mSystem = std::make_unique<JPH::PhysicsSystem>();
    mSystem->Init(kMaxBodies, kNumBodyMutexes, kMaxBodyPairs,
                  kMaxContactConstraints, mBroadPhaseLayerInterface,
                  mObjectVsBroadPhaseLayerFilter, mObjectLayerPairFilter);
    mSystem->SetGravity(JPH::Vec3(0.0f, -9.81f, 0.0f));
  }

  mj_physics_world(const mj_physics_world &) = delete;
  mj_physics_world &operator=(const mj_physics_world &) = delete;

  void addBodies(int n, const uint64_t *entity_ids,
                 const uint8_t *shape_kind, const float *half_extents,
                 const float *radius, const float *mass,
                 const float *friction, const float *restitution,
                 const uint8_t *motion_type, const uint8_t *layer,
                 const float *pos, const float *quat, const float *lin_vel,
                 const float *ang_vel) {
    JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    for (int i = 0; i < n; ++i) {
      const uint64_t eid = entity_ids[i];
      if (mBodies.find(eid) != mBodies.end())
        continue; // already present: idempotent add

      // Heap-allocated, ref-counted shape settings: never a
      // stack-allocated settings object, so the SetEmbedded() footgun
      // (bad-free at scope exit, caught via ASan in the Phase 2 spike)
      // cannot recur here.
      JPH::Ref<JPH::ShapeSettings> settings;
      if (shape_kind[i] == MJ_SHAPE_SPHERE) {
        settings = new JPH::SphereShapeSettings(radius[i] > 0.0f ? radius[i] : 0.5f);
      } else if (shape_kind[i] == MJ_SHAPE_CAPSULE) {
        // Upright, lifted so its base sits at the body's origin (the
        // feet): a character's transform is where it stands.
        const float r = radius[i] > 0.0f ? radius[i] : 0.35f;
        const float half = half_extents[3 * i + 1] > 0.0f ? half_extents[3 * i + 1] : 0.55f;
        settings = new JPH::RotatedTranslatedShapeSettings(
            JPH::Vec3(0.0f, half + r, 0.0f), JPH::Quat::sIdentity(),
            new JPH::CapsuleShapeSettings(half, r));
      } else {
        settings = new JPH::BoxShapeSettings(
            JPH::Vec3(half_extents[3 * i], half_extents[3 * i + 1],
                      half_extents[3 * i + 2]));
      }

      JPH::EMotionType motion = JPH::EMotionType::Static;
      if (motion_type[i] == MJ_MOTION_DYNAMIC)
        motion = JPH::EMotionType::Dynamic;
      else if (motion_type[i] == MJ_MOTION_KINEMATIC)
        motion = JPH::EMotionType::Kinematic;

      const JPH::ObjectLayer object_layer =
          layer[i] == 0 ? Layers::NON_MOVING : Layers::MOVING;

      JPH::BodyCreationSettings bcs(
          settings,
          JPH::RVec3(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]),
          JPH::Quat(quat[4 * i], quat[4 * i + 1], quat[4 * i + 2],
                    quat[4 * i + 3]),
          motion, object_layer);
      bcs.mFriction = friction[i];
      bcs.mRestitution = restitution[i];
      // Take the requested mass; Jolt derives the inertia tensor from
      // the shape density and scales it to that mass.
      bcs.mOverrideMassProperties =
          JPH::EOverrideMassProperties::CalculateInertia;
      bcs.mMassPropertiesOverride.mMass =
          mass[i] > 0.0f ? mass[i] : 1.0f;

      JPH::Body *body = bi.CreateBody(bcs);
      if (body == nullptr)
        continue; // invalid config (e.g. degenerate shape): skip loudly
                  // via bodyCount() mismatch rather than crashing
      bi.AddBody(body->GetID(), JPH::EActivation::Activate);
      bi.SetLinearVelocity(
          body->GetID(),
          JPH::Vec3(lin_vel[3 * i], lin_vel[3 * i + 1], lin_vel[3 * i + 2]));
      bi.SetAngularVelocity(
          body->GetID(),
          JPH::Vec3(ang_vel[3 * i], ang_vel[3 * i + 1], ang_vel[3 * i + 2]));
      mBodies.emplace(eid, BodyRecord{body->GetID(), motion_type[i]});
    }
  }

  void removeBodies(int n, const uint64_t *entity_ids) {
    JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    for (int i = 0; i < n; ++i) {
      auto it = mBodies.find(entity_ids[i]);
      if (it == mBodies.end())
        continue; // idempotent remove
      bi.RemoveBody(it->second.body_id);
      bi.DestroyBody(it->second.body_id);
      mBodies.erase(it);
    }
  }

  // Phase 2 (zero-copy boundary): sync/copy read and write the
  // SAB-backed bitECS component arrays DIRECTLY. `entity_ids[i]` is the
  // wire id used for the native body lookup; `eids[i]` is the bitECS
  // entity index into the component arrays (px[e], py[e], ...). No
  // dense scratch arrays, no JS copy loops — the C++ side scatters
  // into the component arrays the game already reads.
  void syncBodies(int n, const uint64_t *entity_ids, const int32_t *eids,
                  const float *px, const float *py, const float *pz,
                  const float *qx, const float *qy, const float *qz,
                  const float *qw, const uint8_t *flags, float dt) {
    JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    for (int i = 0; i < n; ++i) {
      auto it = mBodies.find(entity_ids[i]);
      if (it == mBodies.end())
        continue;
      const JPH::BodyID id = it->second.body_id;
      const int32_t e = eids[i];
      if (it->second.motion_type == MJ_MOTION_KINEMATIC) {
        // Kinematic bodies follow the JS-side transform; Jolt derives
        // their velocity from the frame delta (used to push dynamics).
        bi.MoveKinematic(
            id,
            JPH::RVec3(px[e], py[e], pz[e]),
            JPH::Quat(qx[e], qy[e], qz[e], qw[e]),
            dt);
      } else if (it->second.motion_type == MJ_MOTION_DYNAMIC &&
                 (flags[i] & MJ_SYNC_TELEPORT) != 0) {
        // Explicit teleport of a simulated body (rare: respawns,
        // restores). Wakes the body so it keeps simulating.
        bi.SetPositionAndRotation(
            id,
            JPH::RVec3(px[e], py[e], pz[e]),
            JPH::Quat(qx[e], qy[e], qz[e], qw[e]),
            JPH::EActivation::Activate);
      }
      // Static bodies: nothing to sync.
    }
  }

  void step(float dt, int sub_steps) {
    if (sub_steps < 1)
      sub_steps = 1;
    const float sub_dt = dt / static_cast<float>(sub_steps);
    for (int s = 0; s < sub_steps; ++s) {
      // One Jolt Update per substep with a single collision step:
      // the fixed-timestep pattern Jolt's docs recommend.
      mSystem->Update(sub_dt, 1, mTempAllocator.get(), mJobSystem.get());
    }
  }

  void copyResults(int n, const uint64_t *entity_ids, const int32_t *eids,
                   float *px, float *py, float *pz, float *qx, float *qy,
                   float *qz, float *qw, float *lx, float *ly, float *lz,
                   float *ax, float *ay, float *az) {
    const JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    for (int i = 0; i < n; ++i) {
      auto it = mBodies.find(entity_ids[i]);
      if (it == mBodies.end())
        continue;
      const JPH::BodyID id = it->second.body_id;
      const int32_t e = eids[i];
      const JPH::RVec3 p = bi.GetPosition(id);
      const JPH::Quat q = bi.GetRotation(id);
      const JPH::Vec3 lv = bi.GetLinearVelocity(id);
      const JPH::Vec3 av = bi.GetAngularVelocity(id);
      px[e] = p.GetX();
      py[e] = p.GetY();
      pz[e] = p.GetZ();
      qx[e] = q.GetX();
      qy[e] = q.GetY();
      qz[e] = q.GetZ();
      qw[e] = q.GetW();
      lx[e] = lv.GetX();
      ly[e] = lv.GetY();
      lz[e] = lv.GetZ();
      ax[e] = av.GetX();
      ay[e] = av.GetY();
      az[e] = av.GetZ();
    }
  }

  int bodyCount() const { return static_cast<int>(mBodies.size()); }

  // Jolt splits each height-field cell along its (0,0)-(1,1) diagonal;
  // the engine's terrain (client mesh, grounding) splits along
  // (1,0)-(0,1). A height field rotated +90 degrees about Y maps one onto
  // the other without flipping any triangle: local sample (i, j) lands at
  // world (x = j, z = side-1-i) when the body sits at
  // (origin_x, 0, origin_z + (side-1)*spacing).
  bool addTerrain(uint64_t key, float origin_x, float origin_z, float spacing,
                  int side, const float *samples, float friction) {
    if (side < 4 || (side & 1) != 0 || !(spacing > 0.0f) || samples == nullptr)
      return false;
    removeTerrain(key); // replace: a sculpted chunk re-adds its tile
    std::vector<float> local(static_cast<size_t>(side) * side);
    for (int gz = 0; gz < side; ++gz)
      for (int gx = 0; gx < side; ++gx)
        local[static_cast<size_t>(gx) * side + (side - 1 - gz)] =
            samples[static_cast<size_t>(gz) * side + gx];
    // Heap-allocated settings (see addBodies: never stack + SetEmbedded).
    JPH::Ref<JPH::HeightFieldShapeSettings> settings =
        new JPH::HeightFieldShapeSettings(
            local.data(), JPH::Vec3::sZero(),
            JPH::Vec3(spacing, 1.0f, spacing), static_cast<JPH::uint32>(side));
    JPH::ShapeSettings::ShapeResult shape = settings->Create();
    if (shape.HasError())
      return false;
    JPH::BodyCreationSettings bcs(
        shape.Get(),
        JPH::RVec3(origin_x, 0.0f,
                   origin_z + static_cast<float>(side - 1) * spacing),
        JPH::Quat::sRotation(JPH::Vec3::sAxisY(), 0.5f * JPH::JPH_PI),
        JPH::EMotionType::Static, Layers::NON_MOVING);
    bcs.mFriction = friction;
    JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    JPH::Body *body = bi.CreateBody(bcs);
    if (body == nullptr)
      return false; // body limit reached
    bi.AddBody(body->GetID(), JPH::EActivation::DontActivate);
    mTerrain.emplace(key, body->GetID());
    return true;
  }

  void removeTerrain(uint64_t key) {
    auto it = mTerrain.find(key);
    if (it == mTerrain.end())
      return;
    JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    JPH::AABox bounds = bi.GetTransformedShape(it->second).GetWorldSpaceBounds();
    bounds.ExpandBy(JPH::Vec3::sReplicate(0.5f));
    bi.RemoveBody(it->second);
    bi.DestroyBody(it->second);
    mTerrain.erase(it);
    // Bodies resting on the ground are usually asleep, and removing what
    // they rest on doesn't wake them: they would hang in the air (or, on
    // a replaced/sculpted tile, never settle onto the new surface).
    bi.ActivateBodiesInAABox(bounds, JPH::BroadPhaseLayerFilter(), JPH::ObjectLayerFilter());
  }

  int terrainCount() const { return static_cast<int>(mTerrain.size()); }

private:
  BPLayerInterfaceImpl mBroadPhaseLayerInterface;
  ObjectVsBroadPhaseLayerFilterImpl mObjectVsBroadPhaseLayerFilter;
  ObjectLayerPairFilterImpl mObjectLayerPairFilter;
  std::unique_ptr<JPH::TempAllocatorImpl> mTempAllocator;
  std::unique_ptr<JPH::JobSystemSingleThreaded> mJobSystem;
  std::unique_ptr<JPH::PhysicsSystem> mSystem;
  std::unordered_map<uint64_t, BodyRecord> mBodies;
  std::unordered_map<uint64_t, JPH::BodyID> mTerrain;
};

// --- C ABI -----------------------------------------------------------------

extern "C" {

mj_physics_world_t *mj_physics_create(void) {
  return new mj_physics_world();
}

void mj_physics_destroy(mj_physics_world_t *world) { delete world; }

void mj_physics_add_bodies(mj_physics_world_t *world, int n,
                           const uint64_t *entity_ids,
                           const uint8_t *shape_kind,
                           const float *half_extents, const float *radius,
                           const float *mass, const float *friction,
                           const float *restitution,
                           const uint8_t *motion_type, const uint8_t *layer,
                           const float *pos, const float *quat,
                           const float *lin_vel, const float *ang_vel) {
  if (world == nullptr || n <= 0)
    return;
  world->addBodies(n, entity_ids, shape_kind, half_extents, radius, mass,
                   friction, restitution, motion_type, layer, pos, quat,
                   lin_vel, ang_vel);
}

void mj_physics_remove_bodies(mj_physics_world_t *world, int n,
                              const uint64_t *entity_ids) {
  if (world == nullptr || n <= 0)
    return;
  world->removeBodies(n, entity_ids);
}

void mj_physics_sync_bodies(mj_physics_world_t *world, int n,
                            const uint64_t *entity_ids, const int32_t *eids,
                            const float *px, const float *py, const float *pz,
                            const float *qx, const float *qy, const float *qz,
                            const float *qw, const uint8_t *flags, float dt) {
  if (world == nullptr || n <= 0)
    return;
  world->syncBodies(n, entity_ids, eids, px, py, pz, qx, qy, qz, qw, flags,
                    dt);
}

void mj_physics_step(mj_physics_world_t *world, float dt, int sub_steps) {
  if (world == nullptr)
    return;
  world->step(dt, sub_steps);
}

void mj_physics_copy_results(mj_physics_world_t *world, int n,
                             const uint64_t *entity_ids, const int32_t *eids,
                             float *px, float *py, float *pz, float *qx,
                             float *qy, float *qz, float *qw, float *lx,
                             float *ly, float *lz, float *ax, float *ay,
                             float *az) {
  if (world == nullptr || n <= 0)
    return;
  world->copyResults(n, entity_ids, eids, px, py, pz, qx, qy, qz, qw, lx,
                     ly, lz, ax, ay, az);
}

int mj_physics_body_count(mj_physics_world_t *world) {
  return world == nullptr ? 0 : world->bodyCount();
}

int mj_physics_add_terrain(mj_physics_world_t *world, uint64_t key,
                           float origin_x, float origin_z, float spacing,
                           int side, const float *samples, float friction) {
  if (world == nullptr)
    return 0;
  return world->addTerrain(key, origin_x, origin_z, spacing, side, samples,
                           friction)
             ? 1
             : 0;
}

void mj_physics_remove_terrain(mj_physics_world_t *world, uint64_t key) {
  if (world != nullptr)
    world->removeTerrain(key);
}

int mj_physics_terrain_count(mj_physics_world_t *world) {
  return world == nullptr ? 0 : world->terrainCount();
}

} // extern "C"
