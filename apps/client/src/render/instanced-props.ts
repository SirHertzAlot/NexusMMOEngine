/**
 * InstancedProps — static props (scatter: trees, rocks, …) drawn as one
 * InstancedMesh per model instead of one mesh per entity.
 *
 * A streamed world carries well over a thousand static props around the
 * player; as separate meshes each is its own draw call with its own
 * material, which alone can hold a browser to single-digit fps. Batched,
 * every model is one draw call.
 *
 * A prop's model is whatever `models` has for its AssetRef — an art pack
 * model (synty-props.ts, with its own textured materials) or a PICG
 * asset's cooked mesh (pcg-meshes.ts, in its vertex colours): drawn at
 * the prop's Transform. Until then (or without one) it is a placeholder: a unit box or
 * sphere scaled to its BodyConfig, in the entity's placeholder colour.
 * When a cooked mesh arrives, `modelsChanged()` moves its props over.
 *
 * Removal moves the last instance into the freed slot, so a batch stays
 * dense; batches double when full.
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
const WHITE = new THREE.Color(1, 1, 1);

/** Where asset models come from (SyntyProps, PcgMeshes). */
export interface PropModels {
  /**
   * The model an AssetRef shows, once it is ready (null: not yet, or none).
   * Without a material it is drawn in its vertex colours.
   */
  model(
    assetHash: number,
    variant: number,
  ): { key: string; geometry: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] } | null;
}

export interface PropAsset {
  assetHash: number;
  variant: number;
}

interface Batch {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Cooked models are drawn at the Transform; placeholders are scaled to the body. */
  cooked: boolean;
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Instance index -> wire id. */
  owners: bigint[];
}

interface Slot {
  batch: Batch;
  index: number;
  transform: TransformRow;
  body: BodyConfigRow | null;
  asset: PropAsset | null;
  color: THREE.Color;
}

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();

/** A placeholder's matrix: its Transform, scaled to its body's size on a unit shape (1 m without a body). */
export function propMatrix(t: TransformRow, body: BodyConfigRow | null, out = new THREE.Matrix4()): THREE.Matrix4 {
  const sphere = body?.shapeKind === ShapeKind.Sphere;
  const r = body ? Math.max(body.radius, MIN_SIZE) : 0.5;
  tmpScale.set(
    t.sx * (!body ? 1 : sphere ? r : Math.max(body.halfX * 2, MIN_SIZE)),
    t.sy * (!body ? 1 : sphere ? r : Math.max(body.halfY * 2, MIN_SIZE)),
    t.sz * (!body ? 1 : sphere ? r : Math.max(body.halfZ * 2, MIN_SIZE)),
  );
  return out.compose(tmpPos.set(t.px, t.py, t.pz), tmpQuat.set(t.qx, t.qy, t.qz, t.qw), tmpScale);
}

/** A cooked model's matrix: the Transform as it is (the mesh has its own size). */
function modelMatrix(t: TransformRow, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(tmpPos.set(t.px, t.py, t.pz), tmpQuat.set(t.qx, t.qy, t.qz, t.qw), tmpScale.set(t.sx, t.sy, t.sz));
}

export class InstancedProps {
  readonly group = new THREE.Group();
  private readonly placeholderMaterial = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
  private readonly modelMaterial = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, vertexColors: true });
  private readonly shapes = new Map<number, THREE.BufferGeometry>();
  private readonly batches = new Map<string, Batch>();
  private readonly slots = new Map<bigint, Slot>();
  private hovered: bigint | null = null;

  constructor(private readonly models: PropModels | null = null) {
    this.group.name = "props";
  }

  /** Props on screen. */
  get count(): number {
    return this.slots.size;
  }

  /** Draw calls the props take (one per model in use). */
  get drawCalls(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.mesh.count > 0) n++;
    return n;
  }

  /** Props drawn with a cooked model (the rest are placeholders). */
  get cookedCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.batch.cooked) n++;
    return n;
  }

  has(wireId: bigint): boolean {
    return this.slots.has(wireId);
  }

  wireIds(): IterableIterator<bigint> {
    return this.slots.keys();
  }

  /** Add a prop (or refresh it if already here). */
  add(wireId: bigint, transform: TransformRow, body: BodyConfigRow | null, color: THREE.Color, asset: PropAsset | null = null): void {
    const existing = this.slots.get(wireId);
    const batch = this.batchFor(body, asset);
    if (existing && existing.batch === batch) {
      existing.asset = asset;
      this.update(wireId, transform, body);
      return;
    }
    if (existing) this.remove(wireId);
    if (batch.mesh.count === batch.capacity) this.grow(batch);
    const index = batch.mesh.count++;
    batch.owners[index] = wireId;
    const slot: Slot = { batch, index, transform, body, asset, color: color.clone() };
    this.slots.set(wireId, slot);
    this.writeMatrix(slot);
    this.writeColor(slot);
  }

  /** Follow a prop's Transform/BodyConfig rows (cheap when unchanged: rows are replaced, not mutated). */
  update(wireId: bigint, transform: TransformRow, body: BodyConfigRow | null): void {
    const slot = this.slots.get(wireId);
    if (!slot) return;
    if (this.batchFor(body, slot.asset) !== slot.batch) {
      this.add(wireId, transform, body, slot.color, slot.asset);
      return;
    }
    if (slot.transform === transform && slot.body === body) return;
    slot.transform = transform;
    slot.body = body;
    this.writeMatrix(slot);
  }

  /** Cooked models arrived (or changed): move the props that show them. */
  modelsChanged(): void {
    for (const [wid, slot] of [...this.slots]) {
      if (!slot.asset) continue;
      if (this.batchFor(slot.body, slot.asset) !== slot.batch) this.add(wid, slot.transform, slot.body, slot.color, slot.asset);
    }
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
    this.placeholderMaterial.wireframe = on;
    this.modelMaterial.wireframe = on;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    this.batches.clear();
    this.slots.clear();
    for (const g of this.shapes.values()) g.dispose();
    this.shapes.clear();
    this.placeholderMaterial.dispose();
    this.modelMaterial.dispose();
  }

  // ------------------------------------------------------------ internals

  private batchFor(body: BodyConfigRow | null, asset: PropAsset | null): Batch {
    const model = asset && this.models ? this.models.model(asset.assetHash, asset.variant) : null;
    const shapeKind = body?.shapeKind === ShapeKind.Sphere ? ShapeKind.Sphere : ShapeKind.Box;
    const key = model ? `model:${model.key}` : `shape:${shapeKind}`;
    let batch = this.batches.get(key);
    if (!batch) {
      const geometry = model ? model.geometry : this.shape(shapeKind);
      const material = model ? (model.material ?? this.modelMaterial) : this.placeholderMaterial;
      batch = { key, geometry, material, cooked: model !== null, mesh: this.makeMesh(key, geometry, material, INITIAL_CAPACITY), capacity: INITIAL_CAPACITY, owners: [] };
      this.batches.set(key, batch);
      this.group.add(batch.mesh);
    }
    return batch;
  }

  private shape(shapeKind: number): THREE.BufferGeometry {
    let geometry = this.shapes.get(shapeKind);
    if (!geometry) {
      geometry = shapeKind === ShapeKind.Sphere ? new THREE.SphereGeometry(1, 16, 12) : new THREE.BoxGeometry(1, 1, 1);
      this.shapes.set(shapeKind, geometry);
    }
    return geometry;
  }

  private makeMesh(key: string, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Props surround the player: one bounding sphere over all of them
    // would never be off screen, so skip the per-frame test.
    mesh.frustumCulled = false;
    mesh.name = `props ${key}`;
    return mesh;
  }

  /** Double a full batch: a bigger mesh with the same instances. */
  private grow(batch: Batch): void {
    const old = batch.mesh;
    const mesh = this.makeMesh(batch.key, batch.geometry, batch.material, batch.capacity * 2);
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
    const m = slot.batch.cooked ? modelMatrix(slot.transform, tmpMatrix) : propMatrix(slot.transform, slot.body, tmpMatrix);
    slot.batch.mesh.setMatrixAt(slot.index, m);
    this.touch(slot.batch);
  }

  private writeColor(slot: Slot): void {
    const owner = slot.batch.owners[slot.index];
    // Cooked models carry their own colours: the instance colour only tints.
    const base = slot.batch.cooked ? WHITE : slot.color;
    const c = owner === this.hovered ? tmpColor.copy(base).lerp(HOVER, HOVER_MIX) : base;
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
