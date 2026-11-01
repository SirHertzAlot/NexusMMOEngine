import { createRapierPhysicsWorld } from "./rapier-world.js";
import { createPhysxPhysicsWorld } from "./physx-world.js";
import type { PhysicsWorld } from "./physics-world.js";
export { createRapierPhysicsWorld } from "./rapier-world.js";
export { createPhysxPhysicsWorld } from "./physx-world.js";
export {
  PHYSICS_SUBSTEPS,
  RAGDOLL_PARTS,
  type PhysicsWorld,
  type Vec3,
  type WalkerState,
} from "./physics-world.js";
export { WalkerPredictor, type PredictionOptions, type Snapshot } from "./walker-prediction.js";

export type ClientPhysicsBackend = "physx" | "rapier";

/**
 * The client's physics world. PhysX is the default (the client library chosen
 * for CPU performance and the browser target); Rapier stays selectable as a fallback.
 */
export async function createClientPhysicsWorld(backend: ClientPhysicsBackend = "physx"): Promise<PhysicsWorld> {
  return backend === "rapier" ? createRapierPhysicsWorld() : createPhysxPhysicsWorld();
}
