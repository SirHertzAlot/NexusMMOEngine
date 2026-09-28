// Type definitions for @mmo-engine/addon-physics.

export declare const ShapeKind: Readonly<{
  Box: 0;
  Sphere: 1;
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
  syncBodies(
    count: number,
    entityIds: BigUint64Array,
    pos: Float32Array,
    quat: Float32Array,
    linVel: Float32Array,
    angVel: Float32Array,
    flags: Uint8Array,
    dt: number,
  ): void;
  step(dt: number, subSteps: number): void;
  copyResults(
    count: number,
    entityIds: BigUint64Array,
    pos: Float32Array,
    quat: Float32Array,
    linVel: Float32Array,
    angVel: Float32Array,
  ): void;
  bodyCount(): number;
  destroy(): void;
}

export declare function createWorld(): PhysicsWorld;
