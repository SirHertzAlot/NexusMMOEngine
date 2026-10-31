// Ragdoll cost gate: what simulated ragdolls add to a physics step.
//
// Each ragdoll is Jolt's own Ragdoll: capsule parts joined by swing-twist
// constraints, the rig a corpse or an active ragdoll would use. The world is
// set up the way native/physics_world.cpp sets it up: this file links against
// the addon's compiled Jolt objects, with the same two object layers, gravity
// and single-threaded job system unless --threads asks for a pool. No gameplay
// code runs. The ragdolls drop onto a floor and step at the tick's 30 Hz.
//
// Scenarios, per ragdoll count:
//   settle   rigs 0.9 m apart, sleeping on; the first 2 s after the drop, while
//            they fall, land and go to sleep. The transient cost.
//   awake    rigs 0.9 m apart, sleeping off; 1 s of warm-up, then 3 s measured.
//            A crowd that never sleeps: the steady worst case.
//   apart    rigs 4 m apart, sleeping off, so none touch. A rig on its own:
//            its joints and its contacts with the floor.
//   resting  rigs 0.9 m apart, sleeping on; 5 s of warm-up, then 2 s measured.
//            Corpses that have come to rest.
//
// Options. The defaults are the bench's own: one substep per tick, a 64 MB
// temp allocator and 65,536 contacts. The engine runs two substeps with the
// addon's limits, which is --substeps 2 --production-limits.
//   --quick              three counts, one repeat, shorter scenarios
//   --counts a,b,...     ragdoll counts to run
//   --scenarios a,b,...  scenarios to run
//   --rig full|light     full: 11 bodies, 10 joints; light: 5 bodies, 4 joints
//   --substeps N         Jolt Updates per tick, each of 1/(30 N) s
//   --threads N          a Jolt thread pool of N threads (0: single-threaded)
//   --sleep-time S       seconds a body must rest before it sleeps (Jolt: 0.5)
//   --production-limits  the addon's 10 MB temp allocator and 10240 contacts
//
// Each run is repeated (three times, or once with --quick) on a fresh world,
// and the median of the repeats is reported. Writes one JSON object to stdout
// and progress to stderr. bench/run-ragdoll-cost.mjs builds and runs it.

#include <Jolt/Jolt.h>

#include <Jolt/Core/Factory.h>
#include <Jolt/Core/JobSystemSingleThreaded.h>
#include <Jolt/Core/JobSystemThreadPool.h>
#include <Jolt/Core/TempAllocator.h>
#include <Jolt/Physics/Body/BodyCreationSettings.h>
#include <Jolt/Physics/Body/BodyInterface.h>
#include <Jolt/Physics/Collision/BroadPhase/BroadPhaseLayer.h>
#include <Jolt/Physics/Collision/Shape/BoxShape.h>
#include <Jolt/Physics/Collision/Shape/CapsuleShape.h>
#include <Jolt/Physics/Constraints/SwingTwistConstraint.h>
#include <Jolt/Physics/PhysicsSettings.h>
#include <Jolt/Physics/PhysicsSystem.h>
#include <Jolt/Physics/Ragdoll/Ragdoll.h>
#include <Jolt/RegisterTypes.h>
#include <Jolt/Skeleton/Skeleton.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {

// Limits. The bench keeps every contact; --production-limits uses the values
// of native/physics_world.cpp.
constexpr JPH::uint kMaxBodies = 65536;
constexpr JPH::uint kMaxBodyPairs = 65536;
constexpr JPH::uint kBenchContacts = 65536;
constexpr JPH::uint kProductionContacts = 10240;
constexpr size_t kBenchTempBytes = 64 * 1024 * 1024;
constexpr size_t kProductionTempBytes = 10 * 1024 * 1024;
constexpr float kTickSeconds = 1.0f / 30.0f;
constexpr float kDegrees = 3.14159265358979f / 180.0f;
constexpr int kMaxParts = 11;

int gTraces = 0;

// Jolt reports ignored contacts and temp-memory exhaustion through Trace. The
// first few go to stderr, where the runner shows them.
void TraceToStderr(const char *inFormat, ...) {
  if (++gTraces > 5) return;
  va_list args;
  va_start(args, inFormat);
  std::fprintf(stderr, "ragdoll-cost: jolt: ");
  std::vfprintf(stderr, inFormat, args);
  std::fprintf(stderr, "\n");
  va_end(args);
}

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

// One capsule. Its parent joint is `parentAnchor` on the parent and
// `childAnchor` on this part. A child sits where its two anchors meet, so
// every joint starts closed.
struct PartSpec {
  const char *name;
  int parent;  // index into the rig; -1 for the root
  float halfHeight;
  float radius;
  Anchor parentAnchor;
  Anchor childAnchor;
};

constexpr PartSpec kFullParts[kMaxParts] = {
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
constexpr PartSpec kLightParts[5] = {
    {"Pelvis", -1, 0.07f, 0.14f, {0, 0, 0}, {0, 0, 0}},
    {"Spine", 0, 0.14f, 0.12f, {0, 0.21f, 0}, {0, -0.26f, 0}},
    {"Head", 1, 0.06f, 0.11f, {0, 0.26f, 0}, {0, -0.17f, 0}},
    {"LegL", 0, 0.20f, 0.07f, {0.10f, -0.15f, 0}, {0, 0.27f, 0}},
    {"LegR", 0, 0.20f, 0.07f, {-0.10f, -0.15f, 0}, {0, 0.27f, 0}},
};

struct RigSpec {
  const char *name;
  const PartSpec *parts;
  int count;
};
constexpr RigSpec kFullRig{"full", kFullParts, kMaxParts};
constexpr RigSpec kLightRig{"light", kLightParts, 5};

struct Config {
  const RigSpec *rig = &kFullRig;
  int substeps = 1;
  int threads = 0;
  float sleepTime = 0.5f;  // Jolt's default, which the addon keeps
  bool productionLimits = false;
};

// A scenario's spacing, sleeping and step counts, full and --quick.
struct Scenario {
  const char *name;
  float spacing;
  bool sleep;
  int warmSteps;
  int measureSteps;
  int quickWarmSteps;
  int quickMeasureSteps;
};
constexpr Scenario kScenarios[] = {
    {"settle", 0.9f, true, 0, 60, 0, 20},
    {"awake", 0.9f, false, 30, 90, 5, 15},
    {"apart", 4.0f, false, 30, 90, 5, 15},
    {"resting", 0.9f, true, 150, 60, 20, 15},
};

// One rig's capsule shapes, shared by every ragdoll of that rig.
std::vector<JPH::Ref<JPH::Shape>> MakeShapes(const RigSpec &rig) {
  std::vector<JPH::Ref<JPH::Shape>> shapes;
  for (int i = 0; i < rig.count; ++i) {
    shapes.emplace_back(
        new JPH::CapsuleShape(rig.parts[i].halfHeight, rig.parts[i].radius));
  }
  return shapes;
}

// Builds one ragdoll of `rig` with its root at `root`.
JPH::Ref<JPH::RagdollSettings> MakeRagdoll(
    const RigSpec &rig, const std::vector<JPH::Ref<JPH::Shape>> &shapes,
    JPH::RVec3 root, bool allowSleep) {
  JPH::Ref<JPH::RagdollSettings> settings = new JPH::RagdollSettings;
  settings->mSkeleton = new JPH::Skeleton;
  for (int i = 0; i < rig.count; ++i) {
    const PartSpec &spec = rig.parts[i];
    settings->mSkeleton->AddJoint(
        spec.name, spec.parent < 0 ? "" : rig.parts[spec.parent].name);
  }
  settings->mSkeleton->CalculateParentJointIndices();
  settings->mParts.resize(rig.count);

  JPH::RVec3 position[kMaxParts];
  for (int i = 0; i < rig.count; ++i) {
    const PartSpec &spec = rig.parts[i];
    if (spec.parent < 0) {
      position[i] = root;
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
  std::unique_ptr<JPH::TempAllocatorImpl> temp;
  std::unique_ptr<JPH::JobSystem> jobs;
  JPH::PhysicsSystem system;
  std::vector<JPH::Ref<JPH::Ragdoll>> ragdolls;
};

// A floor, plus `count` ragdolls on a grid, dropped from just above it.
std::unique_ptr<World> BuildWorld(const Config &config, int count,
                                  float spacing, bool allowSleep,
                                  const RigSpec &rig,
                                  const std::vector<JPH::Ref<JPH::Shape>> &shapes) {
  auto world = std::make_unique<World>();
  const size_t tempBytes =
      config.productionLimits ? kProductionTempBytes : kBenchTempBytes;
  const JPH::uint contacts =
      config.productionLimits ? kProductionContacts : kBenchContacts;
  world->temp = std::make_unique<JPH::TempAllocatorImpl>(
      static_cast<JPH::uint>(tempBytes));
  if (config.threads > 0) {
    world->jobs = std::make_unique<JPH::JobSystemThreadPool>(
        JPH::cMaxPhysicsJobs, JPH::cMaxPhysicsBarriers, config.threads);
  } else {
    world->jobs =
        std::make_unique<JPH::JobSystemSingleThreaded>(JPH::cMaxPhysicsJobs);
  }

  world->system.Init(kMaxBodies, 0, kMaxBodyPairs, contacts,
                     world->broadPhase, world->objectVsBroadPhase,
                     world->objectPairs);
  world->system.SetGravity(JPH::Vec3(0.0f, -9.81f, 0.0f));
  JPH::PhysicsSettings settings = world->system.GetPhysicsSettings();
  settings.mTimeBeforeSleep = config.sleepTime;
  world->system.SetPhysicsSettings(settings);

  JPH::BodyInterface &bodies = world->system.GetBodyInterface();
  JPH::Ref<JPH::Shape> floor =
      new JPH::BoxShape(JPH::Vec3(200.0f, 0.5f, 200.0f));
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
    JPH::Ref<JPH::RagdollSettings> ragdollSettings =
        MakeRagdoll(rig, shapes, root, allowSleep);
    JPH::Ref<JPH::Ragdoll> ragdoll(ragdollSettings->CreateRagdoll(
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

struct Step {
  double micros;
  unsigned errors;  // EPhysicsUpdateError bits; 0 when the step was whole
};

// One tick at 30 Hz: `substeps` Updates, each with one collision step and an
// equal share of 1/30 s, as the addon's step() runs them. Timed in microseconds.
Step StepOnce(World &world, int substeps) {
  const float subDt = kTickSeconds / float(substeps);
  unsigned errors = 0;
  const auto start = std::chrono::steady_clock::now();
  for (int i = 0; i < substeps; ++i) {
    errors |= static_cast<unsigned>(
        world.system.Update(subDt, 1, world.temp.get(), world.jobs.get()));
  }
  const auto end = std::chrono::steady_clock::now();
  return {std::chrono::duration<double, std::micro>(end - start).count(),
          errors};
}

struct Run {
  std::vector<double> stepUs;  // one entry per measured step
  unsigned errors = 0;         // every step's error bits, OR'd together
  int bodies = 0;
  int constraints = 0;
  int activeBodies = 0;  // bodies still awake when the run ends
  float maxSpeed = 0.0f;  // fastest ragdoll body at the end, m/s
};

Run RunScenario(const Config &config, const Scenario &scenario, int warmSteps,
                int measureSteps, int count,
                const std::vector<JPH::Ref<JPH::Shape>> &shapes) {
  std::unique_ptr<World> world =
      BuildWorld(config, count, scenario.spacing, scenario.sleep, *config.rig,
                 shapes);
  Run run;
  for (int i = 0; i < warmSteps; ++i) {
    run.errors |= StepOnce(*world, config.substeps).errors;
  }

  run.stepUs.reserve(measureSteps);
  for (int i = 0; i < measureSteps; ++i) {
    const Step step = StepOnce(*world, config.substeps);
    run.stepUs.push_back(step.micros);
    run.errors |= step.errors;
  }

  const JPH::BodyInterface &bodies = world->system.GetBodyInterface();
  for (const JPH::Ref<JPH::Ragdoll> &ragdoll : world->ragdolls) {
    run.constraints += int(ragdoll->GetConstraintCount());
    for (const JPH::BodyID &id : ragdoll->GetBodyIDs()) {
      run.bodies += 1;
      if (bodies.IsActive(id)) run.activeBodies += 1;
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

struct Options {
  bool quick = false;
  Config config;
  std::vector<int> counts;
  std::vector<std::string> scenarios;
};

bool ParseInt(const char *text, int &out) {
  char *end = nullptr;
  const long value = std::strtol(text, &end, 10);
  if (end == text || *end != '\0' || value < 0 || value > 1000000) return false;
  out = static_cast<int>(value);
  return true;
}

bool ParseFloat(const char *text, float &out) {
  char *end = nullptr;
  const float value = std::strtof(text, &end);
  if (end == text || *end != '\0' || !(value > 0.0f)) return false;
  out = value;
  return true;
}

// Splits "a,b,c" on commas.
std::vector<std::string> Split(const std::string &text) {
  std::vector<std::string> items;
  std::istringstream stream(text);
  std::string item;
  while (std::getline(stream, item, ',')) items.push_back(item);
  return items;
}

bool ParseOptions(int argc, char **argv, Options &options) {
  for (int i = 1; i < argc; ++i) {
    const std::string_view arg(argv[i]);
    const bool hasValue = i + 1 < argc;
    if (arg == "--quick") {
      options.quick = true;
    } else if (arg == "--production-limits") {
      options.config.productionLimits = true;
    } else if (arg == "--rig" && hasValue) {
      const std::string_view rig(argv[++i]);
      if (rig == "full") {
        options.config.rig = &kFullRig;
      } else if (rig == "light") {
        options.config.rig = &kLightRig;
      } else {
        return false;
      }
    } else if (arg == "--substeps" && hasValue) {
      if (!ParseInt(argv[++i], options.config.substeps) ||
          options.config.substeps < 1) {
        return false;
      }
    } else if (arg == "--threads" && hasValue) {
      if (!ParseInt(argv[++i], options.config.threads)) return false;
    } else if (arg == "--sleep-time" && hasValue) {
      if (!ParseFloat(argv[++i], options.config.sleepTime)) return false;
    } else if (arg == "--counts" && hasValue) {
      for (const std::string &item : Split(argv[++i])) {
        int count = 0;
        if (!ParseInt(item.c_str(), count)) return false;
        options.counts.push_back(count);
      }
    } else if (arg == "--scenarios" && hasValue) {
      options.scenarios = Split(argv[++i]);
    } else {
      return false;
    }
  }
  return true;
}

}  // namespace

int main(int argc, char **argv) {
  Options options;
  if (!ParseOptions(argc, argv, options)) {
    std::fprintf(stderr,
                 "usage: ragdoll-cost [--quick] [--counts a,b] [--scenarios a,b]"
                 " [--rig full|light] [--substeps N] [--threads N]"
                 " [--sleep-time S] [--production-limits]\n");
    return 2;
  }
  if (options.counts.empty()) {
    options.counts = options.quick
                         ? std::vector<int>{0, 16, 64}
                         : std::vector<int>{0, 8, 16, 32, 64, 128, 256, 512, 1000};
  }

  // Jolt's global setup, as native/physics_world.cpp does it.
  JPH::RegisterDefaultAllocator();
  JPH::Trace = TraceToStderr;
  JPH::Factory::sInstance = new JPH::Factory();
  JPH::RegisterTypes();

  const RigSpec &rig = *options.config.rig;
  const std::vector<JPH::Ref<JPH::Shape>> shapes = MakeShapes(rig);
  const int repeats = options.quick ? 1 : 3;

  std::printf(
      "{\"tickHz\":30,\"repeats\":%d,\"rig\":\"%s\",\"rigBodies\":%d,"
      "\"substeps\":%d,\"threads\":%d,\"sleepTime\":%.3f,"
      "\"productionLimits\":%s,\"rows\":[",
      repeats, rig.name, rig.count, options.config.substeps,
      options.config.threads, options.config.sleepTime,
      options.config.productionLimits ? "true" : "false");
  bool first = true;
  for (const Scenario &scenario : kScenarios) {
    if (!options.scenarios.empty() &&
        std::find(options.scenarios.begin(), options.scenarios.end(),
                  std::string(scenario.name)) == options.scenarios.end()) {
      continue;
    }
    const int warm =
        options.quick ? scenario.quickWarmSteps : scenario.warmSteps;
    const int measure =
        options.quick ? scenario.quickMeasureSteps : scenario.measureSteps;
    for (int count : options.counts) {
      std::fprintf(stderr,
                   "ragdoll-cost: %-7s %4d ragdolls (%s rig, %d substeps, "
                   "threads=%d)\n",
                   scenario.name, count, rig.name, options.config.substeps,
                   options.config.threads);
      std::vector<double> means;
      std::vector<double> p95s;
      double maxUs = 0.0;
      float maxSpeed = 0.0f;
      unsigned errors = 0;
      const int tracesBefore = gTraces;
      Run last;
      for (int r = 0; r < repeats; ++r) {
        last = RunScenario(options.config, scenario, warm, measure, count,
                           shapes);
        const Stats stats = Summarize(last.stepUs);
        means.push_back(stats.mean);
        p95s.push_back(stats.p95);
        maxUs = std::max(maxUs, stats.max);
        maxSpeed = std::max(maxSpeed, last.maxSpeed);
        errors |= last.errors;
      }
      const auto [lo, hi] = std::minmax_element(means.begin(), means.end());
      std::printf(
          "%s{\"scenario\":\"%s\",\"ragdolls\":%d,\"bodies\":%d,"
          "\"constraints\":%d,\"activeBodies\":%d,\"steps\":%d,"
          "\"meanUs\":%.1f,\"p95Us\":%.1f,\"maxUs\":%.1f,\"meanUsMin\":%.1f,"
          "\"meanUsMax\":%.1f,\"maxSpeed\":%.2f,\"updateErrors\":%u,"
          "\"traces\":%d}",
          first ? "" : ",", scenario.name, count, last.bodies, last.constraints,
          last.activeBodies, measure, Median(means), Median(p95s), maxUs, *lo,
          *hi, double(maxSpeed), errors, gTraces - tracesBefore);
      first = false;
      std::fflush(stdout);
    }
  }
  std::printf("]}\n");
  return 0;
}
