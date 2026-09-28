/**
 * PropRenderer — streamed scenery (scatter: trees, rocks, …) drawn as
 * instanced meshes, one draw call per placeholder shape instead of one
 * mesh (geometry + material) per prop. With chunk streaming a player has
 * a few thousand props around them; a mesh each is what a laptop GPU
 * chokes on.
 *
 * Placeholder visuals, matching the old per-entity ones: a prop with a
 * BodyConfig draws as its collision shape (box or sphere) centred on its
 * position; one without draws as a cone standing on the ground (a tree
 * stand-in). Colour per asset kind. Real art (an AssetProvider with
 * assetMesh) doesn't come through here.
 *
 * Instances pack densely: removing a prop moves the last instance into
 * its slot. Capacity grows by doubling (the old mesh is disposed).
 */

import * as THREE from "three";
import type { EntityMirror } from "@mmo-engine/mirror";
import type { TransformRow } from "@mmo-engine/protocol";
import { placeholderColor } from "./assets.js";

type Kind = "box" | "sphere" | "cone";

interface Batch {
  mesh: THREE.InstancedMesh;
  /** Slot -> wire id. */
  slots: bigint[];
}

interface Entry {
  kind: Kind;
  slot: number;
  transform: TransformRow;
  color: THREE.Color;
}

const INITIAL_CAPACITY = 256;
const HOVER = new THREE.Color(0xffffaa);
const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpDims = new THREE.Vector3();

function geometryFor(kind: Kind): THREE.BufferGeometry {
  switch (kind) {
    case "box":
      return new THREE.BoxGeometry(1, 1, 1);
    case "sphere":
      return new THREE.SphereGeometry(1, 16, 12);
    case "cone":
      return new THREE.ConeGeometry(0.35, 1.2, 7).translate(0, 0.6, 0);
  }
}

/** True for entities this renderer draws: scatter (AssetRef) that isn't a player. */
export function isProp(e: EntityMirror): boolean {
  return e.asset !== undefined && e.intent === undefined && e.transform !== undefined;
}

export class PropRenderer {
  readonly group = new THREE.Group();
  private readonly batches = new Map<Kind, Batch>();
  private readonly entries = new Map<bigint, Entry>();
  private hovered: bigint | null = null;

  constructor() {
    this.group.name = "props";
  }

  get count(): number {
    return this.entries.size;
  }

  /** Draw calls in use (tests, HUD). */
  get batchCount(): number {
    return this.batches.size;
  }

  /** Add a prop, or move it if its transform row changed. */
  sync(wireId: bigint, e: EntityMirror): void {
    const t = e.transform!;
    const existing = this.entries.get(wireId);
    const kind: Kind = e.body ? (e.body.shapeKind === 1 ? "sphere" : "box") : "cone";
    if (existing && existing.kind === kind) {
      if (existing.transform !== t) {
        existing.transform = t;
        this.writeMatrix(this.batches.get(kind)!, existing.slot, t, e);
      }
      return;
    }
    if (existing) this.remove(wireId); // shape changed (BodyConfig arrived late)
    const batch = this.batchFor(kind, 1);
    const slot = batch.mesh.count;
    batch.mesh.count = slot + 1;
    batch.slots[slot] = wireId;
    const color = placeholderColor(BigInt(e.asset!.assetHash)).multiplyScalar(0.85 + 0.3 * jitter(wireId));
    this.entries.set(wireId, { kind, slot, transform: t, color });
    this.writeMatrix(batch, slot, t, e);
    batch.mesh.setColorAt(slot, wireId === this.hovered ? HOVER : color);
    batch.mesh.instanceColor!.needsUpdate = true;
  }

  remove(wireId: bigint): void {
    const entry = this.entries.get(wireId);
    if (!entry) return;
    this.entries.delete(wireId);
    if (this.hovered === wireId) this.hovered = null;
    const batch = this.batches.get(entry.kind)!;
    const last = batch.mesh.count - 1;
    if (entry.slot !== last) {
      // Move the last instance into the freed slot.
      const moved = batch.slots[last];
      batch.mesh.getMatrixAt(last, tmpMatrix);
      batch.mesh.setMatrixAt(entry.slot, tmpMatrix);
      const movedEntry = this.entries.get(moved)!;
      batch.mesh.setColorAt(entry.slot, moved === this.hovered ? HOVER : movedEntry.color);
      batch.slots[entry.slot] = moved;
      movedEntry.slot = entry.slot;
    }
    batch.slots.length = last;
    batch.mesh.count = last;
    batch.mesh.instanceMatrix.needsUpdate = true;
    batch.mesh.instanceColor!.needsUpdate = true;
  }

  wireIds(): IterableIterator<bigint> {
    return this.entries.keys();
  }

  /** Meshes to raycast for hover. */
  pickTargets(): THREE.Object3D[] {
    return [...this.batches.values()].map((b) => b.mesh);
  }

  /** The prop a raycast hit, or null. */
  wireIdOf(hit: THREE.Intersection): bigint | null {
    if (hit.instanceId === undefined) return null;
    for (const b of this.batches.values()) {
      if (b.mesh === hit.object) return b.slots[hit.instanceId] ?? null;
    }
    return null;
  }

  /** Highlight one prop (or none). */
  setHover(wireId: bigint | null): void {
    if (wireId === this.hovered) return;
    const paint = (id: bigint | null, hover: boolean): void => {
      const entry = id === null ? undefined : this.entries.get(id);
      if (!entry) return;
      const batch = this.batches.get(entry.kind)!;
      batch.mesh.setColorAt(entry.slot, hover ? HOVER : entry.color);
      batch.mesh.instanceColor!.needsUpdate = true;
    };
    paint(this.hovered, false);
    this.hovered = wireId !== null && this.entries.has(wireId) ? wireId : null;
    paint(this.hovered, true);
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.mesh);
      b.mesh.geometry.dispose();
      (b.mesh.material as THREE.Material).dispose();
      b.mesh.dispose();
    }
    this.batches.clear();
    this.entries.clear();
  }

  // ------------------------------------------------------------ internals

  /** The batch for `kind`, with room for `extra` more instances. */
  private batchFor(kind: Kind, extra: number): Batch {
    let batch = this.batches.get(kind);
    const needed = (batch?.mesh.count ?? 0) + extra;
    if (batch && needed <= batch.mesh.instanceMatrix.count) return batch;
    let capacity = batch ? batch.mesh.instanceMatrix.count : INITIAL_CAPACITY;
    while (capacity < needed) capacity *= 2;
    const mesh = new THREE.InstancedMesh(
      batch?.mesh.geometry ?? geometryFor(kind),
      batch ? (batch.mesh.material as THREE.Material) : new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }),
      capacity,
    );
    mesh.name = `props:${kind}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, HOVER); // allocate instanceColor
    mesh.count = 0;
    // Instances span the loaded area: per-mesh culling would cull on a stale sphere.
    mesh.frustumCulled = false;
    if (batch) {
      // Copy live instances into the bigger mesh, then drop the old one.
      mesh.count = batch.mesh.count;
      (mesh.instanceMatrix.array as Float32Array).set(batch.mesh.instanceMatrix.array as Float32Array);
      (mesh.instanceColor!.array as Float32Array).set(batch.mesh.instanceColor!.array as Float32Array);
      this.group.remove(batch.mesh);
      batch.mesh.dispose();
      batch.mesh = mesh;
    } else {
      batch = { mesh, slots: [] };
      this.batches.set(kind, batch);
    }
    this.group.add(mesh);
    return batch;
  }

  private writeMatrix(batch: Batch, slot: number, t: TransformRow, e: EntityMirror): void {
    tmpPos.set(t.px, t.py, t.pz);
    tmpQuat.set(t.qx, t.qy, t.qz, t.qw);
    tmpScale.set(t.sx, t.sy, t.sz);
    const b = e.body;
    if (b && b.shapeKind === 1) tmpScale.multiplyScalar(Math.max(b.radius, 0.05));
    else if (b) tmpScale.multiply(tmpDims.set(Math.max(b.halfX * 2, 0.05), Math.max(b.halfY * 2, 0.05), Math.max(b.halfZ * 2, 0.05)));
    batch.mesh.setMatrixAt(slot, tmpMatrix.compose(tmpPos, tmpQuat, tmpScale));
    batch.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** 0..1, stable per wire id: a little brightness variety between props of one kind. */
function jitter(wireId: bigint): number {
  const x = Number(wireId & 0xffffn);
  return ((x * 2654435761) >>> 0) / 0xffffffff;
}
