/**
 * CorpseProxy: the drawn body of a dead animal's ragdoll corpse. One box per
 * rig part, sized from RIG_PARTS and placed from the physics pose each frame.
 * Placeholder geometry for now: the corpse shows the rig, not the animal's mesh.
 * Cosmetic only; the server never sees it.
 */

import * as THREE from "three";
import { RAGDOLL_PARTS } from "../../physics/physics-world.js";
import { RIG_PARTS } from "../../physics/ragdoll-rig.js";

const CORPSE_COLOUR = 0x6b5a48;

export class CorpseProxy {
  readonly group = new THREE.Group();
  private readonly parts: THREE.Mesh[] = [];
  private readonly geometries: THREE.BoxGeometry[] = [];
  private readonly material = new THREE.MeshStandardMaterial({ color: CORPSE_COLOUR, roughness: 0.9 });
  /** Set once the corpse has expired and its drawing is gone. */
  spent = false;

  constructor(readonly key: number) {
    for (let i = 0; i < RAGDOLL_PARTS; i++) {
      const [hx, hy, hz] = RIG_PARTS[i]!.halfExtents;
      const geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.material);
      this.parts.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Place each part from `pose` (7 floats per part: centre xyz, then quaternion xyzw). */
  place(pose: Float32Array): void {
    for (let i = 0; i < this.parts.length; i++) {
      const o = i * 7;
      const m = this.parts[i]!;
      m.position.set(pose[o]!, pose[o + 1]!, pose[o + 2]!);
      m.quaternion.set(pose[o + 3]!, pose[o + 4]!, pose[o + 5]!, pose[o + 6]!);
    }
  }

  /** The corpse is gone: stop drawing it. Idempotent. */
  retire(): void {
    if (this.spent) return;
    this.spent = true;
    this.dispose();
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
  }
}
