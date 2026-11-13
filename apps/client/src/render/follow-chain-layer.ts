/**
 * Draws follow-chains (roadmap CF4, sim in follow-chain.ts): bind a recipe to
 * any Object3D (a character's bone, a banner pole) and the layer simulates
 * and draws a tapering ribbon behind it. Each frame the chains within
 * reach offer their distance, the budget admits the nearest, and the rest
 * are hidden; a chain that was hidden restarts at rest when it comes back.
 * Presentation only: never networked.
 */

import * as THREE from "three";
import { CHAIN_RECIPES, Chain, ChainBudget, buildRibbon, lodPoints, ribbonIndices, stepChain, type ChainRecipe } from "./follow-chain.js";

export interface BindOptions {
  /** Direction the chain hangs or trails along at rest; default world down. */
  rest?: THREE.Vector3;
  /** "world" (default) or "anchor": the rest direction is in the anchor's local space (a tail trails behind). */
  restSpace?: "world" | "anchor";
}

interface Slot {
  anchor: THREE.Object3D;
  recipe: ChainRecipe;
  chain: Chain;
  mesh: THREE.Mesh;
  positions: THREE.BufferAttribute;
  rest: THREE.Vector3;
  space: "world" | "anchor";
  /** Points this frame (0: hidden), and whether the chain has been laid out since it last came back. */
  n: number;
  seeded: boolean;
  admitted: boolean;
}

const tmpA = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpR = new THREE.Vector3();
const cam = new THREE.Vector3();
// Scratch arrays for the sim (no allocation per frame).
const aBuf = new Float64Array(3);
const rBuf = new Float64Array(3);
const cBuf = new Float64Array(3);

export class FollowChainLayer {
  readonly group = new THREE.Group();
  private readonly slots = new Map<number, Slot>();
  private readonly budget = new ChainBudget();
  private readonly materials = new Map<string, THREE.MeshBasicMaterial>();
  private next = 1;
  /** Chains drawn this frame, and offers the budget refused. */
  active = 0;
  get shed(): number {
    return this.budget.shed;
  }

  constructor(readonly maxActive = 64) {
    this.group.name = "follow-chains";
  }

  /** Start a chain on `anchor`; returns a handle for unbind(). */
  bind(anchor: THREE.Object3D, recipe: ChainRecipe | string, o: BindOptions = {}): number {
    const r = typeof recipe === "string" ? CHAIN_RECIPES[recipe] : recipe;
    if (!r) throw new Error(`follow-chain: unknown recipe "${String(recipe)}"`);
    const geo = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(r.points * 6), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", positions);
    geo.setIndex(new THREE.BufferAttribute(ribbonIndices(r.points), 1));
    let mat = this.materials.get(r.color);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color: r.color, side: THREE.DoubleSide });
      this.materials.set(r.color, mat);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // positions are world-space and move every frame
    mesh.visible = false;
    this.group.add(mesh);
    const id = this.next++;
    this.slots.set(id, {
      anchor, recipe: r, chain: new Chain(r.points), mesh, positions,
      rest: (o.rest ?? new THREE.Vector3(0, -1, 0)).clone().normalize(),
      space: o.restSpace ?? "world", n: 0, seeded: false, admitted: false,
    });
    return id;
  }

  unbind(id: number): void {
    const s = this.slots.get(id);
    if (!s) return;
    this.group.remove(s.mesh);
    s.mesh.geometry.dispose();
    this.slots.delete(id);
  }

  update(camera: THREE.Camera, dt: number): void {
    camera.getWorldPosition(cam);
    cBuf[0] = cam.x; cBuf[1] = cam.y; cBuf[2] = cam.z;
    this.budget.begin();
    for (const [id, s] of this.slots) {
      s.admitted = false;
      s.anchor.getWorldPosition(tmpA);
      const d = tmpA.distanceTo(cam);
      s.n = lodPoints(s.recipe, d);
      if (s.n > 0) this.budget.offer(id, d);
    }
    this.budget.admit(this.maxActive, (id) => {
      this.slots.get(id)!.admitted = true;
    });
    let active = 0;
    for (const s of this.slots.values()) {
      if (!s.admitted) {
        s.mesh.visible = false;
        s.seeded = false;
        continue;
      }
      s.anchor.getWorldPosition(tmpA);
      if (s.space === "anchor") {
        s.anchor.getWorldQuaternion(tmpQ);
        tmpR.copy(s.rest).applyQuaternion(tmpQ);
      } else tmpR.copy(s.rest);
      aBuf[0] = tmpA.x; aBuf[1] = tmpA.y; aBuf[2] = tmpA.z;
      rBuf[0] = tmpR.x; rBuf[1] = tmpR.y; rBuf[2] = tmpR.z;
      if (!s.seeded) {
        s.chain.reset(s.recipe, aBuf, rBuf);
        s.seeded = true;
      }
      stepChain(s.chain, s.recipe, s.n, aBuf, rBuf, dt);
      const verts = buildRibbon(s.positions.array as Float32Array, s.chain, s.n, s.recipe.width, cBuf);
      s.positions.needsUpdate = true;
      s.mesh.geometry.setDrawRange(0, (s.n - 1) * 6);
      s.mesh.visible = verts > 0;
      active++;
    }
    this.active = active;
  }

  dispose(): void {
    for (const id of [...this.slots.keys()]) this.unbind(id);
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }
}
