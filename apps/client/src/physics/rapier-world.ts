/**
 * The physics seam on Rapier (WASM, `@dimforge/rapier3d-compat`). Chosen over
 * Jolt by `scripts/bench-physics.mjs` (see the PR body): equal or faster for
 * awake rigs, which is the budget case.
 */

import RAPIER from "@dimforge/rapier3d-compat";
import {
  PHYSICS_SUBSTEPS,
  RAGDOLL_PARTS,
  type PhysicsWorld,
  type Vec3,
} from "./physics-world.js";
import { RIG_JOINTS, RIG_PARTS } from "./ragdoll-rig.js";

interface Rig {
  readonly bodies: RAPIER.RigidBody[];
}

export async function createRapierPhysicsWorld(): Promise<PhysicsWorld> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const rigs = new Map<number, Rig>();
  let nextHandle = 1;

  return {
    backend: "rapier",

    step(dt: number): void {
      world.timestep = dt / PHYSICS_SUBSTEPS;
      for (let s = 0; s < PHYSICS_SUBSTEPS; s++) world.step();
    },

    addHeightfield(heights: Float32Array, cells: number, size: number): void {
      const n = cells + 1;
      if (heights.length !== n * n) {
        throw new Error(`heightfield needs ${n * n} samples, got ${heights.length}`);
      }
      // Rapier reads its heights column by column (z fastest), the seam's rows
      // run along x. Transpose so a sample lands where the seam says it does.
      const columns = new Float32Array(n * n);
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) columns[x * n + z] = heights[z * n + x]!;
      world.createCollider(RAPIER.ColliderDesc.heightfield(cells, cells, columns, { x: size, y: 1, z: size }));
    },

    addStaticBox(centre: Vec3, half: Vec3): number {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(centre.x, centre.y, centre.z),
      );
      return nextHandle++;
    },

    spawnRagdoll(root: Vec3): number {
      const bodies = RIG_PARTS.map((part) => {
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(
            root.x + part.centre[0],
            root.y + part.centre[1],
            root.z + part.centre[2],
          ),
        );
        const [hx, hy, hz] = part.halfExtents;
        world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz), body);
        return body;
      });
      for (const [a, b] of RIG_JOINTS) {
        const pa = RIG_PARTS[a]!.centre;
        const pb = RIG_PARTS[b]!.centre;
        const mid = [0, 1, 2].map((k) => (pa[k]! + pb[k]!) / 2);
        const local = (pc: readonly number[]) => ({ x: mid[0]! - pc[0]!, y: mid[1]! - pc[1]!, z: mid[2]! - pc[2]! });
        world.createImpulseJoint(RAPIER.JointData.spherical(local(pa), local(pb)), bodies[a]!, bodies[b]!, true);
      }
      const handle = nextHandle++;
      rigs.set(handle, { bodies });
      return handle;
    },

    ragdollPose(handle: number, out: Float32Array): void {
      const rig = rigs.get(handle);
      if (!rig) return;
      if (out.length < RAGDOLL_PARTS * 3) throw new Error("pose buffer too small");
      rig.bodies.forEach((body, i) => {
        const t = body.translation();
        out[i * 3] = t.x;
        out[i * 3 + 1] = t.y;
        out[i * 3 + 2] = t.z;
      });
    },

    removeRagdoll(handle: number): void {
      const rig = rigs.get(handle);
      if (!rig) return;
      for (const body of rig.bodies) world.removeRigidBody(body);
      rigs.delete(handle);
    },

    dispose(): void {
      world.free();
      rigs.clear();
    },
  };
}
