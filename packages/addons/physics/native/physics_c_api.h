// @mmo-engine/addon-physics — C ABI boundary (Phase 2).
//
// The node-gyp translation unit (src/physics.cc) includes ONLY this
// header — never Jolt headers. That confines Jolt's compile defines,
// architecture flags (AVX2/SSE, JPH_OBJECT_LAYER_BITS, ...) and LTO
// settings to the CMake build, where Jolt's own machinery sets them.
// The N-API shim therefore cannot introduce an ABI mismatch, no
// matter what the host compiler defaults to.
//
// Conventions:
// - Entity identity: the JS side passes its u64 wire ids
//   (generation << 32 | slot). The native entity->BodyID map never
//   crosses to JS; BodyIDs are purely native.
// - Shape kinds: 0 = box (uses half_extents), 1 = sphere (uses radius).
//   Mirrors the BodyConfig ShapeKind enum in mmo_engine.fbs.
// - Motion types: 0 = static, 1 = kinematic, 2 = dynamic.
//   Mirrors the BodyConfig MotionType enum in mmo_engine.fbs.
// - All bulk calls take plain SoA arrays; `n` is the element count.
// - Threading: every function must be called from the JS thread only.
//   Jolt's internal job threads are its own business; the world is
//   never touched concurrently from two threads.

#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque native physics world (Jolt PhysicsSystem + allocator + job
// system + entity->BodyID map).
typedef struct mj_physics_world mj_physics_world_t;

// Shape kinds (mirror mmo_engine.fbs ShapeKind).
#define MJ_SHAPE_BOX 0
#define MJ_SHAPE_SPHERE 1
/* Upright capsule: radius + half_extents.y (half the straight section),
   base at the body's origin. */
#define MJ_SHAPE_CAPSULE 2

// Motion types (mirror mmo_engine.fbs MotionType).
#define MJ_MOTION_STATIC 0
#define MJ_MOTION_KINEMATIC 1
#define MJ_MOTION_DYNAMIC 2

// syncBodies flags.
#define MJ_SYNC_TELEPORT 0x01 // dynamic bodies: force-set transform

mj_physics_world_t *mj_physics_create(void);
void mj_physics_destroy(mj_physics_world_t *world);

// Bulk-add bodies. All arrays have `n` elements; vector arrays are
// packed xyz (3*n) / xyzw (4*n).
void mj_physics_add_bodies(mj_physics_world_t *world, int n,
                           const uint64_t *entity_ids,
                           const uint8_t *shape_kind,
                           const float *half_extents, // 3*n
                           const float *radius,       // n
                           const float *mass,         // n
                           const float *friction,     // n
                           const float *restitution,   // n
                           const uint8_t *motion_type,
                           const uint8_t *layer,
                           const float *pos,   // 3*n
                           const float *quat,  // 4*n, xyzw
                           const float *lin_vel, // 3*n, initial linear velocity
                           const float *ang_vel);// 3*n, initial angular velocity

void mj_physics_remove_bodies(mj_physics_world_t *world, int n,
                              const uint64_t *entity_ids);

// Push JS-side transforms into native bodies. Kinematic bodies follow
// (Jolt MoveKinematic); dynamic bodies ignore the call unless
// MJ_SYNC_TELEPORT is set in flags[i].
// Phase 2 (zero-copy): px..qw are the SAB-backed bitECS Transform
// component arrays, indexed by eids[i] (bitECS entity index), NOT by
// list position. entity_ids[i] is the wire id for the body lookup.
void mj_physics_sync_bodies(mj_physics_world_t *world, int n,
                            const uint64_t *entity_ids,
                            const int32_t *eids,
                            const float *px, const float *py,
                            const float *pz, const float *qx,
                            const float *qy, const float *qz,
                            const float *qw, const uint8_t *flags,
                            float dt);

// Advance the simulation by dt seconds, internally substepped
// sub_steps times (each substep runs one Jolt Update with a single
// collision step — the fixed-timestep pattern Jolt recommends).
void mj_physics_step(mj_physics_world_t *world, float dt, int sub_steps);

// Pull results back into the caller arrays (bitECS Transform + Velocity
// component arrays, indexed by eids[i]). Phase 2 zero-copy: C++ writes
// directly into the SAB-backed component stores.
void mj_physics_copy_results(mj_physics_world_t *world, int n,
                             const uint64_t *entity_ids,
                             const int32_t *eids,
                             float *px, float *py, float *pz,
                             float *qx, float *qy, float *qz, float *qw,
                             float *lx, float *ly, float *lz,
                             float *ax, float *ay, float *az);

// Number of bodies currently in the native world (diagnostics).
int mj_physics_body_count(mj_physics_world_t *world);

/*
 * Terrain: one static height-field body per chunk tile, keyed by a
 * caller-chosen u64 (a chunk key — its own id space, separate from
 * entity ids). `samples` holds side*side heights, row-major with X inner
 * (samples[z*side + x]); sample (x, z) sits at world
 * (origin_x + x*spacing, height, origin_z + z*spacing). Each cell splits
 * into triangles along its (x+1, z)-(x, z+1) diagonal, like the engine's
 * terrain mesh. Adding an existing key replaces it (a sculpted chunk).
 * Returns 1 on success, 0 on invalid input (side must be even, >= 4).
 */
int mj_physics_add_terrain(mj_physics_world_t *world, uint64_t key,
                           float origin_x, float origin_z, float spacing,
                           int side, const float *samples, float friction);

void mj_physics_remove_terrain(mj_physics_world_t *world, uint64_t key);

int mj_physics_terrain_count(mj_physics_world_t *world);

#ifdef __cplusplus
}
#endif
