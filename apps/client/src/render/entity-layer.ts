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
import { BROKEN_VARIANT, combatMove, type ActionRow, type AssetRefRow, type BodyConfigRow, type TransformRow, type VelocityRow } from "@mmo-engine/protocol";
import { parseLook, heldOf, lostOf } from "@mmo-engine/art/browser";
import { MotionType } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { Interpolator, MirrorState } from "@mmo-engine/mirror";
import type { PcgRpcClient } from "@mmo-engine/picg";
import { placeholderColor, type AssetProvider } from "./assets.js";
import { EntityFxSystem } from "./entity-fx.js";
import { FxShowcase } from "./showcase.js";
import { QuarksFx } from "./vfx/quarks-fx.js";
import { budgetMultiplierForTier } from "./fx/particle-fx.js";
import { InstancedProps, type PropAsset } from "./instanced-props.js";
import type { WorkerRequester } from "../workers/pool.js";
import { PcgMeshes } from "./pcg-meshes.js";
import { ChainedPropModels, SyntyProps, fnv1a32 } from "./synty-props.js";
import { CharacterKit, type ModularCharacter } from "./character/character-kit.js";
import { DEFAULT_CLIP_MAP, indexClipMap, parseClipMap, planClip } from "@mmo-engine/art/browser";
import { AnimationLibrary, CharacterAnimator } from "./character/character-animator.js";
import type { TerrainRenderer } from "./terrain/terrain-renderer.js";
import type { QualitySettings } from "./quality.js";
import { ANIMAL_LOD_RADIUS, AnimalRig, AnimalTemplate } from "./animal/animal-rig.js";
import { applyShading } from "./shading/shading.js";
import { DEPLETED_HEIGHT } from "./resource-nodes.js";

export interface EntityLayerOptions {
  /** The region's Pcg service: props whose AssetRef is a PCG asset show its cooked mesh. */
  pcg?: PcgRpcClient;
  /** Decode PCG meshes and build their BVHs off the main thread. */
  workers?: WorkerRequester;
  /** Materials for a PCG mesh with material slots, by slot name (a dungeon shell's palette). */
  materialFor?: (slots: readonly string[]) => THREE.Material[] | undefined;
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
  /** A static animal model given a procedural skeleton and gait (see animal/animal-rig.ts). */
  animal?: AnimalRig;
  /** The animal rig was tried (a model without a quadruped shape stays as it is). */
  animalTried?: boolean;
  /** Nameplate sprite above the head, and the name it shows. */
  plate?: THREE.Sprite;
  plateFor?: string;
  /** Held-weapon models on show, per hand (art catalog ids). */
  held?: { main?: string; off?: string };
  /** The look JSON the held models were read from (skip re-parsing). */
  heldJson?: string;
  /** Live weapon meshes, per hand (shared geometry/material — never disposed). */
  weapons?: { main?: THREE.Object3D; off?: THREE.Object3D };
  /** Cached look colours for the first-person hand/forearm viewmodel. */
  skinColor?: string;
  sleeveColor?: string;
  cuffColor?: string;
  /** Rest position of the character's Head bone in root-local space. */
  headRest?: THREE.Vector3;
  /** Half-height from BodyConfig for body-part raycast normalization. */
  halfY?: number;
}

/**
 * Pure helper: classify which anatomical body part a 3D raycast hit point
 * (`hitX, hitY, hitZ`) lands on relative to an entity at (`entityX, entityY, entityZ`)
 * facing `entityYaw`.
 */
export function classifyAimedBodyPart(
  hitX: number,
  hitY: number,
  hitZ: number,
  entityX: number,
  entityY: number,
  entityZ: number,
  entityYaw = 0,
  bottomY = entityY - 0.5,
  height = 1.0,
): string {
  const safeHeight = Math.max(0.4, height);
  const u = (hitY - bottomY) / safeHeight;
  if (u >= 0.76) return "head";
  const dx = hitX - entityX;
  const dz = hitZ - entityZ;
  const rx = -Math.cos(entityYaw);
  const rz = Math.sin(entityYaw);
  const lat = dx * rx + dz * rz;
  if (u < 0.44) {
    return lat < 0 ? "legLeft" : "legRight";
  }
  if (Math.abs(lat) > 0.18) {
    return lat < 0 ? "armUpperLeft" : "armUpperRight";
  }
  return "torso";
}

export interface PlayerRenderSample {
  vx: number;
  vy: number;
  vz: number;
  mode: number;
  grounded: boolean;
  move: number;
  moveElapsed: number;
  headBoneOffset: { x: number; y: number; z: number } | null;
  mainHeld: string | null;
  offHeld: string | null;
  skinColor: string | null;
  sleeveColor: string | null;
  cuffColor: string | null;
}

{
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
/** The clip map the editor's Animation panel saves (EA21), served to the dev client. */
const CLIP_MAP_URL = "/content/animation/clips.json";

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
  /** Worked-out resource nodes (gathering): drawn low until they come back. */
  private depleted: ReadonlySet<bigint> = new Set();
  /** Their lowered rows, made once per row the server sends (the props skip unchanged rows by identity). */
  private readonly lowRows = new Map<bigint, { from: TransformRow; fromBody: BodyConfigRow | null; t: TransformRow; b: BodyConfigRow | null }>();
  private readonly props: InstancedProps;
  private readonly pcgMeshes: PcgMeshes | null;
  readonly syntyProps: SyntyProps;
  /** Rig data per art model (null: the model is not a quadruped); disposed with the layer. */
  private readonly animalTemplates = new Map<number, AnimalTemplate | null>();
  /** The modular character kit; null until loaded (or when the art isn't served). */
  private kit: CharacterKit | null = null;
  /** The characters' clips; null until loaded (or when none are served). */
  private animations: AnimationLibrary | null = null;
  /** Which library clip each server clip id plays (EA21); content/animation/clips.json over the shipped default. */
  private clipMap = indexClipMap(DEFAULT_CLIP_MAP);
  /** Root object -> wire id for hover raycasting (non-terrain only). */
  private readonly pickMap = new Map<THREE.Object3D, bigint>();
  private readonly fx: EntityFxSystem;
  /** Attached particle effects (three.quarks): signals' particles and auras, trails. */
  readonly vfx = new QuarksFx();
  private readonly showcase: FxShowcase;
  private readonly playerPos = new THREE.Vector3();
  private readonly lastPlayerPos = new THREE.Vector3(8, 2, 8);
  private hoveredWireId: bigint | null = null;
  private hoveredBodyPart: string | null = null;
  private hoveredHitDistance = Infinity;
  private readonly headBoneDelta = { x: 0, y: 0, z: 0 };
  private readonly tmpBonePos = new THREE.Vector3();
  private readonly tmpRootInv = new THREE.Matrix4();
  readonly playerSample: PlayerRenderSample = {
    vx: 0,
    vy: 0,
    vz: 0,
    mode: 0,
    grounded: true,
    move: 0,
    moveElapsed: 0,
    headBoneOffset: null,
    mainHeld: null,
    offHeld: null,
    skinColor: null,
    sleeveColor: null,
    cuffColor: null,
  };
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
    this.pcgMeshes = opts.pcg ? new PcgMeshes(opts.pcg, () => this.props.modelsChanged(), undefined, opts.workers, opts.materialFor) : null;
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
    fetch(CLIP_MAP_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json && !this.disposed) this.clipMap = indexClipMap(parseClipMap(json));
      })
      .catch((e: unknown) => console.info(`[world] default clip map: ${e instanceof Error ? e.message : e}`));
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
    const pickRoots: THREE.Object3D[] = [];
    for (const [obj, wid] of this.pickMap) {
      if (this.lastPlayerWireId !== null && wid === this.lastPlayerWireId) continue;
      pickRoots.push(obj);
    }
    const hits = raycaster.intersectObjects(pickRoots, true);
    let hit: THREE.Intersection | undefined;
    let hitWid: bigint | null = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!;
      if (h.object instanceof THREE.Sprite) continue;
      let cur: THREE.Object3D | null = h.object;
      while (cur && !this.pickMap.has(cur)) cur = cur.parent;
      if (cur) {
        hit = h;
        hitWid = this.pickMap.get(cur) ?? null;
        break;
      }
    }
    const prop = this.props.pick(raycaster);
    this.hoveredWireId =
      prop && (!hit || prop.distance < hit.distance) ? prop.wireId : hitWid;
    if (prop && (!hit || prop.distance < hit.distance)) {
      this.hoveredBodyPart = null;
      this.hoveredHitDistance = prop.distance;
    } else if (hit && hitWid !== null) {
      this.hoveredHitDistance = hit.distance;
      const tr = this.meshes.get(hitWid);
      if (tr) {
        const pos = tr.object.position;
        const yaw = tr.yaw ?? 0;
        const halfY = tr.halfY ?? 0.5;
        const bottomY = tr.character ? pos.y : pos.y - halfY;
        const height = tr.character ? 1.8 : Math.max(0.5, halfY * 2);
        this.hoveredBodyPart = classifyAimedBodyPart(
          hit.point.x,
          hit.point.y,
          hit.point.z,
          pos.x,
          pos.y,
          pos.z,
          yaw,
          bottomY,
          height,
        );
      } else {
        this.hoveredBodyPart = "torso";
      }
    } else {
      this.hoveredBodyPart = null;
      this.hoveredHitDistance = Infinity;
    }
  }

  /** The entity under the cursor at the last hover() (a batched prop's or a mesh's wire id). */
  get hovered(): bigint | null {
    return this.hoveredWireId;
  }

  get hoveredPart(): string | null {
    return this.hoveredBodyPart;
  }

  get hoveredDistance(): number {
    return this.hoveredHitDistance;
  }

  /** Entities flash red until their entry's time (performance.now() seconds); the map is read, never copied. */
  /** Models this layer has ready and still loading (PCG meshes and Synty art), for the world's load gate. */
  modelLoad(): { ready: number; pending: number } {
    return {
      ready: this.syntyProps.size + (this.pcgMeshes?.size ?? 0),
      pending: this.syntyProps.pendingCount + (this.pcgMeshes?.pendingCount ?? 0),
    };
  }

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
    this.vfx.setBudget(budgetMultiplierForTier(q.tier));
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

  /** The resource nodes worked out now (ResourceNodes.depleted): drawn at DEPLETED_HEIGHT of their height. */
  setDepleted(ids: ReadonlySet<bigint>): void {
    this.depleted = ids;
  }

  /** The rows a prop is drawn with: as sent, or lowered while it is a worked-out resource node or broken (BROKEN_VARIANT). */
  private shown(wid: bigint, t: TransformRow, b: BodyConfigRow | null, asset?: AssetRefRow): [TransformRow, BodyConfigRow | null] {
    if (!this.depleted.has(wid) && asset?.variant !== BROKEN_VARIANT) {
      this.lowRows.delete(wid);
      return [t, b];
    }
    let low = this.lowRows.get(wid);
    if (!low || low.from !== t || low.fromBody !== b) {
      low = { from: t, fromBody: b, t: { ...t, sy: t.sy * DEPLETED_HEIGHT }, b: b ? { ...b, halfY: b.halfY * DEPLETED_HEIGHT } : null };
      this.lowRows.set(wid, low);
    }
    return [low.t, low.b];
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
        if (e.transform) {
          const [t, b] = this.shown(wid, e.transform, e.body ?? null, e.asset);
          this.props.update(wid, t, b);
        }
        continue;
      }
      let tracked = this.meshes.get(wid);

      if (!tracked) {
        if (!e.transform) continue;
        const model = this.modelFor(e.asset);
        if (!model && isStaticProp(e.body, e.asset)) {
          // Scenery: no spawn portal (a streamed ring brings hundreds at once).
          this.props.add(wid, ...this.shown(wid, e.transform, e.body ?? null, e.asset), placeholderColor(wid), propAsset(e.asset));
          continue;
        }
        const obj = this.makeBodyMesh(wid, e.body, model);
        this.group.add(obj);
        tracked = { object: obj, shaped: e.body !== undefined, halfY: e.body?.halfY };
        this.meshes.set(wid, tracked);
        this.pickMap.set(obj, wid);
        // Spawn portal for newly-spawned entities; one that only came
        // into view (interest management) appears without it.
        if (!state.entered.delete(wid)) this.fx.spawnBurst(tmpSpawn.set(e.transform.px, 0, e.transform.pz));
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
          this.props.add(wid, ...this.shown(wid, e.transform, e.body ?? null, e.asset), placeholderColor(wid), propAsset(e.asset));
          continue;
        }
        const obj = this.makeBodyMesh(wid, e.body, model);
        this.group.add(obj);
        tracked.object = obj;
        tracked.shaped = true;
        tracked.halfY = e.body.halfY;
        this.pickMap.set(obj, wid);
      }

      // A moving entity whose AssetRef is a static animal model: give it a procedural skeleton once the model is in.
      if (!tracked.animalTried && !tracked.character && !e.appearance && e.asset) this.dressAsAnimal(wid, tracked, e.asset);

      // Appearance: show (or restyle) the entity as its modular character.
      if (e.appearance && this.kit && tracked.look !== e.appearance.look) {
        this.dressAsCharacter(wid, tracked, e.appearance.look);
      }
      // Held weapons ride in the appearance JSON next to the look.
      // Held weapons ride in the appearance JSON next to the look.
      if (e.appearance) this.updateHeld(tracked, e.appearance.look);

      if (!e.transform) continue;

      const t = interpolator.sample(wid, alpha) ?? e.transform;
      tracked.object.position.set(t.px, t.py, t.pz);
      if (tracked.character) {
        const acting = e.action && e.action.move !== 0 ? e.action : null;
        turnToward(tracked, e.velocity, dt, acting?.yaw);
        if (!tracked.animator && this.animations) {
          tracked.animator = new CharacterAnimator(tracked.character.root, this.animations, { female: tracked.female });
        }
        // The server's clip (EA21) when it sends one; otherwise the move and the motion decide.
        const plan = planClip(e.animation, this.clipMap, clock.tick, clock.tickHz);
        const planActs = plan !== null && (plan.layers.upper || !plan.loop);
        if (tracked.animator && !planActs) playAction(tracked, e.action, clock);
        tracked.animator?.update(
          dt,
          {
            speed: e.velocity ? Math.hypot(e.velocity.lx, e.velocity.lz) : 0,
            vy: e.velocity?.ly ?? 0,
            mode: e.locomotion?.mode ?? 0,
          },
          plan,
        );
      } else if (tracked.animal) {
        const acting = e.action && e.action.move !== 0 ? e.action : null;
        turnToward(tracked, e.velocity, dt, acting?.yaw);
        tracked.object.scale.set(t.sx, t.sy, t.sz);
        const move = acting ? combatMove(acting.move) : undefined;
        tracked.animal.update(
          dt,
          {
            speed: e.velocity ? Math.hypot(e.velocity.lx, e.velocity.lz) : 0,
            attackT: acting && move ? Math.max(0, (clock.tick - acting.started) / clock.tickHz) : -1,
            hitAt: move?.hitAt ?? (move ? move.duration * 0.5 : 0),
            attackDuration: move?.duration ?? 0,
            dead: e.health !== undefined && e.health.current <= 0,
          },
          this.camera.getWorldPosition(tmpEye).distanceTo(tracked.object.position) < ANIMAL_LOD_RADIUS,
        );
      } else {
        tracked.object.quaternion.set(t.qx, t.qy, t.qz, t.qw);
        tracked.object.scale.set(t.sx, this.depleted.has(wid) ? t.sy * DEPLETED_HEIGHT : t.sy, t.sz);
      }

      const isPlayer = playerWireId !== null && wid === playerWireId;
      if (isPlayer) {
        this.player = this.playerPos.copy(tracked.object.position);
        const s = this.playerSample;
        s.vx = e.velocity?.lx ?? 0;
        s.vy = e.velocity?.ly ?? 0;
        s.vz = e.velocity?.lz ?? 0;
        s.mode = e.locomotion?.mode ?? 0;
        s.grounded = s.mode === 0 && Math.abs(s.vy) < 0.08;
        s.move = e.action?.move ?? 0;
        s.moveElapsed = e.action && e.action.move !== 0 ? Math.max(0, (clock.tick - e.action.started) / Math.max(1, clock.tickHz)) : 0;
        s.mainHeld = tracked.held?.main ?? null;
        s.offHeld = tracked.held?.off ?? null;
        s.skinColor = tracked.skinColor ?? null;
        s.sleeveColor = tracked.sleeveColor ?? null;
        s.cuffColor = tracked.cuffColor ?? null;
        const headBone = tracked.character?.bones.get("Head");
        if (headBone && tracked.character) {
          tracked.character.root.updateWorldMatrix(true, true);
          this.tmpRootInv.copy(tracked.character.root.matrixWorld).invert();
          this.tmpBonePos.setFromMatrixPosition(headBone.matrixWorld).applyMatrix4(this.tmpRootInv);
          if (!tracked.headRest) {
            tracked.headRest = this.tmpBonePos.clone();
          }
          this.headBoneDelta.x = this.tmpBonePos.x - tracked.headRest.x;
          this.headBoneDelta.y = this.tmpBonePos.y - tracked.headRest.y;
          this.headBoneDelta.z = this.tmpBonePos.z - tracked.headRest.z;
          s.headBoneOffset = this.headBoneDelta;
        } else {
          s.headBoneOffset = null;
        }
      }
      this.updatePlate(tracked, wid, isPlayer, names);
      if ((this.flashes.get(wid) ?? 0) > now) {
        highlight(tracked.object, "hit");
      } else if (tracked.character) {
        highlight(tracked.object, wid === this.hoveredWireId && !isPlayer ? "hover" : "none");
      } else if (tracked.animal) {
        // Shares the model's material with the scenery: no per-entity tint.
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

  /** Where the static props showing any of these assets stand (a dungeon's torches give light there). */
  emitterPositions(hashes: ReadonlySet<number>): [number, number, number][] {
    return this.props.positionsOf(hashes);
  }

  /** Matte stand-ins and models (nothing shiny). */
  matte(): void {
    this.props.matte();
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
    for (const t of this.animalTemplates.values()) t?.dispose();
    this.animalTemplates.clear();
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
    // Parse held items and look colours before checking tracked.character so FPS rig always has them.
    if (tracked.heldJson !== lookJson) {
      tracked.heldJson = lookJson;
      const held = heldOf(lookJson);
      tracked.held = held.main || held.off ? held : undefined;
      const parsedLook = parseLook(lookJson);
      if (parsedLook?.colours) {
        tracked.skinColor = parsedLook.colours.skin;
        tracked.sleeveColor = parsedLook.colours.primary;
        tracked.cuffColor = parsedLook.colours.leatherPrimary ?? parsedLook.colours.secondary;
      }
      this.detachWeapons(tracked);
    }
    const want = tracked.held;
    if (!tracked.character || !want) return;
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

  /**
   * Swap the stand-in for the animal's art model on a procedural skeleton, once the model has loaded.
   * Retried each frame until the model is in; a model that is not a quadruped is left as it is.
   */
  private dressAsAnimal(wid: bigint, tracked: TrackedMesh, asset: AssetRefRow): void {
    const ready = this.syntyProps.model(asset.assetHash, asset.variant);
    if (!ready) return;
    tracked.animalTried = true;
    let template = this.animalTemplates.get(asset.assetHash);
    if (template === undefined) {
      template = AnimalTemplate.from(ready.geometry);
      this.animalTemplates.set(asset.assetHash, template);
    }
    if (!template) return;
    const rig = template.create(ready.material);
    this.group.remove(tracked.object);
    this.pickMap.delete(tracked.object);
    detachPlate(tracked);
    disposeObject(tracked.object);
    tracked.object = rig.root;
    tracked.animal = rig;
    tracked.shaped = true;
    this.group.add(rig.root);
    this.pickMap.set(rig.root, wid);
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
      applyShading(model, "model");
      return model;
    }
    if (body) {
      const obj = this.assets.bodyMesh(body);
      colorize(obj, placeholderColor(wid));
      applyShading(obj, "placeholder");
      return obj;
    }
    // Stand-in until the BodyConfig row arrives (spawned entities carry
    // it in the same snapshot/delta, so this is rare and transient).
    const obj = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }),
    );
    colorize(obj, placeholderColor(wid));
    applyShading(obj, "placeholder");
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

let moveSound: ((event: string, x: number, y: number, z: number) => void) | null = null;
/** Where a move's sounds go (the game's audio engine); null: silent. */
export function setMoveSound(fn: typeof moveSound): void {
  moveSound = fn;
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
  // The move's sounds (content/combat): one as it starts, one on the hit frame.
  if (moveSound && move.sound) {
    const at = t.object.position;
    if (move.sound.start && offset < 0.15) moveSound(move.sound.start, at.x, at.y, at.z);
    if (move.sound.hit && move.hitAt !== undefined && offset < move.hitAt) {
      const hit = move.sound.hit;
      setTimeout(() => {
        if (t.actionKey === key && moveSound) moveSound(hit, t.object.position.x, t.object.position.y, t.object.position.z);
      }, (move.hitAt - offset) * 1000);
    }
  }
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
  else if (t.animal) t.animal.dispose(); // geometry and material belong to the model cache
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
