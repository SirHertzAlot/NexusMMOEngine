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
 * sphere sized to its BodyConfig, in the entity's placeholder colour.
 * When a cooked mesh arrives, `modelsChanged()` moves its props over.
 *
 * Removal moves the last instance into the freed slot, so a batch stays
 * dense; batches double when full. Model geometries get a BVH (bvh.ts),
 * so hover picking walks a tree instead of every triangle.
 *
 * Levels of detail (lod.ts): a model with a LOD chain is one InstancedMesh
 * per level, and `updateLod(eye)` moves each instance to the level its
 * distance from the camera calls for (a little hysteresis, so props on a
 * boundary don't flicker). One draw call per level in use.
 */

import * as THREE from "three";
import { ShapeKind } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { BodyConfigRow, TransformRow } from "@mmo-engine/protocol";
import { ensureBoundsTree } from "./bvh.js";
import type { LodLevel } from "./lod.js";
import { applyShadingToMaterial } from "./shading/shading.js";

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
  ): { key: string; geometry: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[]; lods?: LodLevel[] } | null;
}

export interface PropAsset {
  assetHash: number;
  variant: number;
}

/** One level of a batch: its geometry, the distance it starts at, and its instances. */
interface Level {
  geometry: THREE.BufferGeometry;
  distance: number;
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Instance index -> wire id. */
  owners: bigint[];
}

interface Batch {
  key: string;
  /** Its meshes' name: the model's key (levels add " lod<n>"). */
  name: string;
  material: THREE.Material | THREE.Material[];
  /** Cooked models are drawn at the Transform; placeholders are scaled to the body. */
  cooked: boolean;
  /** Full detail first, then the LOD chain. */
  levels: Level[];
}

interface Slot {
  batch: Batch;
  level: number;
  index: number;
  transform: TransformRow;
  body: BodyConfigRow | null;
  asset: PropAsset | null;
  color: THREE.Color;
}

/** Stats for the HUD: what the props cost. */
export interface PropStats {
  props: number;
  drawCalls: number;
  /** Triangles drawn by the props this frame. */
  triangles: number;
  /** What they'd take at full detail. */
  fullTriangles: number;
  /** Instances per level (0: full detail). */
  perLevel: number[];
}

/** Hysteresis: a prop moves to a lighter level only this far past its boundary, and back only this far inside it. */
const LOD_SLACK = 0.1;

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();

/**
 * A stand-in's matrix. One convention with the server (global scale): a
 * BodyConfig is world-final (the scale is already in it), so a stand-in is
 * drawn at the body's size and the Transform scale is NOT applied again; a
 * model is drawn at the Transform scale (its mesh has its own size), so the
 * two are the same size. Without a body: a 1 m unit shape at the Transform scale.
 */
export function propMatrix(t: TransformRow, body: BodyConfigRow | null, out = new THREE.Matrix4()): THREE.Matrix4 {
  if (!body) tmpScale.set(t.sx, t.sy, t.sz);
  else if (body.shapeKind === ShapeKind.Sphere) {
    const r = Math.max(body.radius, MIN_SIZE);
    tmpScale.set(r, r, r);
  } else tmpScale.set(Math.max(body.halfX * 2, MIN_SIZE), Math.max(body.halfY * 2, MIN_SIZE), Math.max(body.halfZ * 2, MIN_SIZE));
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
  private readonly lastEye = new THREE.Vector3(Infinity, 0, 0);

  constructor(private readonly models: PropModels | null = null) {
    this.group.name = "props";
    // Shaded as content says (materials.json -> shading): a stand-in shape
    // and a cooked model are different kinds of thing.
    applyShadingToMaterial(this.placeholderMaterial, "placeholder");
    applyShadingToMaterial(this.modelMaterial, "model");
  }

  /** Props on screen. */
  get count(): number {
    return this.slots.size;
  }

  /** Draw calls the props take (one per model and level in use). */
  get drawCalls(): number {
    let n = 0;
    for (const b of this.batches.values()) for (const l of b.levels) if (l.mesh.count > 0) n++;
    return n;
  }

  /** Props drawn with a cooked model (the rest are placeholders). */
  get cookedCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.batch.cooked) n++;
    return n;
  }

  /** What the props cost now: draw calls, triangles, and how many are at each level. */
  stats(): PropStats {
    const perLevel: number[] = [];
    let triangles = 0;
    let fullTriangles = 0;
    let drawCalls = 0;
    for (const b of this.batches.values()) {
      const full = triangleCount(b.levels[0].geometry);
      b.levels.forEach((l, i) => {
        if (l.mesh.count === 0) return;
        drawCalls++;
        perLevel[i] = (perLevel[i] ?? 0) + l.mesh.count;
        triangles += triangleCount(l.geometry) * l.mesh.count;
        fullTriangles += full * l.mesh.count;
      });
    }
    for (let i = 0; i < perLevel.length; i++) perLevel[i] ??= 0;
    return { props: this.slots.size, drawCalls, triangles, fullTriangles, perLevel };
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
    const slot: Slot = { batch, level: 0, index: 0, transform, body, asset, color: color.clone() };
    slot.level = this.levelAt(batch, transform, 0);
    this.place(wireId, slot);
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

  /**
   * Move props to the level their distance from `eye` calls for. Cheap to
   * call every frame: it only walks the props when the camera has moved a
   * metre or more since the last walk.
   */
  updateLod(eye: THREE.Vector3): void {
    if (eye.distanceToSquared(this.lastEye) < 1) return;
    this.lastEye.copy(eye);
    for (const [wid, slot] of this.slots) {
      if (slot.batch.levels.length < 2) continue;
      const level = this.levelAt(slot.batch, slot.transform, slot.level);
      if (level === slot.level) continue;
      this.unplace(slot);
      slot.level = level;
      this.place(wid, slot);
      this.writeMatrix(slot);
      this.writeColor(slot);
    }
  }

  remove(wireId: bigint): void {
    const slot = this.slots.get(wireId);
    if (!slot) return;
    this.slots.delete(wireId);
    if (this.hovered === wireId) this.hovered = null;
    this.unplace(slot);
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
    const levels = [...this.batches.values()].flatMap((b) => b.levels).filter((l) => l.mesh.count > 0);
    const hit = raycaster.intersectObjects(levels.map((l) => l.mesh), false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const wireId = levels.find((l) => l.mesh === hit.object)?.owners[hit.instanceId];
    return wireId === undefined ? null : { wireId, distance: hit.distance };
  }

  setWireframe(on: boolean): void {
    this.placeholderMaterial.wireframe = on;
    this.modelMaterial.wireframe = on;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      for (const l of b.levels) {
        this.group.remove(l.mesh);
        l.mesh.dispose();
      }
    }
    this.batches.clear();
    this.slots.clear();
    for (const g of this.shapes.values()) g.dispose();
    this.shapes.clear();
    this.placeholderMaterial.dispose();
    this.modelMaterial.dispose();
  }

  // ------------------------------------------------------------ internals

  /** The level a prop at `t` should be at, with hysteresis around the level it's at now. */
  private levelAt(batch: Batch, t: TransformRow, current: number): number {
    const levels = batch.levels;
    if (levels.length < 2 || !Number.isFinite(this.lastEye.x)) return 0;
    const d = Math.hypot(t.px - this.lastEye.x, t.py - this.lastEye.y, t.pz - this.lastEye.z);
    let level = 0;
    for (let i = 1; i < levels.length; i++) {
      // Leaving a level takes going LOD_SLACK past its boundary; coming back, LOD_SLACK inside it.
      const edge = levels[i].distance * (i <= current ? 1 - LOD_SLACK : 1 + LOD_SLACK);
      if (d >= edge) level = i;
    }
    return level;
  }

  /** Put a slot's instance at the end of its level. */
  private place(wireId: bigint, slot: Slot): void {
    const level = slot.batch.levels[slot.level];
    if (level.mesh.count === level.capacity) this.grow(slot.batch, level);
    slot.index = level.mesh.count++;
    level.owners[slot.index] = wireId;
  }

  /** Take a slot's instance out of its level (the last one moves into the hole). */
  private unplace(slot: Slot): void {
    const level = slot.batch.levels[slot.level];
    const last = --level.mesh.count;
    if (slot.index !== last) {
      const moved = this.slots.get(level.owners[last])!;
      moved.index = slot.index;
      level.owners[slot.index] = level.owners[last];
      this.writeMatrix(moved);
      this.writeColor(moved);
    }
    level.owners.length = last;
    this.touch(level);
  }

  private batchFor(body: BodyConfigRow | null, asset: PropAsset | null): Batch {
    const model = asset && this.models ? this.models.model(asset.assetHash, asset.variant) : null;
    const shapeKind = body?.shapeKind === ShapeKind.Sphere ? ShapeKind.Sphere : ShapeKind.Box;
    const lods = model?.lods ?? [];
    const name = model ? `model:${model.key}` : `shape:${shapeKind}`;
    // A model's chain can arrive after the model: a new batch then, the props move over.
    const key = `${name}|${lods.length}`;
    let batch = this.batches.get(key);
    if (!batch) {
      const material = model ? (model.material ?? this.modelMaterial) : this.placeholderMaterial;
      const geometries: Array<{ geometry: THREE.BufferGeometry; distance: number }> = [
        { geometry: model ? model.geometry : this.shape(shapeKind), distance: 0 },
      ];
      // Levels further out than the one before them only.
      for (const l of lods) if (l.distance > geometries[geometries.length - 1].distance) geometries.push(l);
      const levels = geometries.map((g, i) => ({
        geometry: g.geometry,
        distance: g.distance,
        mesh: this.makeMesh(levelName(name, i), g.geometry, material, INITIAL_CAPACITY),
        capacity: INITIAL_CAPACITY,
        owners: [] as bigint[],
      }));
      batch = { key, name, material, cooked: model !== null, levels };
      this.batches.set(key, batch);
      for (const l of levels) this.group.add(l.mesh);
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
    // Picking tests each instance's triangles: a BVH makes that a tree walk.
    ensureBoundsTree(geometry);
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

  /** Double a full level: a bigger mesh with the same instances. */
  private grow(batch: Batch, level: Level): void {
    const old = level.mesh;
    const i = batch.levels.indexOf(level);
    const mesh = this.makeMesh(levelName(batch.name, i), level.geometry, batch.material, level.capacity * 2);
    mesh.instanceMatrix.array.set(old.instanceMatrix.array);
    mesh.instanceColor!.array.set(old.instanceColor!.array);
    mesh.instanceColor!.needsUpdate = true;
    mesh.count = old.count;
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    level.mesh = mesh;
    level.capacity *= 2;
    this.touch(level);
  }

  private writeMatrix(slot: Slot): void {
    const m = slot.batch.cooked ? modelMatrix(slot.transform, tmpMatrix) : propMatrix(slot.transform, slot.body, tmpMatrix);
    const level = slot.batch.levels[slot.level];
    level.mesh.setMatrixAt(slot.index, m);
    this.touch(level);
  }

  private writeColor(slot: Slot): void {
    const level = slot.batch.levels[slot.level];
    const owner = level.owners[slot.index];
    // Cooked models carry their own colours: the instance colour only tints.
    const base = slot.batch.cooked ? WHITE : slot.color;
    const c = owner === this.hovered ? tmpColor.copy(base).lerp(HOVER, HOVER_MIX) : base;
    level.mesh.setColorAt(slot.index, c);
    level.mesh.instanceColor!.needsUpdate = true;
  }

  private touch(level: Level): void {
    level.mesh.instanceMatrix.needsUpdate = true;
    // Raycasts recompute the bounds lazily from the current instances.
    level.mesh.boundingSphere = null;
    level.mesh.boundingBox = null;
  }
}

function levelName(name: string, level: number): string {
  return level === 0 ? name : `${name} lod${level}`;
}

function triangleCount(g: THREE.BufferGeometry): number {
  return Math.floor((g.index ? g.index.count : g.getAttribute("position").count) / 3);
}
