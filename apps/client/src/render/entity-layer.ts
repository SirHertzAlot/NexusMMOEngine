/**
 * EntityLayer — the entities of the mirror world, reconciled from
 * authoritative ECS state every frame.
 *
 * `sync()` creates meshes lazily per wire id, moves them from
 * interpolated transforms, and removes them when their entity despawns.
 * Nothing here simulates — positions come from the server, full stop
 * (skill operating rule 1). Chunk entities hand their terrain to the
 * TerrainRenderer.
 *
 * Placeholder visuals (Joey's decision for Phase 3): boxes/spheres per
 * BodyConfig shape. The AssetProvider abstraction is the seam where real
 * art plugs in later. Static props without an art-pack model (the
 * scatter, well over a thousand around the player) are batched into
 * InstancedProps, one draw call per model; everything else that moves,
 * and every art-pack model, is its own mesh.
 *
 * Plain three.js, no React: WorldCanvas drives it from the render loop,
 * and tests can drive it headless.
 */

import * as THREE from "three";
import type { AssetRefRow, BodyConfigRow } from "@mmo-engine/protocol";
import { MotionType } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { Interpolator, MirrorState } from "@mmo-engine/mirror";
import type { PcgRpcClient } from "@mmo-engine/picg";
import { placeholderColor, type AssetProvider } from "./assets.js";
import { EntityFxSystem } from "./entity-fx.js";
import { FxShowcase } from "./showcase.js";
import { InstancedProps, type PropAsset } from "./instanced-props.js";
import { PcgMeshes } from "./pcg-meshes.js";
import type { TerrainRenderer } from "./terrain/terrain-renderer.js";

export interface EntityLayerOptions {
  /** The region's Pcg service: props whose AssetRef is a PCG asset show its cooked mesh. */
  pcg?: PcgRpcClient;
}

interface TrackedMesh {
  object: THREE.Object3D;
  /** True once a BodyConfig row shaped this mesh (else unit-box stand-in). */
  shaped: boolean;
}

const tmpColor = new THREE.Color();
const tmpSpawn = new THREE.Vector3();

export class EntityLayer {
  /** Everything this layer draws that isn't FX: add it to the scene. */
  readonly group = new THREE.Group();
  /** The player's interpolated position this frame (null until it appears). */
  player: THREE.Vector3 | null = null;
  private readonly meshes = new Map<bigint, TrackedMesh>();
  private readonly props: InstancedProps;
  private readonly pcgMeshes: PcgMeshes | null;
  /** Root object -> wire id for hover raycasting (non-terrain only). */
  private readonly pickMap = new Map<THREE.Object3D, bigint>();
  private readonly fx: EntityFxSystem;
  private readonly showcase: FxShowcase;
  private readonly playerPos = new THREE.Vector3();
  private readonly lastPlayerPos = new THREE.Vector3(8, 2, 8);
  private hoveredWireId: bigint | null = null;
  private lastFrame = -1;
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    private readonly assets: AssetProvider,
    private readonly terrain: TerrainRenderer,
    opts: EntityLayerOptions = {},
  ) {
    this.pcgMeshes = opts.pcg ? new PcgMeshes(opts.pcg, () => this.props.modelsChanged()) : null;
    this.props = new InstancedProps(this.pcgMeshes);
    this.group.add(this.props.group);
    this.fx = new EntityFxSystem(scene, camera);
    this.showcase = new FxShowcase(scene, (pos, color) => this.fx.spawnBurst(pos, color));
  }

  /** Hover highlight: the nearest entity mesh or batched prop under the ray (terrain excluded). */
  hover(raycaster: THREE.Raycaster): void {
    const hit = raycaster.intersectObjects([...this.pickMap.keys()], false)[0];
    const prop = this.props.pick(raycaster);
    this.hoveredWireId =
      prop && (!hit || prop.distance < hit.distance) ? prop.wireId : hit ? this.pickMap.get(hit.object) ?? null : null;
  }

  /** Toggle the elemental-orb FX showcase (a ring placed ahead of the player, away from the camera). */
  setShowcaseVisible(v: boolean, cameraPos: THREE.Vector3): void {
    const forward = new THREE.Vector3().subVectors(this.lastPlayerPos, cameraPos);
    forward.y = 0;
    if (forward.lengthSq() > 1e-6) forward.normalize();
    const center = this.lastPlayerPos.clone().addScaledVector(forward, 7);
    this.showcase.setVisible(v, center);
  }

  /** Reconcile the layer with mirror state and advance the FX. */
  sync(state: MirrorState, interpolator: Interpolator, alpha: number, playerWireId: bigint | null): void {
    // Remove meshes and terrain for despawned entities.
    for (const [key, t] of this.meshes) {
      if (!state.entities.has(key)) {
        this.group.remove(t.object);
        this.pickMap.delete(t.object);
        disposeObject(t.object);
        this.meshes.delete(key);
      }
    }
    const gone: bigint[] = [];
    for (const wid of this.terrain.chunkWireIds()) if (!state.entities.has(wid)) gone.push(wid);
    for (const wid of gone) this.terrain.removeChunk(wid);
    gone.length = 0;
    for (const wid of this.props.wireIds()) if (!state.entities.has(wid)) gone.push(wid);
    for (const wid of gone) this.props.remove(wid);

    this.player = null;

    for (const [wid, e] of state.entities) {
      // Terrain chunks: TerrainRenderer (idempotent; rebuilds a flat
      // stand-in once, when the chunk's heights arrive).
      if (e.chunk) {
        this.terrain.ensureChunk(wid, e.chunk);
        continue;
      }
      // Batched static props: follow their rows (unchanged rows cost nothing).
      if (this.props.has(wid)) {
        if (e.transform) this.props.update(wid, e.transform, e.body ?? null);
        continue;
      }
      let tracked = this.meshes.get(wid);

      if (!tracked) {
        if (!e.transform) continue;
        const model = this.modelFor(e.asset);
        if (!model && isStaticProp(e.body, e.asset)) {
          // Scenery: no spawn portal (a streamed ring brings hundreds at once).
          this.props.add(wid, e.transform, e.body ?? null, placeholderColor(wid), propAsset(e.asset));
          continue;
        }
        const obj = this.makeBodyMesh(wid, e.body, model);
        this.group.add(obj);
        tracked = { object: obj, shaped: e.body !== undefined };
        this.meshes.set(wid, tracked);
        this.pickMap.set(obj, wid);
        // Spawn portal for newly-appearing entities.
        this.fx.spawnBurst(tmpSpawn.set(e.transform.px, 0, e.transform.pz));
      } else if (!tracked.shaped && e.body) {
        // BodyConfig arrived after the stand-in: reshape (or batch).
        this.group.remove(tracked.object);
        this.pickMap.delete(tracked.object);
        disposeObject(tracked.object);
        const model = this.modelFor(e.asset);
        if (!model && isStaticProp(e.body, e.asset) && e.transform) {
          this.meshes.delete(wid);
          this.props.add(wid, e.transform, e.body ?? null, placeholderColor(wid), propAsset(e.asset));
          continue;
        }
        const obj = this.makeBodyMesh(wid, e.body, model);
        this.group.add(obj);
        tracked.object = obj;
        tracked.shaped = true;
        this.pickMap.set(obj, wid);
      }

      if (!e.transform) continue;

      const t = interpolator.sample(wid, alpha) ?? e.transform;
      tracked.object.position.set(t.px, t.py, t.pz);
      tracked.object.quaternion.set(t.qx, t.qy, t.qz, t.qw);
      tracked.object.scale.set(t.sx, t.sy, t.sz);

      if (playerWireId !== null && wid === playerWireId) {
        this.player = this.playerPos.copy(tracked.object.position);
        highlight(tracked.object, "player");
      } else {
        highlight(tracked.object, wid === this.hoveredWireId ? "hover" : "none");
      }
    }

    this.props.setHovered(this.hoveredWireId);
    if (this.player) this.lastPlayerPos.copy(this.player);
    this.fx.setPlayerPos(this.player);

    const now = performance.now() / 1000;
    const dt = this.lastFrame < 0 ? 1 / 60 : Math.min(0.1, now - this.lastFrame);
    this.lastFrame = now;
    this.fx.update(dt, now);
    this.showcase.update(now, dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fx.dispose();
    this.showcase.dispose();
    for (const t of this.meshes.values()) {
      this.group.remove(t.object);
      disposeObject(t.object);
    }
    this.meshes.clear();
    this.pickMap.clear();
    this.props.dispose();
    this.pcgMeshes?.dispose();
    this.group.removeFromParent();
  }

  /**
   * PCG scatter seam: the art pack maps assetHash -> model. Null when
   * there's no pack (placeholder provider) or the asset isn't in it.
   */
  private modelFor(asset: AssetRefRow | undefined): THREE.Object3D | null {
    if (!asset || typeof this.assets.assetMesh !== "function") return null;
    return this.assets.assetMesh(asset) ?? null;
  }

  private makeBodyMesh(wid: bigint, body: BodyConfigRow | undefined, model: THREE.Object3D | null): THREE.Object3D {
    if (model) {
      colorize(model, placeholderColor(wid));
      return model;
    }
    if (body) {
      const obj = this.assets.bodyMesh(body);
      colorize(obj, placeholderColor(wid));
      return obj;
    }
    // Stand-in until the BodyConfig row arrives (spawned entities carry
    // it in the same snapshot/delta, so this is rare and transient).
    const obj = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }),
    );
    colorize(obj, placeholderColor(wid));
    return obj;
  }
}

/**
 * Scenery that never moves, batched per model (see InstancedProps): a
 * static body, or an asset-only entity (scatter without collision).
 */
function isStaticProp(body: BodyConfigRow | undefined, asset: AssetRefRow | undefined): boolean {
  return body !== undefined ? body.motionType === MotionType.Static : asset !== undefined;
}

function propAsset(asset: AssetRefRow | undefined): PropAsset | null {
  return asset ? { assetHash: asset.assetHash, variant: asset.variant } : null;
}

function colorize(obj: THREE.Object3D, color: THREE.Color): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (mat && "color" in mat) mat.color.copy(color);
  });
}

function highlight(obj: THREE.Object3D, mode: "player" | "hover" | "none"): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (mat && "emissive" in mat) {
      mat.emissive.copy(tmpColor.set(mode === "player" ? 0x224422 : mode === "hover" ? 0x444422 : 0x000000));
    }
  });
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    geo?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}
