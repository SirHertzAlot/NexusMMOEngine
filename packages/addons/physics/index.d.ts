// Type definitions for @mmo-engine/addon-physics.

export declare const ShapeKind: Readonly<{
  Box: 0;
  Sphere: 1;
  Capsule: 2;
}>;

export declare const MotionType: Readonly<{
  Static: 0;
  Kinematic: 1;
  Dynamic: 2;
}>;

export declare const SyncFlags: Readonly<{
  None: 0;
  Teleport: 0x01;
}>;

export interface AddBodiesDescriptor {
  count: number;
  entityIds: BigUint64Array;
  shapeKind: Uint8Array;
  halfExtents: Float32Array; // 3 * count
  radius: Float32Array; // count
  mass: Float32Array; // count
  friction: Float32Array; // count
  restitution: Float32Array; // count
  motionType: Uint8Array;
  layer: Uint8Array;
  pos: Float32Array; // 3 * count
  quat: Float32Array; // 4 * count, xyzw
  linVel: Float32Array; // 3 * count
  angVel: Float32Array; // 3 * count
}

export declare class PhysicsWorld {
  addBodies(desc: AddBodiesDescriptor): void;
  removeBodies(entityIds: BigUint64Array): void;
  /**
   * Phase 2 (zero-copy): px..qw are the SAB-backed bitECS Transform
   * component arrays, indexed by eids[i]. entityIds[i] is the wire id
   * for the native body lookup.
   */
  syncBodies(
    count: number,
    entityIds: BigUint64Array,
    eids: Int32Array,
    px: Float32Array,
    py: Float32Array,
    pz: Float32Array,
    qx: Float32Array,
    qy: Float32Array,
    qz: Float32Array,
    qw: Float32Array,
    flags: Uint8Array,
    dt: number,
  ): void;
  step(dt: number, subSteps: number): void;
  /**
   * Phase 2 (zero-copy): px..az are the SAB-backed bitECS Transform +
   * Velocity component arrays, indexed by eids[i]. C++ writes results
   * directly into them; no dense scratch, no JS copy-back.
   */
  copyResults(
    count: number,
    entityIds: BigUint64Array,
    eids: Int32Array,
    px: Float32Array,
    py: Float32Array,
    pz: Float32Array,
    qx: Float32Array,
    qy: Float32Array,
    qz: Float32Array,
    qw: Float32Array,
    lx: Float32Array,
    ly: Float32Array,
    lz: Float32Array,
    ax: Float32Array,
    ay: Float32Array,
    az: Float32Array,
  ): void;
  bodyCount(): number;
  /**
   * One static height-field body per terrain chunk, keyed by `key` (its
   * own id space). samples: side*side heights, row-major, X inner; sample
   * (x, z) at world (originX + x*spacing, h, originZ + z*spacing). Cells
   * split along the (x+1, z)-(x, z+1) diagonal, like the engine's terrain
   * mesh. Re-adding a key replaces it. Returns false on invalid input.
   */
  addTerrain(key: bigint, originX: number, originZ: number, spacing: number, samples: Float32Array, friction: number): boolean;
  removeTerrain(key: bigint): void;
  terrainCount(): number;

  /**
   * Server ragdolls: Jolt's Ragdoll, one per id, in the same physics system as
   * the bodies. `ids` are u64 wire ids; `pos` holds 3 floats per id, the root
   * where each rig is dropped. A full rig costs 5 budget units, a light rig 2;
   * the default budget is 240 (48 full or 120 light rigs). Throws RangeError
   * when the batch would exceed the budget, repeats an id or reuses one already
   * present, or the rig kind is unknown. A refused batch changes nothing.
   */
  addRagdolls(ids: BigUint64Array, rigKind: number, pos: Float32Array): void;
  /** Removes rigs; unknown ids are ignored. */
  removeRagdolls(ids: BigUint64Array): void;
  /** Writes each rig's root position into pos (3 floats per id); NaN if unknown. */
  copyRagdollRoots(ids: BigUint64Array, pos: Float32Array): void;
  ragdollCount(): number;
  ragdollUnits(): number;
  ragdollBudget(): number;
  /** A lower budget refuses new rigs; rigs already present stay. */
  setRagdollBudget(units: number): void;
  /** Jolt's point-velocity sleep threshold in m/s (default 0.03). A larger value lets resting bodies sleep sooner. */
  sleepThreshold(): number;
  setSleepThreshold(metresPerSecond: number): void;
  /** Ragdoll bodies Jolt is simulating now; sleeping bodies do not count. */
  ragdollActiveBodies(): number;
  destroy(): void;
}

/** Rig kinds for PhysicsWorld.addRagdolls: 11 bodies, or 5 with no arms. */
export declare const RagdollRig: Readonly<{
  Full: 0;
  Light: 1;
}>;

export declare function createWorld(): PhysicsWorld;
