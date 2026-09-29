/**
 * WorldView — three.js mirror of authoritative ECS state.
 *
 * Owns the renderer, scene, camera, and lights. `sync()` is called
 * every rAF with the MirrorState + Interpolator: meshes are created
 * lazily per wire id, moved from interpolated transforms, and removed
 * when their entity despawns. Nothing here simulates — positions come
 * from the server, full stop (skill operating rule 1).
 *
 * The ground is TerrainRenderer's: the streamed chunks near the player,
 * and the whole world far away from the welcome's coarse map, so
 * mountains stand on the horizon kilometres off; WaterRenderer lays the
 * sea and lakes over it. A daylight haze (the scene fog) fades distance
 * into the sky, which is what makes far things read as far.
 *
 * Characters: an entity with an Appearance (players, enemy humans) is a
 * modular character wearing its look, once the character kit has loaded
 * (the art is served by the dev server; without it they stay boxes). It
 * faces where it is moving and is animated from how it moves (see
 * CharacterAnimator) once the animation library has loaded.
 *
 * Placeholder visuals (Joey's decision for Phase 3): boxes/spheres per
 * BodyConfig shape. The AssetProvider abstraction is the seam where real
 * art plugs in later. Static props without an art-pack model (the
 * scatter, well over a thousand around the player) are batched into
 * InstancedProps, one draw call per shape; everything else that moves,
 * and every art-pack model, is its own mesh.
 */

import * as THREE from "three";
import {
  combatMove,
  decodeWorldMap,
  type ActionRow,
  type AssetRefRow,
  type BodyConfigRow,
  type VelocityRow,
  type WorldInfo,
} from "@mmo-engine/protocol";
import { parseLook } from "@mmo-engine/art/browser";
import { CharacterKit, type ModularCharacter } from "./character/character-kit.js";
import { AnimationLibrary, CharacterAnimator } from "./character/character-animator.js";
import { MotionType } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { MirrorState } from "@mmo-engine/mirror";
import type { Interpolator } from "@mmo-engine/mirror";
import {
  placeholderColor,
  type AssetProvider,
} from "./assets.js";
import { updateTerrainFx } from "./terrain-fx.js";
import { EntityFxSystem } from "./entity-fx.js";
import { FxShowcase } from "./showcase.js";
import { InstancedProps, type PropAsset } from "./instanced-props.js";
import { PcgMeshes } from "./pcg-meshes.js";
import type { PcgRpcClient } from "@mmo-engine/picg";
import { TerrainRenderer } from "./terrain/terrain-renderer.js";
import { WaterRenderer } from "./water.js";

/** Sky and haze colour (the fog fades distance into it). */
const SKY = 0x9fc0dc;
/** Haze: clear to FOG_NEAR metres, gone into the sky by FOG_FAR. */
const FOG_NEAR = 200;
const FOG_FAR = 3200;
/** Camera range: the far plane sits just past the haze. */
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = FOG_FAR + 800;

export interface WorldViewOptions {
  /** Chunk world size in units (server MMO_CHUNK_SIZE, default 16). */
  chunkWorldSize?: number;
  /** The region's Pcg service: props whose AssetRef is a PCG asset show its cooked mesh. */
  pcg?: PcgRpcClient;
}

interface TrackedMesh {
  object: THREE.Object3D;
  /** True once a BodyConfig row shaped this mesh (else unit-box stand-in). */
  shaped: boolean;
  /** The modular character this entity is shown as, and the look (JSON) it wears. */
  character?: ModularCharacter;
  look?: string;
  /** Plays the character's clips (once the animation library is in). */
  animator?: CharacterAnimator;
  female?: boolean;
  /** The combat move on show: "seq:move" of its Action row. */
  actionKey?: string;
  /** Facing (radians about +Y) — characters turn toward their movement. */
  yaw?: number;
}

/** Speed (m/s) above which a character turns to face its movement. */
const FACE_MOVING_SPEED = 0.2;
/** How fast a character turns toward its movement (1/s). */
const TURN_RATE = 12;

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
  private readonly terrain: TerrainRenderer;
  private readonly water = new WaterRenderer();
  private readonly props: InstancedProps;
  private readonly pcgMeshes: PcgMeshes | null;
  readonly gpu: GpuInfo;
  /** Root object -> wire id for hover raycasting (non-terrain only). */
  private readonly pickMap = new Map<THREE.Object3D, bigint>();
  private readonly chunkWorldSize: number;
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
  /** The modular character kit; null until loaded (or when the art isn't served). */
  private kit: CharacterKit | null = null;
  /** The characters' clips; null until loaded (or when none are served). */
  private animations: AnimationLibrary | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly assets: AssetProvider,
    opts: WorldViewOptions = {},
  ) {
    this.chunkWorldSize = opts.chunkWorldSize ?? 16;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gpu = detectGpu(this.renderer);
    this.camera = new THREE.PerspectiveCamera(60, 1, CAMERA_NEAR, CAMERA_FAR);

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);

    this.terrain = new TerrainRenderer(this.chunkWorldSize);
    this.scene.add(this.terrain.group);
    this.scene.add(this.water.group);
    this.pcgMeshes = opts.pcg ? new PcgMeshes(opts.pcg, () => this.props.modelsChanged()) : null;
    this.props = new InstancedProps(this.pcgMeshes);
    this.scene.add(this.props.group);

    const hemi = new THREE.HemisphereLight(0xbdd4ff, 0x2a2118, 0.9);
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
      const hit = this.raycaster.intersectObjects([...this.pickMap.keys()], false)[0];
      const prop = this.props.pick(this.raycaster);
      this.hoveredWireId =
        prop && (!hit || prop.distance < hit.distance) ? prop.wireId : hit ? this.pickMap.get(hit.object) ?? null : null;
    };
    this.canvas.addEventListener("pointermove", this.onPointerMove);

    CharacterKit.load()
      .then((kit) => {
        if (this.disposed) kit.dispose();
        else this.kit = kit;
      })
      .catch((e: unknown) =>
        console.info(`[world] characters stay placeholders: ${e instanceof Error ? e.message : e}`),
      );
    AnimationLibrary.load()
      .then((lib) => {
        if (!this.disposed) this.animations = lib;
      })
      .catch((e: unknown) => console.info(`[world] characters stay unanimated: ${e instanceof Error ? e.message : e}`));

    this.resize();
  }

  /**
   * The baked world from the welcome (coarse map, extent, sea level): far
   * terrain, ground colours, and water. Null (legacy world): chunks only.
   */
  setWorld(world: WorldInfo | null): void {
    const map = world ? decodeWorldMap(world.map) : null;
    this.terrain.setWorld(world && map ? { map, bounds: world.bounds, seaLevel: world.seaLevel ?? null } : null);
    this.water.setWorld(map, world?.seaLevel ?? null);
  }

  setTerrainWireframe(on: boolean): void {
    this.terrain.setWireframe(on);
    this.water.setWireframe(on);
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
    /** The server clock: combat moves play from their start tick. */
    clock: { tick: number; tickHz: number } = { tick: 0, tickHz: 30 },
  ): void {
    // Remove meshes and terrain for despawned entities.
    for (const [key, t] of this.meshes) {
      if (!state.entities.has(key)) {
        this.scene.remove(t.object);
        this.pickMap.delete(t.object);
        disposeTracked(t);
        this.meshes.delete(key);
      }
    }
    const now = performance.now() / 1000;
    const dt = this.lastFrame < 0 ? 1 / 60 : Math.min(0.1, now - this.lastFrame);
    this.lastFrame = now;
    const gone: bigint[] = [];
    for (const wid of this.terrain.chunkWireIds()) if (!state.entities.has(wid)) gone.push(wid);
    for (const wid of gone) this.terrain.removeChunk(wid);
    gone.length = 0;
    for (const wid of this.props.wireIds()) if (!state.entities.has(wid)) gone.push(wid);
    for (const wid of gone) this.props.remove(wid);

    let playerPos: THREE.Vector3 | null = null;

    for (const [wid, e] of state.entities) {
      const key = wid;
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
      let tracked = this.meshes.get(key);

      if (!tracked) {
        if (!e.transform) continue;
        const model = this.modelFor(e.asset);
        if (!model && isStaticProp(e.body, e.asset)) {
          // Scenery: no spawn portal (a streamed ring brings hundreds at once).
          this.props.add(wid, e.transform, e.body ?? null, placeholderColor(wid), propAsset(e.asset));
          continue;
        }
        const obj = this.makeBodyMesh(wid, e.body, model);
        this.scene.add(obj);
        this.meshes.set(key, { object: obj, shaped: e.body !== undefined });
        this.pickMap.set(obj, wid);
        // Spawn portal for newly-appearing entities.
        this.fx.spawnBurst(tmpSpawn.set(e.transform.px, 0, e.transform.pz));
        tracked = this.meshes.get(key)!;
      } else if (!tracked.shaped && e.body) {
        // BodyConfig arrived after the stand-in: reshape (or batch).
        this.scene.remove(tracked.object);
        this.pickMap.delete(tracked.object);
        disposeObject(tracked.object);
        const model = this.modelFor(e.asset);
        if (!model && isStaticProp(e.body, e.asset) && e.transform) {
          this.meshes.delete(key);
          this.props.add(wid, e.transform, e.body ?? null, placeholderColor(wid), propAsset(e.asset));
          continue;
        }
        const obj = this.makeBodyMesh(wid, e.body, model);
        this.scene.add(obj);
        tracked.object = obj;
        tracked.shaped = true;
        this.pickMap.set(obj, wid);
      }

      // Appearance: show (or restyle) the entity as its modular character.
      if (e.appearance && this.kit && tracked.look !== e.appearance.look) {
        this.dressAsCharacter(wid, tracked, e.appearance.look);
      }

      if (!e.transform) continue;

      const sample = interpolator.sample(wid, alpha);
      const t = sample ?? e.transform;
      tracked.object.position.set(t.px, t.py, t.pz);
      if (tracked.character) {
        const acting = e.action && e.action.move !== 0 ? e.action : null;
        turnToward(tracked, e.velocity, dt, acting?.yaw);
        if (!tracked.animator && this.animations) {
          tracked.animator = new CharacterAnimator(tracked.character.root, this.animations, { female: tracked.female });
        }
        if (tracked.animator) playAction(tracked, e.action, clock);
        tracked.animator?.update(dt, {
          speed: e.velocity ? Math.hypot(e.velocity.lx, e.velocity.lz) : 0,
          vy: e.velocity?.ly ?? 0,
          mode: e.locomotion?.mode ?? 0,
        });
      } else {
        tracked.object.quaternion.set(t.qx, t.qy, t.qz, t.qw);
        tracked.object.scale.set(t.sx, t.sy, t.sz);
      }

      const isPlayer = playerWireId !== null && wid === playerWireId;
      if (isPlayer) playerPos = tracked.object.position.clone();
      if (tracked.character) {
        highlight(tracked.object, wid === this.hoveredWireId && !isPlayer ? "hover" : "none");
      } else {
        highlight(tracked.object, isPlayer ? "player" : wid === this.hoveredWireId ? "hover" : "none");
      }
    }

    this.props.setHovered(this.hoveredWireId);
    if (playerPos) this.lastPlayerPos.copy(playerPos);
    this.fx.setPlayerPos(playerPos);

    this.fx.update(dt, now);
    this.showcase.update(now, dt);

    this.updateCamera(playerPos, lookYaw, lookPitch);
    this.terrain.update();
    this.water.update(now);
    updateTerrainFx(now);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Show the entity as a modular character wearing `lookJson`: the first
   * time, the character replaces the stand-in; after that the look changes
   * in place. An unreadable look leaves the entity as it is.
   */
  private dressAsCharacter(wid: bigint, tracked: TrackedMesh, lookJson: string): void {
    const look = parseLook(lookJson);
    tracked.look = lookJson;
    if (!look || !this.kit) return;
    tracked.female = look.gender === "female";
    if (tracked.character) {
      tracked.character.setLook(look).catch((e: unknown) => console.warn(`[world] ${e instanceof Error ? e.message : e}`));
      return;
    }
    const character = this.kit.create(look);
    character.relaxArms();
    this.scene.remove(tracked.object);
    this.pickMap.delete(tracked.object);
    disposeObject(tracked.object);
    tracked.object = character.root;
    tracked.character = character;
    tracked.shaped = true;
    this.scene.add(character.root);
    this.pickMap.set(character.root, wid);
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
    const cy = target.y + sp * d + 1.2;
    this.camera.position.set(cx, Math.max(cy, target.y + 0.6), cz);
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
      disposeTracked(t);
    }
    this.meshes.clear();
    this.kit?.dispose();
    this.kit = null;
    this.terrain.dispose();
    this.water.dispose();
    this.props.dispose();
    this.pcgMeshes?.dispose();
    this.renderer.dispose();
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
      mat.emissive.copy(
        tmpColor.set(mode === "player" ? 0x224422 : mode === "hover" ? 0x444422 : 0x000000),
      );
    }
  });
}

/**
 * Play the combat move the server says the character is in, from the
 * moment it started; back to locomotion when it's over. A guard is on the
 * upper body (the legs keep walking); other moves are whole-body.
 */
function playAction(t: TrackedMesh, row: ActionRow | undefined, clock: { tick: number; tickHz: number }): void {
  const key = row && row.move !== 0 ? `${row.seq}:${row.move}` : undefined;
  if (key === t.actionKey) return;
  t.actionKey = key;
  const move = row ? combatMove(row.move) : undefined;
  if (!row || !move) {
    t.animator!.stop(0.25);
    return;
  }
  const offset = Math.max(0, (clock.tick - row.started) / clock.tickHz);
  t.animator!.play(move.clip, {
    offset: move.held ? offset % move.duration : offset,
    loop: move.held === true,
    mask: move.kind === "guard" ? "upper" : "full",
    fadeIn: 0.08,
    fadeOut: 0.15,
  });
}

/**
 * Turn a character toward its horizontal movement (it keeps its facing
 * while standing still) — or, in a combat move, toward the move's facing.
 * Presentation only: the server moves it.
 */
function turnToward(t: TrackedMesh, v: VelocityRow | undefined, dt: number, actionYaw?: number): void {
  let yaw = t.yaw ?? 0;
  if (actionYaw !== undefined) {
    const delta = Math.atan2(Math.sin(actionYaw - yaw), Math.cos(actionYaw - yaw));
    yaw += delta * Math.min(1, TURN_RATE * 2 * dt);
  } else if (v && Math.hypot(v.lx, v.lz) > FACE_MOVING_SPEED) {
    const want = Math.atan2(v.lx, v.lz); // the rig faces +Z
    const delta = Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw));
    yaw += delta * Math.min(1, TURN_RATE * dt);
  }
  t.yaw = yaw;
  t.object.rotation.set(0, yaw, 0);
}

/** Dispose what an entity's view owns (a character shares its kit's geometry). */
function disposeTracked(t: TrackedMesh): void {
  t.animator?.dispose();
  if (t.character) t.character.dispose();
  else disposeObject(t.object);
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
