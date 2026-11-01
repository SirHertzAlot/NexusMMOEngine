/**
 * The client's physics seam. Game code (cosmetic ragdolls for other players'
 * deaths, the terrain and scatter props as static colliders) talks to this
 * interface only; the library behind it is chosen by `scripts/bench-physics.mjs`.
 *
 * Units: metres, y up. Steps are fixed: the caller passes the frame's `dt`
 * and the backend splits it into `PHYSICS_SUBSTEPS` collision steps, the
 * same two substeps as the server's tick.
 */

export const PHYSICS_SUBSTEPS = 2;

/** A rig has this many parts: head, chest, pelvis, two upper and two fore arms, two thighs, two shins. */
export const RAGDOLL_PARTS = 11;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PhysicsWorld {
  /** The library behind the seam, for benchmarks and logs. */
  readonly backend: "rapier" | "jolt";

  /** Advance the simulation by `dt` seconds (split into `PHYSICS_SUBSTEPS` steps). */
  step(dt: number): void;

  /**
   * A static heightfield centred on the origin, `size` metres square, split into
   * `cells` × `cells` squares. `heights` holds `(cells + 1)²` samples, row by row
   * along z: `heights[z * (cells + 1) + x]`, in metres.
   */
  addHeightfield(heights: Float32Array, cells: number, size: number): void;

  /** A static box, for props that block movement. Returns its handle. */
  addStaticBox(centre: Vec3, halfExtents: Vec3): number;

  /** Spawn a ragdoll rig with its root at `root`. Returns its handle. */
  spawnRagdoll(root: Vec3): number;

  /**
   * Write the rig's part centres into `out` as x, y, z per part, in the order of
   * `RAGDOLL_PARTS` (length `RAGDOLL_PARTS * 3`).
   */
  ragdollPose(handle: number, out: Float32Array): void;

  /** Remove a ragdoll and its bodies and joints. Unknown handles are ignored. */
  removeRagdoll(handle: number): void;

  /** Free the library's memory. The world is unusable afterwards. */
  dispose(): void;
}
