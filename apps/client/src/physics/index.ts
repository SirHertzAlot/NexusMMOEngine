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
 * The client's physics world. Both backends are supported and a game picks
 * either; `physx` is the default.
 *
 * Measured on one scene, 200 awake rigs (`npm run bench:physics`, #543):
 *
 * | Backend  | ms per tick | bundle, gzipped | runs under Node |
 * |----------|-------------|-----------------|-----------------|
 * | `physx`  | 15.7        | ~2.0 MB         | no              |
 * | `rapier` | 32.9        | ~1.6 MB         | yes             |
 *
 * So PhysX is about twice as fast awake and about 0.4 MB larger. Rapier is
 * the one that runs outside a browser: the `physx-js-webidl` build we pin is
 * compiled for the web and answers "not compiled for this environment" under
 * Node, so a test or a headless tool that needs physics uses Rapier (as
 * `test/physics-world.test.ts` and the two beside it do).
 *
 * Neither is a fallback for the other; they are a choice, and the numbers
 * above are the basis for making it. Re-run the benchmark rather than trust
 * these if the version of either moves.
 */
export async function createClientPhysicsWorld(backend: ClientPhysicsBackend = "physx"): Promise<PhysicsWorld> {
  return backend === "rapier" ? createRapierPhysicsWorld() : createPhysxPhysicsWorld();
}
