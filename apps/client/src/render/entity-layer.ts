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
 * Characters: an entity with an Appearance (players, bots, enemy humans)
 * is a modular character wearing its look, once the character kit has
 * loaded (the art is served by the dev server; without it they stay
 * boxes). It faces where it moves — or its combat move's facing — and is
 * animated from how it moves and the move the server says it is in (see
 * CharacterAnimator) once the animation library has loaded.
 *
 * Scenery: props show the art packs' models (SyntyProps) when the art is
 * served, else PICG's cooked meshes, else placeholders.
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
import { labelSprite } from "./element-fx.js";
import { combatMove, type ActionRow, type AssetRefRow, type BodyConfigRow, type VelocityRow } from "@mmo-engine/protocol";
import { parseLook, heldOf, lostOf } from "@mmo-engine/art/browser";
import { MotionType } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { Interpolator, MirrorState } from "@mmo-engine/mirror";
import type { PcgRpcClient } from "@mmo-engine/picg";
import { placeholderColor, type AssetProvider } from "./assets.js";
import { EntityFxSystem } from "./entity-fx.js";
import { FxShowcase } from "./showcase.js";
import { QuarksFx } from "./vfx/quarks-fx.js";
import { InstancedProps, type PropAsset } from "./instanced-props.js";
import type { WorkerRequester } from "../workers/pool.js";
import { PcgMeshes } from "./pcg-meshes.js";
import { ChainedPropModels, SyntyProps, fnv1a32 } from "./synty-props.js";
import { CharacterKit, type ModularCharacter } from "./character/character-kit.js";
import { AnimationLibrary, CharacterAnimator } from "./character/character-animator.js";
import type { TerrainRenderer } from "./terrain/terrain-renderer.js";
import type { QualitySettings } from "./quality.js";

export interface EntityLayerOptions {
  /** The region's Pcg service: props whose AssetRef is a PCG asset show its cooked mesh. */
  pcg?: PcgRpcClient;
  /** Decode PCG meshes and build their BVHs off the main thread. */
  workers?: WorkerRequester;
}

interface TrackedMesh {
  object: THREE.Object3D;
  /** True once a BodyConfig row shaped this mesh (else unit-box stand-in). */
  shaped: boolean;
  /** The modular character this entity is shown as, and the look (JSON) it wears. */
  character?: ModularCharacter;
  look?: string;
  /** Facing (radians about +Y) — characters turn toward their movement. */
  yaw?: number;
  /** Plays the character's clips (once the animation library is in). */
  animator?: CharacterAnimator;
  female?: boolean;
  /** The combat move on show: "seq:move" of its Action row. */
  actionKey?: string;
  /** Nameplate sprite above the head, and the name it shows. */
  plate?: THREE.Sprite;
  plateFor?: string;
  /** Held-weapon models on show, per hand (art catalog ids). */
  held?: { main?: string; off?: string };
  /** The look JSON the held models were read from (skip re-parsing). */
  heldJson?: string;
  /** Live weapon meshes, per hand (shared geometry/material — never disposed). */
  weapons?: { main?: THREE.Object3D; off?: THREE.Object3D };
}

/** Nameplate height above a character's feet, and full-visibility range. */
const PLATE_HEIGHT = 2.05;
const PLATE_FULL_RANGE = 12;
const PLATE_FADE_RANGE = 45;
/** Nameplate text height, world units (labelSprite is 1 unit tall). */
const PLATE_TEXT_HEIGHT = 0.4;
/** Default when the caller passes no names (tests, probes). */
const EMPTY_NAMES: ReadonlyMap<bigint, string> = new Map();

/** The server clock: combat moves play from their start tick. */
export interface ServerClock {
  tick: number;
  tickHz: number;
}

/** Speed (m/s) above which a character turns to face its movement. */
const FACE_MOVING_SPEED = 0.2;
/** How fast a character turns toward its movement (1/s). */
const TURN_RATE = 12;

const tmpColor = new THREE.Color();
const tmpEye = new THREE.Vector3();
const tmpSpawn = new THREE.Vector3();
/** Warn-once log (missing bones, missing models: per session, not per frame). */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

export class EntityLayer {
  /** Everything this layer draws that isn't FX: add it to the scene. */
  readonly group = new THREE.Group();
  /** The player's interpolated position this frame (null until it appears). */
  player: THREE.Vector3 | null = null;
  /** First-person mode hides the player's own avatar (set via setPlayerHidden). */
  private playerHidden = false;
  private lastPlayerWireId: bigint | null = null;
  private readonly meshes = new Map<bigint, TrackedMesh>();
  private readonly props: InstancedProps;
  private readonly pcgMeshes: PcgMeshes | null;
  private readonly syntyProps: SyntyProps;
  /** The modular character kit; null until loaded (or when the art isn't served). */
  private kit: CharacterKit | null = null;
  /** The characters' clips; null until loaded (or when none are served). */
  private animations: AnimationLibrary | null = null;
  /** Root object -> wire id for hover raycasting (non-terrain only). */
  private readonly pickMap = new Map<THREE.Object3D, bigint>();
  private readonly fx: EntityFxSystem;
  /** Attached particle effects (three.quarks): signals' particles and auras, trails. */
  readonly vfx = new QuarksFx();
  private readonly showcase: FxShowcase;
  private readonly playerPos = new THREE.Vector3();
  private readonly lastPlayerPos = new THREE.Vector3(8, 2, 8);
  private hoveredWireId: bigint | null = null;
  /** Hit flashes: wire id -> flash end, performance.now() seconds (see setFlashes). */
  private flashes: ReadonlyMap<bigint, number> = new Map();
  private quality: QualitySettings | null = null;
  private lastFrame = -1;
  private disposed = false;
  /** Nameplate textures, one per distinct name (sprites share them). */
  private readonly plateTextures = new Map<string, THREE.CanvasTexture>();

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly assets: AssetProvider,
    private readonly terrain: TerrainRenderer,
    opts: EntityLayerOptions = {},
  ) {
    this.pcgMeshes = opts.pcg ? new PcgMeshes(opts.pcg, () => this.props.modelsChanged(), undefined, opts.workers) : null;
    // Scenery shows the art packs' models when the art is served, else PICG meshes.
    this.syntyProps = new SyntyProps(() => this.props.modelsChanged());
    this.props = new InstancedProps(new ChainedPropModels(this.pcgMeshes ? [this.syntyProps, this.pcgMeshes] : [this.syntyProps]));
    this.group.add(this.props.group);
    this.fx = new EntityFxSystem(scene, camera);
    this.group.add(this.vfx.renderer);
    const ground = (x: number, z: number): number | null => this.terrain.heightAt(x, z);
    this.vfx.setGround(ground);
    this.showcase = new FxShowcase(scene, (pos, color) => this.fx.spawnBurst(pos, color), this.vfx, ground);
    CharacterKit.load()
      .then((kit) => {
        if (this.disposed) kit.dispose();
        else {
          this.kit = kit;
          if (this.quality) this.setQuality(this.quality);
        }
      })
      .catch((e: unknown) =>
        console.info(`[world] characters stay placeholders: ${e instanceof Error ? e.message : e}`),
      );
    AnimationLibrary.load()
      .then((lib) => {
        if (!this.disposed) this.animations = lib;
      })
      .catch((e: unknown) => console.info(`[world] characters stay unanimated: ${e instanceof Error ? e.message : e}`));
  }

  /** Scenery counts (dev tools, probes, the HUD). */
  get stats(): { props: number; propDrawCalls: number; propsWithModels: number; artModels: number; meshes: number; propTriangles: number; propFullTriangles: number; propsPerLevel: number[] } {
    const p = this.props.stats();
    return {
      props: p.props,
      propDrawCalls: p.drawCalls,
      propsWithModels: this.props.cookedCount,
      artModels: this.syntyProps.size,
      meshes: this.meshes.size,
      propTriangles: p.triangles,
      propFullTriangles: p.fullTriangles,
      propsPerLevel: p.perLevel,
    };
  }

  /** Hover highlight: the nearest entity mesh or batched prop under the ray (terrain excluded). */
  hover(raycaster: THREE.Raycaster): void {
    const hit = raycaster.intersectObjects([...this.pickMap.keys()], false)[0];
    const prop = this.props.pick(raycaster);
    this.hoveredWireId =
      prop && (!hit || prop.distance < hit.distance) ? prop.wireId : hit ? this.pickMap.get(hit.object) ?? null : null;
  }

  /** The entity under the cursor at the last hover() (a batched prop's or a mesh's wire id). */
  get hovered(): bigint | null {
    return this.hoveredWireId;
  }

  /** Entities flash red until their entry's time (performance.now() seconds); the map is read, never copied. */
  setFlashes(flashes: ReadonlyMap<bigint, number>): void {
    this.flashes = flashes;
  }

  /**
   * First-person mode: hide the player's own avatar so the camera doesn't
   * sit inside its head. Applied on every sync (the mesh may not exist yet
   * when toggled).
   */
  setPlayerHidden(hidden: boolean): void {
    this.playerHidden = hidden;
    this.applyPlayerHidden();
  }

  private applyPlayerHidden(): void {
    const wid = this.lastPlayerWireId;
    if (wid === null) return;
    const tracked = this.meshes.get(wid);
    if (tracked) tracked.object.visible = !this.playerHidden;
  }

  /** Apply a quality preset: character outlines, and the effects' particle budget. */
  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.vfx.setBudget(q.particles);
    if (this.kit?.outlineMaterial) this.kit.outlineMaterial.visible = q.outlines;
  }

  setShowcaseVisible(v: boolean, cameraPos: THREE.Vector3): void {
    const forward = new THREE.Vector3().subVectors(this.lastPlayerPos, cameraPos);
    forward.y = 0;
    if (forward.lengthSq() > 1e-6) forward.normalize();
    const center = this.lastPlayerPos.clone().addScaledVector(forward, 7);
    this.showcase.setVisible(v, center);
  }

  /**
   * Nameplates (C3): one cached-texture sprite over named characters
   * (never the player's own), fading with camera distance. Textures are
   * shared per name; sprites die with their entity (see detachPlate).
   */
  private updatePlate(
    tracked: TrackedMesh,
    wid: bigint,
    isPlayer: boolean,
    names: ReadonlyMap<bigint, string>,
  ): void {
    const name = isPlayer ? undefined : names.get(wid);
    if (name === undefined) {
      detachPlate(tracked);
      return;
    }
    if (tracked.plate === undefined || tracked.plateFor !== name) {
      detachPlate(tracked);
      let tex = this.plateTextures.get(name);
      if (!tex) {
        const sprite = labelSprite(name);
        tex = sprite.material.map as THREE.CanvasTexture;
        sprite.material.dispose();
        this.plateTextures.set(name, tex);
      }
      const plate = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
      );
      const w = tex.image.width as number;
      plate.scale.set((w / 72) * PLATE_TEXT_HEIGHT, PLATE_TEXT_HEIGHT, 1);
      plate.position.y = PLATE_HEIGHT;
      tracked.object.add(plate);
      tracked.plate = plate;
      tracked.plateFor = name;
    }
    const dist = this.camera.getWorldPosition(tmpEye).distanceTo(tracked.object.position);
    const mat = tracked.plate.material;
    mat.opacity = dist <= PLATE_FULL_RANGE ? 1 : Math.max(0, 1 - (dist - PLATE_FULL_RANGE) / (PLATE_FADE_RANGE - PLATE_FULL_RANGE));
    tracked.plate.visible = mat.opacity > 0;
  }

  /** Reconcile the layer with mirror state and advance the FX. */
  sync(
    state: MirrorState,
    interpolator: Interpolator,
    alpha: number,
    playerWireId: bigint | null,
    clock: ServerClock = { tick: 0, tickHz: 30 },
    names: ReadonlyMap<bigint, string> = EMPTY_NAMES,
  ): void {
    // Remove meshes and terrain for despawned entities.
    for (const [key, t] of this.meshes) {
      if (!state.entities.has(key)) {
        this.group.remove(t.object);
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

    this.player = null;
    this.lastPlayerWireId = playerWireId;
    this.applyPlayerHidden();

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
        detachPlate(tracked);
        this.detachWeapons(tracked);
        disposeObject(tracked.object);
        const model = this.modelFor(e.asset);
        if (!model && isStaticProp(e.body, e.asset) && e.transform) {
          detachPlate(tracked);
          this.detachWeapons(tracked);
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

      // Appearance: show (or restyle) the entity as its modular character.
      if (e.appearance && this.kit && tracked.look !== e.appearance.look) {
        this.dressAsCharacter(wid, tracked, e.appearance.look);
      }
      // Held weapons ride in the appearance JSON next to the look.
      if (e.appearance && tracked.character) this.updateHeld(tracked, e.appearance.look);

      if (!e.transform) continue;

      const t = interpolator.sample(wid, alpha) ?? e.transform;
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
      if (isPlayer) this.player = this.playerPos.copy(tracked.object.position);
      this.updatePlate(tracked, wid, isPlayer, names);
      if ((this.flashes.get(wid) ?? 0) > now) {
        highlight(tracked.object, "hit");
      } else if (tracked.character) {
        highlight(tracked.object, wid === this.hoveredWireId && !isPlayer ? "hover" : "none");
      } else {
        highlight(tracked.object, isPlayer ? "player" : wid === this.hoveredWireId ? "hover" : "none");
      }
    }

    this.props.setHovered(this.hoveredWireId);
    // Levels of detail follow the camera.
    this.props.updateLod(this.camera.getWorldPosition(tmpEye));
    if (this.player) this.lastPlayerPos.copy(this.player);
    this.fx.setPlayerPos(this.player);

    this.fx.update(dt, now);
    this.showcase.update(now, dt);
    this.vfx.update(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fx.dispose();
    this.showcase.dispose();
    this.vfx.dispose();
    for (const tex of this.plateTextures.values()) tex.dispose();
    this.plateTextures.clear();
    for (const t of this.meshes.values()) {
      this.group.remove(t.object);
      disposeTracked(t);
    }
    this.meshes.clear();
    this.pickMap.clear();
    this.props.dispose();
    this.pcgMeshes?.dispose();
    this.syntyProps.dispose();
    this.kit?.dispose();
    this.kit = null;
    this.group.removeFromParent();
  }

  /**
   * Held weapons (M3b): what `heldOf(lookJson)` names, drawn as shared
   * prop geometry parented to the hand bones. Models load async — a hand
   * whose model isn't ready retries on later frames. Meshes are removed
   * (never disposed: geometry/material stay shared) when the hands change
   * or the entity goes away (see detachWeapons).
   */
  private updateHeld(tracked: TrackedMesh, lookJson: string): void {
    if (!tracked.character) return;
    if (tracked.heldJson !== lookJson) {
      tracked.heldJson = lookJson;
      const held = heldOf(lookJson);
      tracked.held = held.main || held.off ? held : undefined;
      this.detachWeapons(tracked);
    }
    const want = tracked.held;
    if (!want) return;
    tracked.weapons ??= {};
    this.attachHeld(tracked, "main", want.main, "Hand_R");
    this.attachHeld(tracked, "off", want.off, "Hand_L");
  }

  /** Remove live weapon meshes (shared art: remove only, never dispose). */
  private detachWeapons(tracked: TrackedMesh): void {
    detachWeapons(tracked);
  }

  /** Attach one hand's weapon if its model is ready and not yet shown. */
  private attachHeld(tracked: TrackedMesh, side: "main" | "off", model: string | undefined, boneName: string): void {
    if (!model || !tracked.character || tracked.weapons?.[side]) return;
    const ready = this.syntyProps.model(fnv1a32(model), 0);
    if (!ready) return; // still loading: retry on a later frame
    const bone = tracked.character.bones.get(boneName);
    if (!bone) {
      warnOnce(`[world] rig has no ${boneName} bone: held ${model} stays hidden`);
      return;
    }
    const mesh = new THREE.Mesh(ready.geometry, ready.material);
    mesh.name = `held-${side}`;
    // Grip: blade along the arm, hilt at the palm. Tuned by eye (M3b).
    mesh.rotation.set(Math.PI / 2, 0, 0);
    // Cancel the rig's root scale so the model keeps its metre size.
    const scale = new THREE.Vector3();
    tracked.character.root.updateWorldMatrix(true, false);
    bone.getWorldScale(scale);
    mesh.scale.setScalar(1 / Math.max(scale.x, 1e-6));
    bone.add(mesh);
    tracked.weapons![side] = mesh;
  }

  private dressAsCharacter(wid: bigint, tracked: TrackedMesh, lookJson: string): void {
    const look = parseLook(lookJson);
    tracked.look = lookJson;
    if (!look || !this.kit) return;
    tracked.female = look.gender === "female";
    // Parts cut off in a fight (M3) are not drawn until the body is whole again.
    const lost = new Set(lostOf(lookJson));
    if (tracked.character) {
      tracked.character.setLook(look, lost).catch((e: unknown) => console.warn(`[world] ${e instanceof Error ? e.message : e}`));
      return;
    }
    const character = this.kit.create(look, lost);
    character.relaxArms();
    this.group.remove(tracked.object);
    this.pickMap.delete(tracked.object);
    detachPlate(tracked);
    this.detachWeapons(tracked);
    disposeObject(tracked.object);
    tracked.object = character.root;
    tracked.character = character;
    tracked.shaped = true;
    this.group.add(character.root);
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

const HIGHLIGHT = { player: 0x224422, hover: 0x444422, hit: 0x661111, none: 0x000000 } as const;

function highlight(obj: THREE.Object3D, mode: keyof typeof HIGHLIGHT): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (mat && "emissive" in mat) {
      mat.emissive.copy(tmpColor.set(HIGHLIGHT[mode]));
    }
  });
}

/**
 * Play the combat move the server says the character is in, from the
 * moment it started; back to locomotion when it's over. A guard is on the
 * upper body (the legs keep walking); other moves are whole-body.
 */
function playAction(t: TrackedMesh, row: ActionRow | undefined, clock: ServerClock): void {
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
  detachPlate(t);
  detachWeapons(t);
  t.animator?.dispose();
  if (t.character) t.character.dispose();
  else disposeObject(t.object);
}

/**
 * Detach the nameplate before its object is disposed or replaced:
 * traverse disposal must never touch the sprite's shared geometry or
 * the layer's cached texture — only the per-sprite material dies.
 * updatePlate() reattaches when still wanted.
 */
function detachPlate(t: TrackedMesh): void {
  if (t.plate) {
    t.plate.removeFromParent();
    t.plate.material.dispose();
    t.plate = undefined;
    t.plateFor = undefined;
  }
}

/**
 * Remove live weapon meshes before their object is disposed or replaced.
 * Shared art (see updateHeld): remove only, never dispose.
 */
function detachWeapons(t: TrackedMesh): void {
  for (const side of ["main", "off"] as const) {
    t.weapons?.[side]?.removeFromParent();
    if (t.weapons) delete t.weapons[side];
  }
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
