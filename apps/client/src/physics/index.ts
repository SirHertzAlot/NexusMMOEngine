import { createPhysxPhysicsWorld } from "./physx-world.js";
import type { PhysicsWorld } from "./physics-world.js";
export { createPhysxPhysicsWorld } from "./physx-world.js";
export {
  PHYSICS_SUBSTEPS,
  RAGDOLL_PARTS,
  type PhysicsWorld,
  type Vec3,
  type WalkerState,
} from "./physics-world.js";
export { WalkerPredictor, type PredictionOptions, type Snapshot } from "./walker-prediction.js";

/**
 * The client's physics world: PhysX, the library chosen for CPU performance
 * and the browser target.
 *
 * There is one backend in the client. Rapier was selectable here and is not
 * any more: `./rapier-world.ts` stays as the seam's second implementation for
 * tests, because the PhysX build we pin is compiled for the web and refuses
 * to start under Node. Nothing the client ships imports it.
 */
export async function createClientPhysicsWorld(): Promise<PhysicsWorld> {
  return createPhysxPhysicsWorld();
}
