# @mmo-engine/addon-physics — node-gyp build for the Jolt physics addon.
#
# Jolt's sources compile directly as node-gyp sources alongside the native
# wrapper (native/physics_world.cpp) and the N-API shim (src/physics.cc).
# No CMake, no bash, no shell globs — only a C++17 compiler is required,
# so `npm install` works from a clean clone on Windows, macOS and Linux.
#
# The Jolt source list below is extracted from the vendored tree's own
# Jolt/Jolt.cmake (JOLT_PHYSICS_SRC_FILES), minus the Windows-only DX12
# compute backend (the addon uses CPU compute). The vendored tree is
# pinned (see third_party/JoltPhysics/VENDORING.md); if it is ever
# updated, refresh this list from Jolt.cmake.
#
# Boundary shape (bulk, SoA, DOD):
# - The N-API shim (src/physics.cc) includes ONLY native/physics_c_api.h
#   (pure C) — never Jolt headers — so it needs none of Jolt's flags.
# - native/physics_world.cpp is the single TU that includes Jolt headers;
#   it is compiled in this same target so Jolt's configuration can never
#   drift between translation units.
#
# SIMD note: Jolt's CMake enables AVX2/AVX512 when the compiler supports
# it. Here we compile the portable baseline (no JPH_USE_* defines), which
# is correct on every x86-64 CPU. Per the design docs, determinism is
# guaranteed per-machine (same binary + same call order), not
# cross-platform, so this is a pure performance tradeoff. Add
# /arch:AVX2 + JPH_USE_AVX2 (MSVC) or -mavx2 + JPH_USE_AVX2 (GCC/Clang)
# if profiling warrants it.
{
  "targets": [
    {
      "target_name": "physics",
      "sources": [
        "src/physics.cc",
        "native/physics_world.cpp",
        "third_party/JoltPhysics/Jolt/AABBTree/AABBTreeBuilder.cpp",
        "third_party/JoltPhysics/Jolt/Compute/CPU/ComputeBufferCPU.cpp",
        "third_party/JoltPhysics/Jolt/Compute/CPU/ComputeQueueCPU.cpp",
        "third_party/JoltPhysics/Jolt/Compute/CPU/ComputeSystemCPU.cpp",
        "third_party/JoltPhysics/Jolt/Compute/ComputeSystem.cpp",
        "third_party/JoltPhysics/Jolt/Compute/VK/ComputeBufferVK.cpp",
        "third_party/JoltPhysics/Jolt/Compute/VK/ComputeQueueVK.cpp",
        "third_party/JoltPhysics/Jolt/Compute/VK/ComputeShaderVK.cpp",
        "third_party/JoltPhysics/Jolt/Compute/VK/ComputeSystemVK.cpp",
        "third_party/JoltPhysics/Jolt/Compute/VK/ComputeSystemVKImpl.cpp",
        "third_party/JoltPhysics/Jolt/Compute/VK/ComputeSystemVKWithAllocator.cpp",
        "third_party/JoltPhysics/Jolt/Core/Color.cpp",
        "third_party/JoltPhysics/Jolt/Core/Factory.cpp",
        "third_party/JoltPhysics/Jolt/Core/IssueReporting.cpp",
        "third_party/JoltPhysics/Jolt/Core/JobSystemSingleThreaded.cpp",
        "third_party/JoltPhysics/Jolt/Core/JobSystemThreadPool.cpp",
        "third_party/JoltPhysics/Jolt/Core/JobSystemWithBarrier.cpp",
        "third_party/JoltPhysics/Jolt/Core/LinearCurve.cpp",
        "third_party/JoltPhysics/Jolt/Core/Memory.cpp",
        "third_party/JoltPhysics/Jolt/Core/Profiler.cpp",
        "third_party/JoltPhysics/Jolt/Core/RTTI.cpp",
        "third_party/JoltPhysics/Jolt/Core/Semaphore.cpp",
        "third_party/JoltPhysics/Jolt/Core/StringTools.cpp",
        "third_party/JoltPhysics/Jolt/Core/TickCounter.cpp",
        "third_party/JoltPhysics/Jolt/Geometry/ConvexHullBuilder.cpp",
        "third_party/JoltPhysics/Jolt/Geometry/ConvexHullBuilder2D.cpp",
        "third_party/JoltPhysics/Jolt/Geometry/Indexify.cpp",
        "third_party/JoltPhysics/Jolt/Geometry/OrientedBox.cpp",
        "third_party/JoltPhysics/Jolt/Math/Vec3.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/ObjectStream.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/ObjectStreamBinaryIn.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/ObjectStreamBinaryOut.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/ObjectStreamIn.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/ObjectStreamOut.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/ObjectStreamTextIn.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/ObjectStreamTextOut.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/SerializableObject.cpp",
        "third_party/JoltPhysics/Jolt/ObjectStream/TypeDeclarations.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Body/Body.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Body/BodyCreationSettings.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Body/BodyInterface.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Body/BodyManager.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Body/MassProperties.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Body/MotionProperties.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Character/Character.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Character/CharacterBase.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Character/CharacterVirtual.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/BroadPhase/BroadPhase.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/BroadPhase/BroadPhaseBruteForce.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/BroadPhase/BroadPhaseQuadTree.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/BroadPhase/QuadTree.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/CastConvexVsTriangles.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/CastSphereVsTriangles.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/CollideConvexVsTriangles.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/CollideSphereVsTriangles.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/CollisionDispatch.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/CollisionGroup.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/EstimateCollisionResponse.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/GroupFilter.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/GroupFilterTable.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/ManifoldBetweenTwoFaces.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/NarrowPhaseQuery.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/NarrowPhaseStats.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/PhysicsMaterial.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/PhysicsMaterialSimple.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/BoxShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/CapsuleShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/CompoundShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/ConvexHullShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/ConvexShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/CylinderShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/DecoratedShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/EmptyShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/HeightFieldShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/MeshShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/MutableCompoundShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/OffsetCenterOfMassShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/PlaneShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/RotatedTranslatedShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/ScaledShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/Shape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/SphereShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/StaticCompoundShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/TaperedCapsuleShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/TaperedCylinderShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/Shape/TriangleShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Collision/TransformedShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/ConeConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/Constraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/ConstraintManager.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/ContactConstraintManager.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/DistanceConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/FixedConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/GearConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/HingeConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/MotorSettings.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/PathConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/PathConstraintPath.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/PathConstraintPathHermite.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/PointConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/PulleyConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/RackAndPinionConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/SixDOFConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/SliderConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/SpringSettings.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/SwingTwistConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Constraints/TwoBodyConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/DeterminismLog.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Hair/Hair.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Hair/HairSettings.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Hair/HairShaders.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Hair/RegisterHair.cpp",
        "third_party/JoltPhysics/Jolt/Physics/IslandBuilder.cpp",
        "third_party/JoltPhysics/Jolt/Physics/LargeIslandSplitter.cpp",
        "third_party/JoltPhysics/Jolt/Physics/PhysicsScene.cpp",
        "third_party/JoltPhysics/Jolt/Physics/PhysicsSystem.cpp",
        "third_party/JoltPhysics/Jolt/Physics/PhysicsUpdateContext.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Ragdoll/Ragdoll.cpp",
        "third_party/JoltPhysics/Jolt/Physics/SoftBody/SoftBodyCreationSettings.cpp",
        "third_party/JoltPhysics/Jolt/Physics/SoftBody/SoftBodyMotionProperties.cpp",
        "third_party/JoltPhysics/Jolt/Physics/SoftBody/SoftBodyShape.cpp",
        "third_party/JoltPhysics/Jolt/Physics/SoftBody/SoftBodySharedSettings.cpp",
        "third_party/JoltPhysics/Jolt/Physics/StateRecorderImpl.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/MotorcycleController.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/TrackedVehicleController.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleAntiRollBar.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleCollisionTester.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleConstraint.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleController.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleDifferential.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleEngine.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleTrack.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/VehicleTransmission.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/Wheel.cpp",
        "third_party/JoltPhysics/Jolt/Physics/Vehicle/WheeledVehicleController.cpp",
        "third_party/JoltPhysics/Jolt/RegisterTypes.cpp",
        "third_party/JoltPhysics/Jolt/Renderer/DebugRenderer.cpp",
        "third_party/JoltPhysics/Jolt/Renderer/DebugRendererPlayback.cpp",
        "third_party/JoltPhysics/Jolt/Renderer/DebugRendererRecorder.cpp",
        "third_party/JoltPhysics/Jolt/Renderer/DebugRendererSimple.cpp",
        "third_party/JoltPhysics/Jolt/Shaders/HairWrapper.cpp",
        "third_party/JoltPhysics/Jolt/Shaders/TestComputeWrapper.cpp",
        "third_party/JoltPhysics/Jolt/Skeleton/SkeletalAnimation.cpp",
        "third_party/JoltPhysics/Jolt/Skeleton/Skeleton.cpp",
        "third_party/JoltPhysics/Jolt/Skeleton/SkeletonMapper.cpp",
        "third_party/JoltPhysics/Jolt/Skeleton/SkeletonPose.cpp",
        "third_party/JoltPhysics/Jolt/TriangleSplitter/TriangleSplitter.cpp",
        "third_party/JoltPhysics/Jolt/TriangleSplitter/TriangleSplitterBinning.cpp",
        "third_party/JoltPhysics/Jolt/TriangleSplitter/TriangleSplitterMean.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/JoltPhysics",
        "native"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17", "-fno-exceptions", "-O3", "-ffast-math", "-mavx2", "-mfma"],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fno-exceptions", "-O3", "-ffast-math", "-mavx2", "-mfma"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          # /MP: parallelize TU compilation across cores (Windows-only;
          # msvs_settings is ignored by the make generator elsewhere).
          "MultiProcessorCompilation": "true",
          "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2", "/fp:fast", "/arch:AVX2"]
        }
      },
    }
  ]
}
