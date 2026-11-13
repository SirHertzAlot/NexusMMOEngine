/**
 * Break pieces (DE2), drawn: one InstancedMesh of cubes over the DebrisSim pool, so any number of broken
 * props is one draw call and a fixed buffer. Hidden while no piece is alive.
 */

import * as THREE from "three";
import { DEBRIS_CAPACITY, DebrisSim, type GroundAt } from "./debris-sim.js";

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();

export class DebrisPieces {
  readonly sim = new DebrisSim(DEBRIS_CAPACITY, 0x85ebca6b);
  readonly mesh: THREE.InstancedMesh;
  private active = 0;

  constructor(parent: THREE.Object3D) {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, DEBRIS_CAPACITY);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_CAPACITY * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  burst(x: number, y: number, z: number, hx: number, hy: number, hz: number, count: number, color: number): void {
    this.sim.burst(x, y, z, hx, hy, hz, count, color);
    this.active = this.sim.alive();
    this.mesh.visible = true;
  }

  update(dt: number, groundAt: GroundAt): void {
    if (this.active === 0) return;
    const s = this.sim;
    s.step(dt, groundAt);
    for (let k = 0; k < DEBRIS_CAPACITY; k++) {
      const size = s.half[k]! * 2 * s.scaleOf(k);
      tmpEuler.set(s.rx[k]!, s.ry[k]!, s.rz[k]!);
      tmpQuat.setFromEuler(tmpEuler);
      tmpMatrix.compose(tmpPos.set(s.px[k]!, s.py[k]!, s.pz[k]!), tmpQuat, tmpScale.set(size, size, size));
      this.mesh.setMatrixAt(k, tmpMatrix);
      this.mesh.setColorAt(k, tmpColor.setHex(s.color[k]!));
    }
    this.mesh.count = DEBRIS_CAPACITY;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.active = s.alive();
    if (this.active === 0) {
      this.mesh.visible = false;
      this.mesh.count = 0;
    }
  }

  dispose(parent: THREE.Object3D): void {
    parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
