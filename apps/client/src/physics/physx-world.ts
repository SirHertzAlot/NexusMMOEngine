/**
 * The physics seam on PhysX 5.12 (CPU, `physx-js-webidl`). Runs only in a
 * browser: the loader refuses Node. Same scene model as the Rapier backend.
 * Walkers use PhysX's capsule character controller, the counterpart of
 * Rapier's kinematic character controller: it slides along what blocks it,
 * steps up small ledges, and stays on the ground.
 */

import { PHYSICS_SUBSTEPS, RAGDOLL_PARTS, type PhysicsWorld, type Vec3, type WalkerState } from "./physics-world.js";
import { RIG_JOINTS, RIG_PARTS } from "./ragdoll-rig.js";

// physx-js-webidl's typings are loose for the parts used here; `Px` keeps the
// rest of the surface readable without a second declaration file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Px = any;

interface Rig {
  readonly actors: Px[];
}

interface Walker {
  readonly controller: Px;
}

const DEG = Math.PI / 180;
/** Step height a walker climbs without jumping, metres. */
const STEP_HEIGHT = 0.35;
/** Gap kept between a walker and what it touches, metres. */
const SKIN = 0.01;
/**
 * Downward pull added to every walker move, metres per tick. The controller
 * stops at the ground, so this keeps a walker on a slope it walks down and is
 * the controller's stand-in for gravity.
 */
const GROUND_PULL = 0.1;
const MOVE_DT = 1 / 60;

export async function createPhysxPhysicsWorld(): Promise<PhysicsWorld> {
  const { default: PHYSX } = (await import("physx-js-webidl")) as { default: () => Promise<Px> };
  const P: Px = await PHYSX();
  const T: Px = P;
  const version = T.PHYSICS_VERSION;
  const foundation = T.CreateFoundation(version, new P.PxDefaultAllocator(), new P.PxDefaultErrorCallback());
  const tolerances = new P.PxTolerancesScale();
  const physics = T.CreatePhysics(version, foundation, tolerances);
  T.InitExtensions(physics);
  const material = physics.createMaterial(0.6, 0.6, 0.1);

  const sceneDesc = new P.PxSceneDesc(tolerances);
  sceneDesc.gravity = new P.PxVec3(0, -9.81, 0);
  sceneDesc.cpuDispatcher = T.DefaultCpuDispatcherCreate(0); // inline: the wasm build hangs with a worker thread
  sceneDesc.filterShader = T.DefaultFilterShader();
  const scene = physics.createScene(sceneDesc);
  const controllers: Px = T.CreateControllerManager(scene);
  const filters = new P.PxControllerFilters();
  const collisionDown = P.PxControllerCollisionFlagEnum.eCOLLISION_DOWN;

  const vec = (x: number, y: number, z: number): Px => new P.PxVec3(x, y, z);
  const tf = (x: number, y: number, z: number): Px => new P.PxTransform(vec(x, y, z), new P.PxQuat(0, 0, 0, 1));
  // Embind objects are not garbage collected: every temporary is deleted.
  const posOf = (actor: Px): Vec3 => {
    const pose = actor.getGlobalPose();
    const p = pose.p;
    const out = { x: p.x as number, y: p.y as number, z: p.z as number };
    p.delete?.();
    pose.delete?.();
    return out;
  };
  // The default filter shader collides only shapes whose filter words overlap.
  const shapeOf = (geometry: Px): Px => {
    const shape = physics.createShape(geometry, material, true);
    shape.setSimulationFilterData(new P.PxFilterData(1, 1, 0, 0));
    return shape;
  };
  const dynamicAt = (pose: Px, geometry: Px, mass: number): Px => {
    const actor = physics.createRigidDynamic(pose);
    actor.attachShape(shapeOf(geometry));
    actor.setMass(mass);
    actor.setMassSpaceInertiaTensor(vec(0.1, 0.1, 0.1));
    return actor;
  };

  const rigs = new Map<number, Rig>();
  const walkers = new Map<number, Walker>();
  let nextHandle = 1;

  return {
    backend: "physx",

    step(dt: number): void {
      for (let s = 0; s < PHYSICS_SUBSTEPS; s++) {
        scene.simulate(dt / PHYSICS_SUBSTEPS);
        scene.fetchResults(true);
      }
    },

    addHeightfield(heights: Float32Array, cells: number, size: number): void {
      const n = cells + 1;
      if (heights.length !== n * n) {
        throw new Error(`heightfield needs ${n * n} samples, got ${heights.length}`);
      }
      // Samples are int16 in 0.01 m units. PhysX indexes a sample as row * n + column
      // with rows along x, while the seam's contract is row by row along z
      // (heights[z * n + x]). Transpose so a sample lands where the seam says.
      const samples = new P.PxArray_PxHeightFieldSample(n * n);
      for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
        const sample = new P.PxHeightFieldSample();
        sample.height = Math.round(heights[z * n + x]! / 0.01);
        samples.set(x * n + z, sample);
        sample.delete?.();
      }
      const desc = new P.PxHeightFieldDesc();
      desc.nbRows = n;
      desc.nbColumns = n;
      desc.samples.data = samples.begin();
      desc.samples.stride = 4;
      desc.samples.count = n * n;
      const hf = T.CreateHeightField(desc);
      const cell = size / cells;
      const geometry = new P.PxHeightFieldGeometry(hf, new P.PxMeshGeometryFlags(0), 0.01, cell, cell);
      // The field is centred on the origin, so its corner sits at (-size/2, 0, -size/2).
      const actor = physics.createRigidStatic(tf(-size / 2, 0, -size / 2));
      actor.attachShape(shapeOf(geometry));
      scene.addActor(actor);
    },

    addStaticBox(centre: Vec3, half: Vec3): number {
      const actor = physics.createRigidStatic(tf(centre.x, centre.y, centre.z));
      actor.attachShape(shapeOf(new P.PxBoxGeometry(half.x, half.y, half.z)));
      scene.addActor(actor);
      return nextHandle++;
    },

    spawnRagdoll(root: Vec3): number {
      const actors = RIG_PARTS.map((part) => {
        const [hx, hy, hz] = part.halfExtents;
        const actor = dynamicAt(
          tf(root.x + part.centre[0], root.y + part.centre[1], root.z + part.centre[2]),
          new P.PxBoxGeometry(hx, hy, hz),
          1,
        );
        scene.addActor(actor);
        return actor;
      });
      for (const [a, b] of RIG_JOINTS) {
        const pa = RIG_PARTS[a]!.centre;
        const pb = RIG_PARTS[b]!.centre;
        const mid = [0, 1, 2].map((k) => (pa[k]! + pb[k]!) / 2);
        const local = (pc: readonly number[]) => tf(mid[0]! - pc[0]!, mid[1]! - pc[1]!, mid[2]! - pc[2]!);
        T.SphericalJointCreate(physics, actors[a], local(pa), actors[b], local(pb));
      }
      const handle = nextHandle++;
      rigs.set(handle, { actors });
      return handle;
    },

    ragdollPose(handle: number, out: Float32Array): void {
      const rig = rigs.get(handle);
      if (!rig) return;
      if (out.length < RAGDOLL_PARTS * 3) throw new Error("pose buffer too small");
      rig.actors.forEach((actor, i) => {
        const p = posOf(actor);
        out[i * 3] = p.x;
        out[i * 3 + 1] = p.y;
        out[i * 3 + 2] = p.z;
      });
    },

    removeRagdoll(handle: number): void {
      const rig = rigs.get(handle);
      if (!rig) return;
      for (const actor of rig.actors) {
        scene.removeActor(actor, true);
      }
      rigs.delete(handle);
    },

    spawnWalker(centre: Vec3, radius: number, halfHeight: number): number {
      const desc = new P.PxCapsuleControllerDesc();
      desc.height = halfHeight * 2; // the straight part, caps excluded
      desc.radius = radius;
      desc.position = new P.PxExtendedVec3(centre.x, centre.y, centre.z);
      desc.upDirection = vec(0, 1, 0);
      desc.slopeLimit = Math.cos(45 * DEG);
      desc.stepOffset = STEP_HEIGHT;
      desc.contactOffset = SKIN;
      desc.material = material;
      const controller = controllers.createController(desc);
      desc.delete?.();
      const handle = nextHandle++;
      walkers.set(handle, { controller });
      return handle;
    },

    moveWalker(handle: number, delta: Vec3): WalkerState {
      const w = walkers.get(handle);
      if (!w) return { x: 0, y: 0, z: 0, grounded: false };
      const disp = vec(delta.x, delta.y - GROUND_PULL, delta.z);
      const flags = w.controller.move(disp, 0, MOVE_DT, filters);
      disp.delete?.();
      const grounded = flags.isSet(collisionDown);
      flags.delete?.();
      const p = w.controller.getPosition();
      const out = { x: p.x as number, y: p.y as number, z: p.z as number, grounded };
      p.delete?.();
      return out;
    },

    teleportWalker(handle: number, centre: Vec3): void {
      const w = walkers.get(handle);
      if (!w) return;
      w.controller.setPosition(new P.PxExtendedVec3(centre.x, centre.y, centre.z));
    },

    removeWalker(handle: number): void {
      const w = walkers.get(handle);
      if (!w) return;
      w.controller.release();
      walkers.delete(handle);
    },

    dispose(): void {
      controllers.release?.();
      scene.release?.();
      rigs.clear();
      walkers.clear();
    },
  };
}
