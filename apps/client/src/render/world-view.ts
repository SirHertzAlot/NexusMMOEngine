/**
 * WorldView — three.js mirror of authoritative ECS state.
 *
 * Owns the renderer, scene, camera, and lights. `sync()` is called
 * every rAF with the MirrorState + Interpolator. Nothing here simulates —
 * positions come from the server, full stop (skill operating rule 1).
 *
 *  - Terrain (Chunk entities + the welcome's world map): TerrainRenderer —
 *    streamed chunk tiles near the player, the coarse world on the horizon.
 *  - Scenery (scatter props): PropRenderer — instanced, a few draw calls.
 *  - Everything else (players, dynamic bodies): a mesh per wire id,
 *    created lazily, moved from interpolated transforms, removed on
 *    despawn.
 *
 * Placeholder visuals (Joey's decision for Phase 3): boxes/spheres per
 * BodyConfig shape. The AssetProvider abstraction is the seam where real
 * art plugs in later (a provider with assetMesh draws props per entity).
 */

import * as THREE from "three";
import type { MirrorState } from "@mmo-engine/mirror";
import type { Interpolator } from "@mmo-engine/mirror";
import { decodeWorldMap, type WorldInfo } from "@mmo-engine/protocol";
import {
  placeholderColor,
  type AssetProvider,
} from "./assets.js";
import { EntityFxSystem } from "./entity-fx.js";
import { FxShowcase } from "./showcase.js";
import { isProp, PropRenderer } from "./props.js";
import { TerrainRenderer } from "./terrain/terrain-renderer.js";

export interface WorldViewOptions {
  /** Chunk world size in units (server MMO_CHUNK_SIZE, default 16). */
  chunkWorldSize?: number;
}

interface TrackedMesh {
  object: THREE.Object3D;
  /** True once a BodyConfig row shaped this mesh (else unit-box stand-in). */
  shaped: boolean;
}

/** Daytime haze: the sky colour, and the fog the far terrain fades into. */
const SKY = 0x9db4c9;
/** Fog range, metres: the streamed ring (~270 m) is clear, the horizon hazes out. */
const FOG_NEAR = 350;
const FOG_FAR = 2600;

/** Which WebGL implementation the browser actually gave us. */
export interface GpuInfo {
  renderer: string;
  /**
   * Software rasterizer (SwiftShader / llvmpipe / Microsoft Basic Render
   * Driver): hardware acceleration is off or the GPU is blocklisted, and
   * single-digit fps is expected regardless of scene cost.
   */
  software: boolean;
}

function detectGpu(renderer: THREE.WebGLRenderer): GpuInfo {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(
    ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  );
  return {
    renderer: name,
    software: /swiftshader|llvmpipe|software|basic render/i.test(name),
  };
}

const tmpColor = new THREE.Color();
const tmpSpawn = new THREE.Vector3();

export class WorldView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly meshes = new Map<bigint, TrackedMesh>();
  readonly gpu: GpuInfo;
  /** Root object -> wire id for hover raycasting (non-terrain only). */
  private readonly pickMap = new Map<THREE.Object3D, bigint>();
  private readonly chunkWorldSize: number;
  private readonly terrain: TerrainRenderer;
  private readonly props: PropRenderer;
  /** Props go through PropRenderer unless the provider has real per-asset art. */
  private readonly instancedProps: boolean;
  private camDistance = 9;
  private disposed = false;
  private readonly fx: EntityFxSystem;
  private readonly showcase: FxShowcase;
  private hoveredWireId: bigint | null = null;
  private lastFrame = -1;
  private lastPlayerPos = new THREE.Vector3(8, 2, 8);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly onPointerMove: (e: PointerEvent) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly assets: AssetProvider,
    opts: WorldViewOptions = {},
  ) {
    this.chunkWorldSize = opts.chunkWorldSize ?? 16;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gpu = detectGpu(this.renderer);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);
    this.terrain = new TerrainRenderer(this.chunkWorldSize);
    this.scene.add(this.terrain.group);
    this.props = new PropRenderer();
    this.scene.add(this.props.group);
    this.instancedProps = typeof this.assets.assetMesh !== "function";

    // Warm bounce light from below: cliffs facing away from the sun stay readable.
    const hemi = new THREE.HemisphereLight(0xc4d8ff, 0x5c4c3a, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
    sun.position.set(30, 50, 20);
    this.scene.add(sun);

    this.fx = new EntityFxSystem(this.scene, this.camera);
    this.showcase = new FxShowcase(this.scene, (pos, color) =>
      this.fx.spawnBurst(pos, color),
    );

    // Hover highlight (raycast against entity meshes, terrain excluded).
    this.onPointerMove = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      this.pointerNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hits = this.raycaster.intersectObjects([...this.pickMap.keys(), ...this.props.pickTargets()], false);
      const hit = hits[0];
      this.hoveredWireId = hit ? this.pickMap.get(hit.object) ?? this.props.wireIdOf(hit) : null;
      this.props.setHover(this.hoveredWireId);
    };
    this.canvas.addEventListener("pointermove", this.onPointerMove);

    this.resize();
  }

  /**
   * The world from the welcome (a baked world's extent and coarse map), or
   * null for a legacy world: far horizon and ground colours.
   */
  setWorld(world: WorldInfo | null): void {
    this.terrain.setWorld(world ? { map: decodeWorldMap(world.map), bounds: world.bounds } : null);
  }

  setTerrainWireframe(on: boolean): void {
    this.terrain.setWireframe(on);
  }

  /** What's on screen (HUD, tests). */
  get stats(): { chunks: number; props: number; meshes: number; horizon: boolean } {
    return { chunks: this.terrain.chunkCount, props: this.props.count, meshes: this.meshes.size, horizon: this.terrain.hasFar };
  }

  /** Toggle the elemental-orb FX showcase (ring placed ahead of the player). */
  setShowcaseVisible(v: boolean): void {
    const forward = new THREE.Vector3()
      .subVectors(this.lastPlayerPos, this.camera.position);
    forward.y = 0;
    if (forward.lengthSq() > 1e-6) forward.normalize();
    const center = this.lastPlayerPos.clone().addScaledVector(forward, 7);
    this.showcase.setVisible(v, center);
  }

  get showcaseVisible(): boolean {
    return this.showcase.isVisible;
  }

  /** Third-person follow distance (mouse wheel). Clamped 4..24. */
  setCamDistance(d: number): void {
    this.camDistance = Math.max(4, Math.min(24, d));
  }

  getCamDistance(): number {
    return this.camDistance;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Reconcile the scene with mirror state. Camera follows the player
   * entity (third-person, mouse-orbit via look yaw/pitch).
   */
  sync(
    state: MirrorState,
    interpolator: Interpolator,
    alpha: number,
    playerWireId: bigint | null,
    lookYaw: number,
    lookPitch: number,
  ): void {
    // Drop what despawned: terrain chunks, props, and entity meshes.
    for (const wid of [...this.terrain.chunkWireIds()]) {
      if (!state.entities.has(wid)) this.terrain.removeChunk(wid);
    }
    for (const wid of [...this.props.wireIds()]) {
      if (!state.entities.has(wid)) this.props.remove(wid);
    }
    for (const [key, t] of this.meshes) {
      if (!state.entities.has(key)) {
        this.scene.remove(t.object);
        this.pickMap.delete(t.object);
        disposeObject(t.object);
        this.meshes.delete(key);
      }
    }

    let playerPos: THREE.Vector3 | null = null;

    for (const [wid, e] of state.entities) {
      const key = wid;
      // Terrain chunks render without a Transform row.
      if (e.chunk) {
        this.terrain.ensureChunk(wid, e.chunk);
        continue;
      }
      if (this.instancedProps && isProp(e)) {
        this.props.sync(wid, e);
        continue;
      }
      let tracked = this.meshes.get(key);
      if (!tracked) {
        if (!e.transform) continue;
        const obj = this.makeBodyMesh(wid, e.body, e.asset);
        this.scene.add(obj);
        this.meshes.set(key, { object: obj, shaped: e.body !== undefined });
        this.pickMap.set(obj, wid);
        // Spawn portal for players and other newly-appearing actors
        // (scenery streams in by the thousand; it gets none).
        if (!e.asset) this.fx.spawnBurst(tmpSpawn.set(e.transform.px, e.transform.py, e.transform.pz));
        tracked = this.meshes.get(key)!;
      } else if (!tracked.shaped && e.body) {
        // BodyConfig arrived after the stand-in: reshape.
        this.scene.remove(tracked.object);
        this.pickMap.delete(tracked.object);
        disposeObject(tracked.object);
        const obj = this.makeBodyMesh(wid, e.body, e.asset);
        this.scene.add(obj);
        tracked.object = obj;
        tracked.shaped = true;
        this.pickMap.set(obj, wid);
      }

      if (!e.transform) continue;

      const sample = interpolator.sample(wid, alpha);
      const t = sample ?? e.transform;
      tracked.object.position.set(t.px, t.py, t.pz);
      tracked.object.quaternion.set(t.qx, t.qy, t.qz, t.qw);
      tracked.object.scale.set(t.sx, t.sy, t.sz);

      if (playerWireId !== null && wid === playerWireId) {
        playerPos = tracked.object.position.clone();
        highlight(tracked.object, "player");
      } else {
        highlight(tracked.object, wid === this.hoveredWireId ? "hover" : "none");
      }
    }

    if (playerPos) this.lastPlayerPos.copy(playerPos);
    this.fx.setPlayerPos(playerPos);

    const now = performance.now() / 1000;
    const dt = this.lastFrame < 0 ? 1 / 60 : Math.min(0.1, now - this.lastFrame);
    this.lastFrame = now;
    this.fx.update(dt, now);
    this.showcase.update(now, dt);

    this.updateCamera(playerPos, lookYaw, lookPitch);
    this.terrain.update();
    this.renderer.render(this.scene, this.camera);
  }

  private makeBodyMesh(
    wid: bigint,
    body: import("@mmo-engine/protocol").BodyConfigRow | undefined,
    asset: import("@mmo-engine/protocol").AssetRefRow | undefined,
  ): THREE.Object3D {
    // PCG scatter seam: the art pack maps assetHash -> model. Absent
    // (placeholder provider) or unresolvable -> shape-based fallback.
    if (asset && typeof this.assets.assetMesh === "function") {
      const obj = this.assets.assetMesh(asset);
      if (obj) {
        colorize(obj, placeholderColor(wid));
        return obj;
      }
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

  private updateCamera(
    playerPos: THREE.Vector3 | null,
    lookYaw: number,
    lookPitch: number,
  ): void {
    const target = playerPos ?? new THREE.Vector3(8, 2, 8);
    // Camera behind the player, orbiting with mouse look.
    const d = this.camDistance;
    const cp = Math.cos(lookPitch);
    const sp = Math.sin(lookPitch);
    const cx = target.x - Math.sin(lookYaw) * cp * d;
    const cz = target.z - Math.cos(lookYaw) * cp * d;
    let cy = Math.max(target.y + sp * d + 1.2, target.y + 0.6);
    // Never inside a hillside: keep the camera above the ground under it.
    const ground = this.terrain.heightAt(cx, cz);
    if (ground !== null) cy = Math.max(cy, ground + 0.8);
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(target.x, target.y + 1.0, target.z);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.fx.dispose();
    this.showcase.dispose();
    for (const t of this.meshes.values()) {
      this.scene.remove(t.object);
      disposeObject(t.object);
    }
    this.meshes.clear();
    this.terrain.dispose();
    this.props.dispose();
    this.renderer.dispose();
  }
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
      mat.emissive.copy(
        tmpColor.set(mode === "player" ? 0x224422 : mode === "hover" ? 0x444422 : 0x000000),
      );
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
