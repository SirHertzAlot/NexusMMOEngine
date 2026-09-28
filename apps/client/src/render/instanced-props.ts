/**
 * InstancedProps — static placeholder props (scatter: trees, rocks, …)
 * drawn as one InstancedMesh per shape instead of one mesh per entity.
 *
 * A streamed world carries well over a thousand static props around the
 * player; as separate meshes each is its own draw call with its own
 * material, which alone can hold a browser to single-digit fps. Batched,
 * every box is one draw call and every sphere another.
 *
 * Only props that never move and have no art-pack model come here (see
 * WorldView): a unit shape per batch, each instance's matrix scaled to
 * its BodyConfig and Transform, its colour the entity's placeholder
 * colour. Removal moves the last instance into the freed slot, so a
 * batch stays dense; batches double when full.
 */

import * as THREE from "three";
import { ShapeKind } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { BodyConfigRow, TransformRow } from "@mmo-engine/protocol";

/** Smallest dimension drawn (a zero-size body still shows). */
const MIN_SIZE = 0.05;
const INITIAL_CAPACITY = 256;
/** Hover tint: mixed into a prop's colour while the pointer is on it. */
const HOVER = new THREE.Color(0xffee88);
const HOVER_MIX = 0.55;

interface Batch {
  shapeKind: number;
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Instance index -> wire id. */
  owners: bigint[];
}

interface Slot {
  batch: Batch;
  index: number;
  transform: TransformRow;
  body: BodyConfigRow;
  color: THREE.Color;
}

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();

/** A prop's matrix: its Transform, scaled to its body's size on a unit shape. */
export function propMatrix(t: TransformRow, body: BodyConfigRow, out = new THREE.Matrix4()): THREE.Matrix4 {
  const sphere = body.shapeKind === ShapeKind.Sphere;
  const r = Math.max(body.radius, MIN_SIZE);
  tmpScale.set(
    t.sx * (sphere ? r : Math.max(body.halfX * 2, MIN_SIZE)),
    t.sy * (sphere ? r : Math.max(body.halfY * 2, MIN_SIZE)),
    t.sz * (sphere ? r : Math.max(body.halfZ * 2, MIN_SIZE)),
  );
  return out.compose(tmpPos.set(t.px, t.py, t.pz), tmpQuat.set(t.qx, t.qy, t.qz, t.qw), tmpScale);
}

export class InstancedProps {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly batches = new Map<number, Batch>();
  private readonly slots = new Map<bigint, Slot>();
  private hovered: bigint | null = null;

  constructor() {
    this.group.name = "props";
  }

  /** Props on screen. */
  get count(): number {
    return this.slots.size;
  }

  /** Draw calls the props take (one per shape in use). */
  get drawCalls(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.mesh.count > 0) n++;
    return n;
  }

  has(wireId: bigint): boolean {
    return this.slots.has(wireId);
  }

  wireIds(): IterableIterator<bigint> {
    return this.slots.keys();
  }

  /** Add a prop (or refresh it if already here). */
  add(wireId: bigint, transform: TransformRow, body: BodyConfigRow, color: THREE.Color): void {
    const existing = this.slots.get(wireId);
    if (existing && existing.body.shapeKind === body.shapeKind) {
      this.update(wireId, transform, body);
      return;
    }
    if (existing) this.remove(wireId);
    const batch = this.batchFor(body.shapeKind);
    if (batch.mesh.count === batch.capacity) this.grow(batch);
    const index = batch.mesh.count++;
    batch.owners[index] = wireId;
    const slot: Slot = { batch, index, transform, body, color: color.clone() };
    this.slots.set(wireId, slot);
    this.writeMatrix(slot);
    this.writeColor(slot);
  }

  /** Follow a prop's Transform/BodyConfig rows (cheap when unchanged: rows are replaced, not mutated). */
  update(wireId: bigint, transform: TransformRow, body: BodyConfigRow): void {
    const slot = this.slots.get(wireId);
    if (!slot) return;
    if (body.shapeKind !== slot.body.shapeKind) {
      this.add(wireId, transform, body, slot.color);
      return;
    }
    if (slot.transform === transform && slot.body === body) return;
    slot.transform = transform;
    slot.body = body;
    this.writeMatrix(slot);
  }

  remove(wireId: bigint): void {
    const slot = this.slots.get(wireId);
    if (!slot) return;
    this.slots.delete(wireId);
    if (this.hovered === wireId) this.hovered = null;
    const { batch, index } = slot;
    const last = --batch.mesh.count;
    if (index !== last) {
      // Move the last instance into the hole.
      const moved = this.slots.get(batch.owners[last])!;
      moved.index = index;
      batch.owners[index] = batch.owners[last];
      this.writeMatrix(moved);
      this.writeColor(moved);
    }
    batch.owners.length = last;
    this.touch(batch);
  }

  /** Tint the prop under the pointer (null: none). */
  setHovered(wireId: bigint | null): void {
    if (wireId === this.hovered) return;
    const before = this.hovered !== null ? this.slots.get(this.hovered) : undefined;
    this.hovered = wireId !== null && this.slots.has(wireId) ? wireId : null;
    if (before) this.writeColor(before);
    const now = this.hovered !== null ? this.slots.get(this.hovered) : undefined;
    if (now) this.writeColor(now);
  }

  /** The prop a ray hits first, with its distance, or null. */
  pick(raycaster: THREE.Raycaster): { wireId: bigint; distance: number } | null {
    const meshes = [...this.batches.values()].filter((b) => b.mesh.count > 0).map((b) => b.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const batch = [...this.batches.values()].find((b) => b.mesh === hit.object);
    const wireId = batch?.owners[hit.instanceId];
    return wireId === undefined ? null : { wireId, distance: hit.distance };
  }

  setWireframe(on: boolean): void {
    this.material.wireframe = on;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    this.batches.clear();
    this.slots.clear();
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
    this.material.dispose();
  }

  // ------------------------------------------------------------ internals

  private batchFor(shapeKind: number): Batch {
    let batch = this.batches.get(shapeKind);
    if (!batch) {
      batch = { shapeKind, mesh: this.makeMesh(shapeKind, INITIAL_CAPACITY), capacity: INITIAL_CAPACITY, owners: [] };
      this.batches.set(shapeKind, batch);
      this.group.add(batch.mesh);
    }
    return batch;
  }

  private makeMesh(shapeKind: number, capacity: number): THREE.InstancedMesh {
    let geometry = this.geometries.get(shapeKind);
    if (!geometry) {
      geometry = shapeKind === ShapeKind.Sphere ? new THREE.SphereGeometry(1, 16, 12) : new THREE.BoxGeometry(1, 1, 1);
      this.geometries.set(shapeKind, geometry);
    }
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Props surround the player: one bounding sphere over all of them
    // would never be off screen, so skip the per-frame test.
    mesh.frustumCulled = false;
    mesh.name = shapeKind === ShapeKind.Sphere ? "props-spheres" : "props-boxes";
    return mesh;
  }

  /** Double a full batch: a bigger mesh with the same instances. */
  private grow(batch: Batch): void {
    const old = batch.mesh;
    const mesh = this.makeMesh(batch.shapeKind, batch.capacity * 2);
    mesh.instanceMatrix.array.set(old.instanceMatrix.array);
    mesh.instanceColor!.array.set(old.instanceColor!.array);
    mesh.instanceColor!.needsUpdate = true;
    mesh.count = old.count;
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    batch.mesh = mesh;
    batch.capacity *= 2;
    this.touch(batch);
  }

  private writeMatrix(slot: Slot): void {
    slot.batch.mesh.setMatrixAt(slot.index, propMatrix(slot.transform, slot.body, tmpMatrix));
    this.touch(slot.batch);
  }

  private writeColor(slot: Slot): void {
    const owner = slot.batch.owners[slot.index];
    const c = owner === this.hovered ? tmpColor.copy(slot.color).lerp(HOVER, HOVER_MIX) : slot.color;
    slot.batch.mesh.setColorAt(slot.index, c);
    slot.batch.mesh.instanceColor!.needsUpdate = true;
  }

  private touch(batch: Batch): void {
    batch.mesh.instanceMatrix.needsUpdate = true;
    // Raycasts recompute the bounds lazily from the current instances.
    batch.mesh.boundingSphere = null;
    batch.mesh.boundingBox = null;
  }
}
