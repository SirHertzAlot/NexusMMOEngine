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
#include <Jolt/Core/JobSystemThreadPool.h>
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
#include <Jolt/Physics/Constraints/SwingTwistConstraint.h>
#include <Jolt/Physics/PhysicsSystem.h>
#include <Jolt/Physics/Ragdoll/Ragdoll.h>
#include <Jolt/RegisterTypes.h>
#include <Jolt/Skeleton/Skeleton.h>

#include <limits>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
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

// --- Server ragdolls --------------------------------------------------------
// Jolt's own Ragdoll: capsule parts joined by swing-twist joints. These are the
// two rigs the cost bench measures; bench/ragdoll-cost.cpp keeps its own copy of
// the same tables, so keep the two in step. Offsets are metres in the rig frame.

struct RagdollAnchor {
  float x, y, z;
};

struct RagdollPart {
  const char *name;
  int parent;  // index into the rig; -1 for the root
  float halfHeight;
  float radius;
  RagdollAnchor parentAnchor;
  RagdollAnchor childAnchor;
};

constexpr RagdollPart kFullRigParts[] = {
    {"Pelvis", -1, 0.07f, 0.14f, {0, 0, 0}, {0, 0, 0}},
    {"Spine", 0, 0.14f, 0.12f, {0, 0.21f, 0}, {0, -0.26f, 0}},
    {"Head", 1, 0.06f, 0.11f, {0, 0.26f, 0}, {0, -0.17f, 0}},
    {"UpperArmL", 1, 0.13f, 0.05f, {0.19f, 0.20f, 0}, {0, 0.18f, 0}},
    {"LowerArmL", 3, 0.12f, 0.04f, {0, -0.18f, 0}, {0, 0.16f, 0}},
    {"UpperArmR", 1, 0.13f, 0.05f, {-0.19f, 0.20f, 0}, {0, 0.18f, 0}},
    {"LowerArmR", 5, 0.12f, 0.04f, {0, -0.18f, 0}, {0, 0.16f, 0}},
    {"UpperLegL", 0, 0.12f, 0.07f, {0.10f, -0.15f, 0}, {0, 0.19f, 0}},
    {"LowerLegL", 7, 0.12f, 0.06f, {0, -0.19f, 0}, {0, 0.18f, 0}},
    {"UpperLegR", 0, 0.12f, 0.07f, {-0.10f, -0.15f, 0}, {0, 0.19f, 0}},
    {"LowerLegR", 9, 0.12f, 0.06f, {0, -0.19f, 0}, {0, 0.18f, 0}},
};

// The same torso and head, no arms, and each leg one capsule.
constexpr RagdollPart kLightRigParts[] = {
    {"Pelvis", -1, 0.07f, 0.14f, {0, 0, 0}, {0, 0, 0}},
    {"Spine", 0, 0.14f, 0.12f, {0, 0.21f, 0}, {0, -0.26f, 0}},
    {"Head", 1, 0.06f, 0.11f, {0, 0.26f, 0}, {0, -0.17f, 0}},
    {"LegL", 0, 0.20f, 0.07f, {0.10f, -0.15f, 0}, {0, 0.27f, 0}},
    {"LegR", 0, 0.20f, 0.07f, {-0.10f, -0.15f, 0}, {0, 0.27f, 0}},
};

// Budget units. A full rig costs 5 and a light rig 2, so the default budget of
// 240 holds 48 full rigs or 120 light ones: the cost gate's 4 ms per tick (the
// bench measured 48 full and 116 light rigs there).
constexpr int kRagdollFullUnits = 5;
constexpr int kRagdollLightUnits = 2;
constexpr int kRagdollDefaultBudget = 240;

constexpr float kRagdollDegrees = 3.14159265358979f / 180.0f;
// The sleep threshold (m/s) a world starts with. Jolt's own default is 0.03; 0.05 is the value
// the sleep benchmark chose (bench/addon-sleep-ensemble.mjs, docs/addon-sleep-threshold-ensemble-results.json).
constexpr float kDefaultSleepThreshold = 0.05f;

const RagdollPart *RigParts(int rig_kind, int *count) {
  if (rig_kind == MJ_RAGDOLL_LIGHT) {
    *count = static_cast<int>(sizeof(kLightRigParts) / sizeof(kLightRigParts[0]));
    return kLightRigParts;
  }
  *count = static_cast<int>(sizeof(kFullRigParts) / sizeof(kFullRigParts[0]));
  return kFullRigParts;
}

// One capsule per part, shared by every ragdoll of that rig kind.
std::vector<JPH::Ref<JPH::Shape>> MakeRagdollShapes(const RagdollPart *parts,
                                                    int count) {
  std::vector<JPH::Ref<JPH::Shape>> shapes;
  for (int i = 0; i < count; ++i) {
    shapes.emplace_back(
        new JPH::CapsuleShape(parts[i].halfHeight, parts[i].radius));
  }
  return shapes;
}

// Settings for one ragdoll with its root at `root` (x, y, z). Returns nullptr
// if Jolt cannot stabilise the rig; the caller refuses the add in that case.
JPH::Ref<JPH::RagdollSettings> MakeRagdollSettings(
    const RagdollPart *parts, int count,
    const std::vector<JPH::Ref<JPH::Shape>> &shapes, const float *root) {
  JPH::Ref<JPH::RagdollSettings> settings = new JPH::RagdollSettings;
  settings->mSkeleton = new JPH::Skeleton;
  for (int i = 0; i < count; ++i) {
    settings->mSkeleton->AddJoint(
        parts[i].name, parts[i].parent < 0 ? "" : parts[parts[i].parent].name);
  }
  settings->mSkeleton->CalculateParentJointIndices();
  settings->mParts.resize(static_cast<size_t>(count));

  std::vector<JPH::RVec3> position(static_cast<size_t>(count));
  for (int i = 0; i < count; ++i) {
    const RagdollPart &spec = parts[i];
    if (spec.parent < 0) {
      position[i] = JPH::RVec3(root[0], root[1], root[2]);
    } else {
      position[i] =
          position[spec.parent] +
          JPH::Vec3(spec.parentAnchor.x - spec.childAnchor.x,
                    spec.parentAnchor.y - spec.childAnchor.y,
                    spec.parentAnchor.z - spec.childAnchor.z);
    }

    JPH::RagdollSettings::Part &part = settings->mParts[i];
    part.SetShape(shapes[i].GetPtr());
    part.mPosition = position[i];
    part.mRotation = JPH::Quat::sIdentity();
    part.mMotionType = JPH::EMotionType::Dynamic;
    part.mObjectLayer = Layers::MOVING;
    part.mAllowSleeping = true;

    if (spec.parent >= 0) {
      JPH::Ref<JPH::SwingTwistConstraintSettings> joint =
          new JPH::SwingTwistConstraintSettings;
      joint->mSpace = JPH::EConstraintSpace::LocalToBodyCOM;
      joint->mPosition1 = JPH::RVec3(spec.parentAnchor.x, spec.parentAnchor.y,
                                     spec.parentAnchor.z);
      joint->mTwistAxis1 = JPH::Vec3::sAxisY();
      joint->mPlaneAxis1 = JPH::Vec3::sAxisX();
      joint->mPosition2 = JPH::RVec3(spec.childAnchor.x, spec.childAnchor.y,
                                     spec.childAnchor.z);
      joint->mTwistAxis2 = JPH::Vec3::sAxisY();
      joint->mPlaneAxis2 = JPH::Vec3::sAxisX();
      joint->mNormalHalfConeAngle = 45.0f * kRagdollDegrees;
      joint->mPlaneHalfConeAngle = 30.0f * kRagdollDegrees;
      joint->mTwistMinAngle = -30.0f * kRagdollDegrees;
      joint->mTwistMaxAngle = 30.0f * kRagdollDegrees;
      part.mToParent = joint;
    }
  }

  if (!settings->Stabilize()) {
    return nullptr;
  }
  settings->DisableParentChildCollisions();
  settings->CalculateBodyIndexToConstraintIndex();
  settings->CalculateConstraintIndexToBodyIdxPair();
  return settings;
}

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

  // threads 0: one thread, the default. threads > 0: a Jolt thread pool of
  // that many workers. Jolt's internal job threads are never visible to JS.
  explicit mj_physics_world(int threads) {
    InitJoltOnce();
    mTempAllocator =
        std::make_unique<JPH::TempAllocatorImpl>(kTempAllocatorBytes);
    if (threads > 0) {
      mJobSystem = std::make_unique<JPH::JobSystemThreadPool>(
          JPH::cMaxPhysicsJobs, JPH::cMaxPhysicsBarriers, threads);
    } else {
      mJobSystem =
          std::make_unique<JPH::JobSystemSingleThreaded>(JPH::cMaxPhysicsJobs);
    }
    mSystem = std::make_unique<JPH::PhysicsSystem>();
    mSystem->Init(kMaxBodies, kNumBodyMutexes, kMaxBodyPairs,
                  kMaxContactConstraints, mBroadPhaseLayerInterface,
                  mObjectVsBroadPhaseLayerFilter, mObjectLayerPairFilter);
    mSystem->SetGravity(JPH::Vec3(0.0f, -9.81f, 0.0f));
    JPH::PhysicsSettings settings = mSystem->GetPhysicsSettings();
    settings.mPointVelocitySleepThreshold = kDefaultSleepThreshold;
    mSystem->SetPhysicsSettings(settings);
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
    uint32_t errors = 0;
    for (int s = 0; s < sub_steps; ++s) {
      // One Jolt Update per substep with a single collision step:
      // the fixed-timestep pattern Jolt's docs recommend.
      errors |= static_cast<uint32_t>(
          mSystem->Update(sub_dt, 1, mTempAllocator.get(), mJobSystem.get()));
    }
    mLastStepErrors = errors;
  }
  uint32_t lastStepErrors() const { return mLastStepErrors; }

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

  // --- Server ragdolls (see the C API in physics_c_api.h) ---------------------

  ~mj_physics_world() {
    // Rigs leave the system before it goes; their bodies are freed with them.
    for (auto &entry : mRagdolls) {
      entry.second.ragdoll->RemoveFromPhysicsSystem();
    }
    mRagdolls.clear();
  }

  int addRagdolls(int n, const uint64_t *ids, int rig_kind, const float *pos) {
    if (rig_kind != MJ_RAGDOLL_FULL && rig_kind != MJ_RAGDOLL_LIGHT) {
      return MJ_RAGDOLL_BAD_KIND;
    }
    const int units_each =
        rig_kind == MJ_RAGDOLL_FULL ? kRagdollFullUnits : kRagdollLightUnits;

    // Check the whole batch before changing anything.
    std::unordered_set<uint64_t> batch;
    for (int i = 0; i < n; ++i) {
      if (mRagdolls.count(ids[i]) != 0 || !batch.insert(ids[i]).second) {
        return MJ_RAGDOLL_DUPLICATE;
      }
    }
    if (mRagdollUnits + n * units_each > mRagdollBudget) {
      return MJ_RAGDOLL_OVER_BUDGET;
    }

    int count = 0;
    const RagdollPart *parts = RigParts(rig_kind, &count);
    std::vector<JPH::Ref<JPH::Shape>> &shapes = mRagdollShapes[rig_kind];
    if (shapes.empty()) {
      shapes = MakeRagdollShapes(parts, count);
    }

    std::vector<uint64_t> added;
    added.reserve(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
      JPH::Ref<JPH::RagdollSettings> settings =
          MakeRagdollSettings(parts, count, shapes, pos + 3 * i);
      JPH::Ref<JPH::Ragdoll> ragdoll;
      if (settings.GetPtr() != nullptr) {
        // Each ragdoll gets its own collision group, so rigs never share one.
        ragdoll = settings->CreateRagdoll(
            static_cast<JPH::CollisionGroup::GroupID>(mNextRagdollGroup++), 0,
            mSystem.get());
      }
      if (ragdoll.GetPtr() == nullptr) {
        // All or nothing: undo this batch's rigs before reporting the failure.
        removeRagdolls(static_cast<int>(added.size()), added.data());
        return MJ_RAGDOLL_INTERNAL;
      }
      ragdoll->AddToPhysicsSystem(JPH::EActivation::Activate);
      mRagdolls.emplace(ids[i], RagdollRecord{ragdoll, units_each});
      mRagdollUnits += units_each;
      added.push_back(ids[i]);
    }
    return MJ_RAGDOLL_OK;
  }

  void removeRagdolls(int n, const uint64_t *ids) {
    for (int i = 0; i < n; ++i) {
      auto it = mRagdolls.find(ids[i]);
      if (it == mRagdolls.end()) {
        continue;  // idempotent
      }
      it->second.ragdoll->RemoveFromPhysicsSystem();
      mRagdollUnits -= it->second.units;
      mRagdolls.erase(it);  // the last reference frees the rig's bodies
    }
  }

  // Floats per body in copyRagdollBodies: position, rotation (x y z w), linear
  // velocity and angular velocity.
  static constexpr int kRagdollBodyFloats = 13;

  // Writes every body of each rig in ids order, in Jolt's body order, and
  // returns the floats written. An unknown id, or a buffer too small for all the
  // bodies, returns -1 and writes nothing.
  int copyRagdollBodies(int n, const uint64_t *ids, float *out,
                        int capacity) const {
    int needed = 0;
    for (int i = 0; i < n; ++i) {
      auto it = mRagdolls.find(ids[i]);
      if (it == mRagdolls.end()) {
        return -1;
      }
      needed += it->second.ragdoll->GetBodyCount() * kRagdollBodyFloats;
    }
    if (needed > capacity) {
      return -1;
    }
    const JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    float *w = out;
    for (int i = 0; i < n; ++i) {
      const JPH::Ragdoll *rig = mRagdolls.at(ids[i]).ragdoll.GetPtr();
      const int body_count = static_cast<int>(rig->GetBodyCount());
      for (int b = 0; b < body_count; ++b) {
        const JPH::BodyID body = rig->GetBodyID(b);
        const JPH::RVec3 p = bi.GetPosition(body);
        const JPH::Quat q = bi.GetRotation(body);
        const JPH::Vec3 lv = bi.GetLinearVelocity(body);
        const JPH::Vec3 av = bi.GetAngularVelocity(body);
        *w++ = static_cast<float>(p.GetX());
        *w++ = static_cast<float>(p.GetY());
        *w++ = static_cast<float>(p.GetZ());
        *w++ = q.GetX();
        *w++ = q.GetY();
        *w++ = q.GetZ();
        *w++ = q.GetW();
        *w++ = lv.GetX();
        *w++ = lv.GetY();
        *w++ = lv.GetZ();
        *w++ = av.GetX();
        *w++ = av.GetY();
        *w++ = av.GetZ();
      }
    }
    return needed;
  }

  void copyRagdollRoots(int n, const uint64_t *ids, float *pos) const {
    const JPH::BodyInterface &bi = mSystem->GetBodyInterface();
    for (int i = 0; i < n; ++i) {
      auto it = mRagdolls.find(ids[i]);
      if (it == mRagdolls.end()) {
        const float nan = std::numeric_limits<float>::quiet_NaN();
        pos[3 * i] = pos[3 * i + 1] = pos[3 * i + 2] = nan;
        continue;
      }
      // Body 0 is the root part, in the order the settings list the parts.
      const JPH::RVec3 p = bi.GetPosition(it->second.ragdoll->GetBodyID(0));
      pos[3 * i] = static_cast<float>(p.GetX());
      pos[3 * i + 1] = static_cast<float>(p.GetY());
      pos[3 * i + 2] = static_cast<float>(p.GetZ());
    }
  }

  int ragdollCount() const { return static_cast<int>(mRagdolls.size()); }
  int ragdollUnits() const { return mRagdollUnits; }
  int ragdollBudget() const { return mRagdollBudget; }
  void setRagdollBudget(int units) { mRagdollBudget = units < 0 ? 0 : units; }
  // Jolt's point-velocity sleep threshold (m/s), applied to every body.
  float sleepThreshold() {
    return mSystem->GetPhysicsSettings().mPointVelocitySleepThreshold;
  }
  void setSleepThreshold(float metresPerSecond) {
    JPH::PhysicsSettings settings = mSystem->GetPhysicsSettings();
    settings.mPointVelocitySleepThreshold = metresPerSecond;
    mSystem->SetPhysicsSettings(settings);
  }
  // Ragdoll bodies Jolt is simulating now (a sleeping body does not count).
  int ragdollActiveBodies() {
    const JPH::BodyInterface &bodies = mSystem->GetBodyInterface();
    int active = 0;
    for (const auto &entry : mRagdolls) {
      const JPH::Ragdoll *rig = entry.second.ragdoll.GetPtr();
      for (size_t i = 0; i < rig->GetBodyCount(); ++i) {
        if (bodies.IsActive(rig->GetBodyID(static_cast<int>(i)))) {
          ++active;
        }
      }
    }
    return active;
  }

private:
  BPLayerInterfaceImpl mBroadPhaseLayerInterface;
  ObjectVsBroadPhaseLayerFilterImpl mObjectVsBroadPhaseLayerFilter;
  ObjectLayerPairFilterImpl mObjectLayerPairFilter;
  std::unique_ptr<JPH::TempAllocatorImpl> mTempAllocator;
  std::unique_ptr<JPH::JobSystem> mJobSystem;
  std::unique_ptr<JPH::PhysicsSystem> mSystem;
  std::unordered_map<uint64_t, BodyRecord> mBodies;
  std::unordered_map<uint64_t, JPH::BodyID> mTerrain;

  struct RagdollRecord {
    JPH::Ref<JPH::Ragdoll> ragdoll;
    int units;
  };
  std::unordered_map<uint64_t, RagdollRecord> mRagdolls;
  std::vector<JPH::Ref<JPH::Shape>> mRagdollShapes[2];  // by rig kind
  int mRagdollUnits = 0;
  int mRagdollBudget = kRagdollDefaultBudget;
  uint32_t mNextRagdollGroup = 1;
  // Jolt's EPhysicsUpdateError bits from the last step(), OR-ed over substeps.
  uint32_t mLastStepErrors = 0;
};

// --- C ABI -----------------------------------------------------------------

extern "C" {

mj_physics_world_t *mj_physics_create(void) {
  return new mj_physics_world(0);
}

mj_physics_world_t *mj_physics_create_with_threads(int threads) {
  return new mj_physics_world(threads);
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

uint32_t mj_physics_last_step_errors(mj_physics_world_t *world) {
  return world == nullptr ? 0u : world->lastStepErrors();
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

int mj_physics_add_ragdolls(mj_physics_world_t *world, int n,
                            const uint64_t *ids, int rig_kind,
                            const float *pos) {
  if (world == nullptr) {
    return MJ_RAGDOLL_INTERNAL;
  }
  if (n <= 0) {
    return MJ_RAGDOLL_OK;
  }
  return world->addRagdolls(n, ids, rig_kind, pos);
}

void mj_physics_remove_ragdolls(mj_physics_world_t *world, int n,
                                const uint64_t *ids) {
  if (world != nullptr && n > 0) {
    world->removeRagdolls(n, ids);
  }
}

int mj_physics_ragdoll_count(mj_physics_world_t *world) {
  return world == nullptr ? 0 : world->ragdollCount();
}

int mj_physics_ragdoll_units(mj_physics_world_t *world) {
  return world == nullptr ? 0 : world->ragdollUnits();
}

int mj_physics_ragdoll_budget(mj_physics_world_t *world) {
  return world == nullptr ? 0 : world->ragdollBudget();
}

float mj_physics_sleep_threshold(mj_physics_world_t *world) {
  return world == nullptr ? 0.0f : world->sleepThreshold();
}

void mj_physics_set_sleep_threshold(mj_physics_world_t *world, float metres_per_second) {
  if (world != nullptr) {
    world->setSleepThreshold(metres_per_second);
  }
}

int mj_physics_ragdoll_active_bodies(mj_physics_world_t *world) {
  return world == nullptr ? 0 : world->ragdollActiveBodies();
}

void mj_physics_set_ragdoll_budget(mj_physics_world_t *world, int units) {
  if (world != nullptr) {
    world->setRagdollBudget(units);
  }
}

void mj_physics_copy_ragdoll_roots(mj_physics_world_t *world, int n,
                                   const uint64_t *ids, float *pos) {
  if (world != nullptr && n > 0) {
    world->copyRagdollRoots(n, ids, pos);
  }
}

int mj_physics_copy_ragdoll_bodies(mj_physics_world_t *world, int n,
                                   const uint64_t *ids, float *out,
                                   int capacity) {
  if (world == nullptr || n < 0 || capacity < 0) {
    return -1;
  }
  return world->copyRagdollBodies(n, ids, out, capacity);
}

} // extern "C"
