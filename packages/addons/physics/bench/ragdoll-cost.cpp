// Ragdoll cost gate: what one simulated ragdoll adds to a physics step.
//
// Each ragdoll is Jolt's own Ragdoll: 11 capsule parts joined by 10
// swing-twist constraints, the rig a corpse or an active ragdoll would use.
// The world is set up the way native/physics_world.cpp sets it up: this file
// links against the addon's compiled Jolt objects, with the same two object
// layers, a single-threaded job system and gravity. No gameplay code runs.
// The ragdolls drop onto a floor and step at the tick's 30 Hz.
//
// Three scenarios per ragdoll count:
//   settle  rigs 0.9 m apart, sleeping allowed; the first 2 s after the drop,
//           while they fall, land and go to sleep. The transient cost.
//   awake   rigs 0.9 m apart, sleeping disabled; 1 s of warm-up, then 3 s
//           measured. The steady worst case: a crowd in contact and moving.
//   apart   rigs 4 m apart, sleeping disabled, so none touch. A rig on its
//           own: its joints and its contacts with the floor.
//
// Each run is repeated (three times, or once with --quick) on a fresh world,
// and the median of the repeats is reported. Writes one JSON object to stdout
// and progress to stderr. bench/run-ragdoll-cost.mjs builds and runs it.

#include <Jolt/Jolt.h>

#include <Jolt/Core/Factory.h>
#include <Jolt/Core/JobSystemSingleThreaded.h>
#include <Jolt/Core/TempAllocator.h>
#include <Jolt/Physics/Body/BodyCreationSettings.h>
#include <Jolt/Physics/Body/BodyInterface.h>
#include <Jolt/Physics/Collision/BroadPhase/BroadPhaseLayer.h>
#include <Jolt/Physics/Collision/Shape/BoxShape.h>
#include <Jolt/Physics/Collision/Shape/CapsuleShape.h>
#include <Jolt/Physics/Constraints/SwingTwistConstraint.h>
#include <Jolt/Physics/PhysicsSystem.h>
#include <Jolt/Physics/Ragdoll/Ragdoll.h>
#include <Jolt/RegisterTypes.h>
#include <Jolt/Skeleton/Skeleton.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string_view>
#include <vector>

namespace {

// The limits of native/physics_world.cpp, except the contact cap. Its 10240
// would drop contacts in the largest crowd, so the bench raises it: every
// contact the crowd makes is simulated and timed.
constexpr JPH::uint kMaxBodies = 65536;
constexpr JPH::uint kMaxBodyPairs = 65536;
constexpr JPH::uint kMaxContactConstraints = 65536;
constexpr size_t kTempAllocatorBytes = 64 * 1024 * 1024;
constexpr float kTickSeconds = 1.0f / 30.0f;
constexpr float kDegrees = 3.14159265358979f / 180.0f;

namespace Layers {
constexpr JPH::ObjectLayer NON_MOVING = 0;
constexpr JPH::ObjectLayer MOVING = 1;
}  // namespace Layers

// The object-layer rules of native/physics_world.cpp.
class ObjectLayerPairFilterImpl : public JPH::ObjectLayerPairFilter {
 public:
  bool ShouldCollide(JPH::ObjectLayer inObject1,
                     JPH::ObjectLayer inObject2) const override {
    return inObject1 == Layers::MOVING || inObject2 == Layers::MOVING;
  }
};

class BPLayerInterfaceImpl : public JPH::BroadPhaseLayerInterface {
 public:
  BPLayerInterfaceImpl() {
    mObjectToBroadPhase[Layers::NON_MOVING] = JPH::BroadPhaseLayer(0);
    mObjectToBroadPhase[Layers::MOVING] = JPH::BroadPhaseLayer(1);
  }
  JPH::uint GetNumBroadPhaseLayers() const override { return 2; }
  JPH::BroadPhaseLayer GetBroadPhaseLayer(
      JPH::ObjectLayer inLayer) const override {
    return mObjectToBroadPhase[inLayer];
  }

 private:
  JPH::BroadPhaseLayer mObjectToBroadPhase[2];
};

class ObjectVsBroadPhaseLayerFilterImpl
    : public JPH::ObjectVsBroadPhaseLayerFilter {
 public:
  bool ShouldCollide(JPH::ObjectLayer inLayer1,
                     JPH::BroadPhaseLayer inLayer2) const override {
    if (inLayer1 == Layers::NON_MOVING)
      return inLayer2 == JPH::BroadPhaseLayer(1);
    return true;
  }
};

// One joint point in a body's frame, metres from its centre of mass.
struct Anchor {
  float x, y, z;
};

// One humanoid-sized capsule. Its parent joint is `parentAnchor` on the
// parent, `childAnchor` on this part. A child sits where its two anchors meet,
// so every joint starts closed.
struct PartSpec {
  const char *name;
  int parent;  // index into kParts; -1 for the root
  float halfHeight;
  float radius;
  Anchor parentAnchor;
  Anchor childAnchor;
};

constexpr int kPartCount = 11;
constexpr PartSpec kParts[kPartCount] = {
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

// Builds one ragdoll with its root at `root`. The shapes are shared by every
// ragdoll and must outlive them.
JPH::Ref<JPH::RagdollSettings> MakeRagdoll(const JPH::Ref<JPH::Shape> *shapes,
                                           JPH::RVec3 root, bool allowSleep) {
  JPH::Ref<JPH::RagdollSettings> settings = new JPH::RagdollSettings;
  settings->mSkeleton = new JPH::Skeleton;
  for (const PartSpec &spec : kParts) {
    settings->mSkeleton->AddJoint(spec.name,
                                  spec.parent < 0 ? "" : kParts[spec.parent].name);
  }
  settings->mSkeleton->CalculateParentJointIndices();
  settings->mParts.resize(kPartCount);

  JPH::RVec3 position[kPartCount];
  for (int i = 0; i < kPartCount; ++i) {
    const PartSpec &spec = kParts[i];
    if (spec.parent < 0) {
      position[i] = root;
    } else {
      position[i] = position[spec.parent] +
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
    part.mAllowSleeping = allowSleep;

    if (spec.parent >= 0) {
      JPH::Ref<JPH::SwingTwistConstraintSettings> joint =
          new JPH::SwingTwistConstraintSettings;
      joint->mSpace = JPH::EConstraintSpace::LocalToBodyCOM;
      joint->mPosition1 = JPH::RVec3(spec.parentAnchor.x, spec.parentAnchor.y,
                                     spec.parentAnchor.z);
      joint->mTwistAxis1 = JPH::Vec3::sAxisY();
      joint->mPlaneAxis1 = JPH::Vec3::sAxisX();
      joint->mPosition2 =
          JPH::RVec3(spec.childAnchor.x, spec.childAnchor.y, spec.childAnchor.z);
      joint->mTwistAxis2 = JPH::Vec3::sAxisY();
      joint->mPlaneAxis2 = JPH::Vec3::sAxisX();
      joint->mNormalHalfConeAngle = 45.0f * kDegrees;
      joint->mPlaneHalfConeAngle = 30.0f * kDegrees;
      joint->mTwistMinAngle = -30.0f * kDegrees;
      joint->mTwistMaxAngle = 30.0f * kDegrees;
      part.mToParent = joint;
    }
  }

  if (!settings->Stabilize()) {
    std::fprintf(stderr, "ragdoll-cost: Stabilize failed\n");
    std::exit(1);
  }
  settings->DisableParentChildCollisions();
  settings->CalculateBodyIndexToConstraintIndex();
  settings->CalculateConstraintIndexToBodyIdxPair();
  return settings;
}

// A physics system and the objects it refers to. The system keeps references
// into the filters and allocators, so the whole world sits behind one pointer.
struct World {
  BPLayerInterfaceImpl broadPhase;
  ObjectVsBroadPhaseLayerFilterImpl objectVsBroadPhase;
  ObjectLayerPairFilterImpl objectPairs;
  JPH::TempAllocatorImpl temp{kTempAllocatorBytes};
  JPH::JobSystemSingleThreaded jobs{JPH::cMaxPhysicsJobs};
  JPH::PhysicsSystem system;
  std::vector<JPH::Ref<JPH::Ragdoll>> ragdolls;
};

// A floor, plus `count` ragdolls on a grid, dropped from just above it.
std::unique_ptr<World> BuildWorld(int count, float spacing, bool allowSleep,
                                  const JPH::Ref<JPH::Shape> *shapes) {
  auto world = std::make_unique<World>();
  world->system.Init(kMaxBodies, 0, kMaxBodyPairs, kMaxContactConstraints,
                     world->broadPhase, world->objectVsBroadPhase,
                     world->objectPairs);
  world->system.SetGravity(JPH::Vec3(0.0f, -9.81f, 0.0f));

  JPH::BodyInterface &bodies = world->system.GetBodyInterface();
  JPH::Ref<JPH::Shape> floor = new JPH::BoxShape(JPH::Vec3(50.0f, 0.5f, 50.0f));
  bodies.CreateAndAddBody(
      JPH::BodyCreationSettings(floor.GetPtr(), JPH::RVec3(0.0f, -0.5f, 0.0f),
                                JPH::Quat::sIdentity(),
                                JPH::EMotionType::Static, Layers::NON_MOVING),
      JPH::EActivation::DontActivate);

  const int cols =
      std::max(1, static_cast<int>(std::ceil(std::sqrt(double(count)))));
  for (int i = 0; i < count; ++i) {
    const float col = float(i % cols) - 0.5f * float(cols - 1);
    const float row = float(i / cols) - 0.5f * float(cols - 1);
    // The drop height steps by three, so neighbours land on each other.
    const JPH::RVec3 root(col * spacing, 1.2f + 0.3f * float(i % 3),
                          row * spacing);
    JPH::Ref<JPH::RagdollSettings> settings =
        MakeRagdoll(shapes, root, allowSleep);
    JPH::Ref<JPH::Ragdoll> ragdoll(settings->CreateRagdoll(
        static_cast<JPH::CollisionGroup::GroupID>(i + 1), 0, &world->system));
    if (ragdoll.GetPtr() == nullptr) {
      std::fprintf(stderr, "ragdoll-cost: out of bodies at ragdoll %d\n", i);
      std::exit(1);
    }
    ragdoll->AddToPhysicsSystem(JPH::EActivation::Activate);
    world->ragdolls.push_back(ragdoll);
  }
  world->system.OptimizeBroadPhase();
  return world;
}

// One physics step at the tick's 30 Hz, timed in microseconds.
double StepMicros(World &world) {
  const auto start = std::chrono::steady_clock::now();
  const JPH::EPhysicsUpdateError error = world.system.Update(
      kTickSeconds, 1, &world.temp, &world.jobs);
  const auto end = std::chrono::steady_clock::now();
  if (error != JPH::EPhysicsUpdateError::None) {
    std::fprintf(stderr, "ragdoll-cost: Update failed (%u)\n",
                 static_cast<unsigned>(error));
    std::exit(1);
  }
  return std::chrono::duration<double, std::micro>(end - start).count();
}

struct Run {
  std::vector<double> stepUs;  // one entry per measured step
  int bodies = 0;
  int constraints = 0;
  float maxSpeed = 0.0f;  // fastest ragdoll body at the end, m/s
};

Run RunScenario(int count, float spacing, bool awake, int warmSteps,
                int measureSteps, const JPH::Ref<JPH::Shape> *shapes) {
  // Sleeping is what makes a settled crowd cheap, so the awake scenarios turn
  // it off.
  std::unique_ptr<World> world = BuildWorld(count, spacing, !awake, shapes);
  for (int i = 0; i < warmSteps; ++i) StepMicros(*world);

  Run run;
  run.stepUs.reserve(measureSteps);
  for (int i = 0; i < measureSteps; ++i) {
    run.stepUs.push_back(StepMicros(*world));
  }

  const JPH::BodyInterface &bodies = world->system.GetBodyInterface();
  for (const JPH::Ref<JPH::Ragdoll> &ragdoll : world->ragdolls) {
    run.constraints += int(ragdoll->GetConstraintCount());
    for (const JPH::BodyID &id : ragdoll->GetBodyIDs()) {
      run.bodies += 1;
      run.maxSpeed =
          std::max(run.maxSpeed, bodies.GetLinearVelocity(id).Length());
    }
  }
  return run;
}

struct Stats {
  double mean, p95, max;
};

Stats Summarize(std::vector<double> values) {
  std::sort(values.begin(), values.end());
  double sum = 0.0;
  for (double v : values) sum += v;
  const size_t p95 = size_t(0.95 * double(values.size() - 1));
  return {sum / double(values.size()), values[p95], values.back()};
}

double Median(std::vector<double> values) {
  std::sort(values.begin(), values.end());
  return values[values.size() / 2];
}

}  // namespace

int main(int argc, char **argv) {
  bool quick = false;
  for (int i = 1; i < argc; ++i) {
    if (std::string_view(argv[i]) == "--quick") {
      quick = true;
    } else {
      std::fprintf(stderr, "usage: ragdoll-cost [--quick]\n");
      return 2;
    }
  }

  // Jolt's global setup, as native/physics_world.cpp does it.
  JPH::RegisterDefaultAllocator();
  JPH::Factory::sInstance = new JPH::Factory();
  JPH::RegisterTypes();

  JPH::Ref<JPH::Shape> shapes[kPartCount];
  for (int i = 0; i < kPartCount; ++i) {
    shapes[i] = new JPH::CapsuleShape(kParts[i].halfHeight, kParts[i].radius);
  }

  const std::vector<int> counts = quick ? std::vector<int>{0, 16, 64}
                                        : std::vector<int>{0, 8, 16, 32, 64,
                                                           128, 256};
  const int repeats = quick ? 1 : 3;
  struct Scenario {
    const char *name;
    float spacing;
    bool awake;
    int warmSteps;
    int measureSteps;
  };
  const Scenario scenarios[] = {
      {"settle", 0.9f, false, 0, quick ? 20 : 60},
      {"awake", 0.9f, true, quick ? 5 : 30, quick ? 15 : 90},
      {"apart", 4.0f, true, quick ? 5 : 30, quick ? 15 : 90},
  };

  std::printf("{\"tickHz\":30,\"repeats\":%d,\"rows\":[", repeats);
  bool first = true;
  for (const Scenario &scenario : scenarios) {
    for (int count : counts) {
      std::fprintf(stderr, "ragdoll-cost: %-6s %3d ragdolls\n", scenario.name,
                   count);
      std::vector<double> means;
      std::vector<double> p95s;
      double maxUs = 0.0;
      Run last;
      for (int r = 0; r < repeats; ++r) {
        last = RunScenario(count, scenario.spacing, scenario.awake,
                           scenario.warmSteps, scenario.measureSteps, shapes);
        const Stats stats = Summarize(last.stepUs);
        means.push_back(stats.mean);
        p95s.push_back(stats.p95);
        maxUs = std::max(maxUs, stats.max);
      }
      const auto [lo, hi] = std::minmax_element(means.begin(), means.end());
      std::printf(
          "%s{\"scenario\":\"%s\",\"ragdolls\":%d,\"bodies\":%d,"
          "\"constraints\":%d,\"steps\":%d,\"meanUs\":%.1f,\"p95Us\":%.1f,"
          "\"maxUs\":%.1f,\"meanUsMin\":%.1f,\"meanUsMax\":%.1f,"
          "\"maxSpeed\":%.2f}",
          first ? "" : ",", scenario.name, count, last.bodies, last.constraints,
          scenario.measureSteps, Median(means), Median(p95s), maxUs, *lo, *hi,
          double(last.maxSpeed));
      first = false;
    }
  }
  std::printf("]}\n");
  return 0;
}
