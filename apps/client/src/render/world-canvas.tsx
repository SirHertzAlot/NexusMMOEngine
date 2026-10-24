/**
 * WorldCanvas — the mirror world as a React Three Fiber scene.
 *
 * R3F owns the WebGL renderer, the camera, resizing, and the frame loop;
 * the scene's pieces stay plain three.js classes (TerrainRenderer,
 * WaterRenderer, EntityLayer) that one `useFrame` drives. Mirror state
 * never goes through React state: it is read in the frame loop, and React
 * re-renders only when a prop changes (the HUD toggles). The HUD gets one
 * `onHud` call a second.
 *
 * PostFx draws the screen effects (bloom, antialiasing, underwater); the
 * frame loop tells it how far the camera is under water.
 *
 * Quality (quality.ts): the GPU is classified once the renderer exists,
 * and its preset sets the resolution range, the screen effects, the
 * particle budget, outlines and the sky. A frame-rate governor (drei's
 * PerformanceMonitor) lowers the resolution, then the preset, when frames
 * drop, and raises them back when there's headroom; a preset the player
 * pins keeps its effects and only the resolution moves.
 *
 * The ground is TerrainRenderer's: the streamed chunks near the player,
 * and the whole world far away from the welcome's coarse map, so
 * mountains stand on the horizon kilometres off; WaterRenderer lays the
 * sea and lakes over it. DaySky draws the sky and sets the sun, the sky
 * light and the haze (the scene fog, which fades distance into the sky)
 * for the world's time of day, derived from the server tick and the
 * welcome's day clock, so every client sees the same hour.
 */

import type { Listener } from "../audio/sound-logic.js";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { Effect } from "postprocessing";
import { PerformanceMonitor } from "@react-three/drei";
import { decodeWorldMap, formatTimeOfDay, LocomotionMode, timeOfDayAt, type DungeonLook, type WorldMap } from "@mmo-engine/protocol";
import type { MirrorClient } from "@mmo-engine/mirror";
import type { PcgRpcClient } from "@mmo-engine/picg";
import { InputState, bindInput } from "../input/input.js";
import { ResourceNodes } from "./resource-nodes.js";
import { DropLabels } from "./drop-labels.js";
import { NpcMarkers } from "./npc-markers.js";
import { DungeonEntrances } from "./dungeon-entrances.js";
import { DungeonAmbience } from "./dungeon-look.js";
import type { Bindings } from "../input/bindings.js";
import type { AssetProvider } from "./assets.js";
import { EntityLayer } from "./entity-layer.js";
import type { CombatFeedback } from "./combat-feedback.js";
import { clampCamDistance, DEFAULT_CAM_DISTANCE, followCamera } from "./follow-camera.js";
import { EYE_HEIGHT, firstPersonCamera } from "./first-person-camera.js";
import { underwaterAmount } from "./effects/underwater-effect.js";
import { detectGpu, type GpuInfo } from "./gpu.js";
import { PostFx, type ScreenState } from "./post-fx.js";
import { installBvh } from "./bvh.js";
import { detectQuality, QUALITY_PRESETS, stepTier, type QualitySettings, type QualityTier } from "./quality.js";
import { DaySky } from "./sky/day-sky.js";
import type { PhysicalSky } from "./sky/physical-sky.js";
import { ParticleFx, budgetMultiplierForTier } from "./fx/particle-fx.js";
import { biomeAt } from "./fx/weather.js";
import { FieldService, type ClimateParams } from "./weather/field-service.js";
import { overcastFromSample, type OvercastParams } from "./weather/sky-overcast.js";
import { CloudVolume } from "./weather/cloud-volume.js";
import { RainCurtain } from "./weather/rain-curtain.js";
import { WeatherFeel } from "./weather/weather-feel.js";
import type { AudioEngine } from "../audio/engine.js";
import { Footsteps, footstepEvent, footstepStride } from "../audio/footsteps.js";
import { gameContent } from "./game-content.js";
import { updateTerrainFx } from "./terrain-fx.js";
import { TerrainRenderer } from "./terrain/terrain-renderer.js";
import { StreamingCoordinator } from "./terrain/streaming-coordinator.js";
import { WorkerPool } from "../workers/pool.js";
import { loadSurfaces, type Surfaces } from "./terrain/surfaces.js";
import { WaterRenderer } from "./water.js";
import { PerfSampler, type PerfSample } from "./perf-stats.js";

/** Haze colour before the first frame sets it from the time of day. */
const SKY = 0x9fc0dc;
/** Time of day on servers without a day cycle: late morning. */
const FIXED_TIME = 0.42;
/** Haze: clear to FOG_NEAR metres, gone into the sky by FOG_FAR. */
const FOG_NEAR = 200;
const FOG_FAR = 3200;
/** Camera range: the far plane sits just past the haze. */
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = FOG_FAR + 800;

const splashAt = new THREE.Vector3();
/** Scratch overcast params (no per-frame allocation). */
const overcastScratch: OvercastParams = { coverage: 0, sunDim: 1, fogPull: 1, skyDarken: 1 };
/** Scratch weather object for ParticleFx.update (no per-frame allocation). */
const weatherScratch = { kind: null as "rain" | "snow" | "ash" | null, intensity: 0, windX: 0, windZ: 0 };
/** Grey colour the fog lerps toward under overcast. */
const OVERCAST_GREY = new THREE.Color(0.45, 0.45, 0.5);

/** Once-a-second numbers for the HUD. */
export interface HudData {
  tick: number;
  entities: number;
  fps: number;
  px: number;
  py: number;
  pz: number;
  /** Movement mode (LocomotionMode) and breath (0..1), when the server sends them. */
  mode: number | null;
  breath: number;
  /** World time of day as HH:MM (null: the server runs no day cycle). */
  time: string | null;
  /** What is falling where the camera is (null: clear). */
  weather: string | null;
  /** The player's own HP from the mirror's Health rows (null: no row yet). */
  hp: number | null;
  maxHp: number | null;
  /** The player's own stamina from the mirror's Stamina rows (null: no row yet). */
  sp: number | null;
  maxSp: number | null;
  /** The last minute of performance samples, oldest first (perf-stats.ts). */
  perf: PerfSample[];
}

const earDir = new THREE.Vector3();

export interface WorldCanvasProps {
  /** A joined mirror client (welcome received). */
  client: MirrorClient;
  /** Cross-region view (IM8): read-only mirrors of neighbouring regions, drawn beside the client's own. */
  observers?: () => Iterable<MirrorClient>;
  assets: AssetProvider;
  /** The region's Pcg service: props whose AssetRef is a PCG asset show its cooked mesh. */
  pcg?: PcgRpcClient;
  /** performance.now() of the last snapshot or delta (interpolation alpha). */
  lastStateAt: () => number;
  wireframe: boolean;
  /** Keep the last frame readable so a screenshot of the canvas is not blank (set at creation; costs a little fill rate). */
  captureFrames?: boolean;
  showcase: boolean;
  /** Remappable keyboard bindings (input.ts reads them live). */
  bindings: Bindings;
  /** "auto": the preset for this GPU, stepped down (and back up) by the frame-rate governor; else a pinned preset. */
  quality: "auto" | QualityTier;
  onGpu?: (gpu: GpuInfo) => void;
  /** The preset running now, and the one detected for the GPU (null until known). */
  onQuality?: (active: QualityTier, detected: QualityTier | null) => void;
  onHud?: (hud: HudData) => void;
  /** Written every frame with where the camera hears from (audio panning and distance, EA24). */
  listener?: Listener;
  /** A footstep fell: the audio event for the surface under the feet (content/materials) and where. Absent: silent. */
  onFootstep?: (event: string, at: { x: number; y: number; z: number }) => void;
  /** The bag key was pressed (M3a). */
  onBag?: () => void;
  /** The technique or aim key (M3): turn to the next one. */
  onStance?: (which: "technique" | "aim") => void;
  /** H (M4): treat your own worst wound. */
  onTreat?: () => void;
  /** G: cast Mend on yourself. */
  onMend?: () => void;
  /** The ground item in pickup range changed (null: none in range). */
  onNearDrop?: (drop: NearDrop | null) => void;
  /** The resource node in gathering range changed (its wire id; null: none in range). */
  onNearResource?: (node: bigint | null) => void;
  /** The quest log key (P1/U11). */
  onQuests?: () => void;
  /** The npc in talk range changed (an npc id; null: none in range). */
  onNearNpc?: (npc: string | null) => void;
  /** Inside a dungeon instance (D4): a stand-in floor under the shell, and the run's look applies. Read on mount. */
  instance?: boolean;
  /** The run's look (the server's `look`, sent on entering; null: none yet): dark fantasy lighting and matte stone. Read each frame. */
  getLook?: () => DungeonLook | null;
  /** The dungeon entrance the player stands in changed (an entrance id; null: none). */
  onNearEntrance?: (entrance: string | null) => void;
  /** Hit feedback (U12a): the mirror's combat events write it, the frame loop reads it. */
  combat?: CombatFeedback;
  /** Camera view: "third" (follow) or "first" (eye-level). Uncontrolled by default (V toggles). */
  view?: "third" | "first";
  /** Fires when the view changes (V key or the controlled prop). */
  onViewChange?: (view: "third" | "first") => void;
  /** The player's health or the target changed (called on change, not every frame). */
  onCombat?: (view: CombatView) => void;
  /** Optional ref to receive the streaming coordinator for region-change notifications. */
  streamingRef?: React.MutableRefObject<{ onRegionChange: (endpoint: string) => void } | null>;
  /** The audio engine for weather sound (rain bed). */
  audio?: AudioEngine | null;
}

/** The player's health and the target, as the frames show them (U12a). */
export interface CombatView {
  hp: number | null;
  maxHp: number | null;
  target: { entity: bigint; name: string; hp: number; maxHp: number } | null;
}

/** The ground item the pick-up key would take (M3a). */
export interface NearDrop {
  entity: bigint;
  name: string;
  color: string;
}

/** How near a drop must be for the prompt: a little inside the server's range (rules loot.pickupRange, 2.5 m). */
const PICKUP_PROMPT_RANGE = 2.3;
/** How near a resource node's edge must be for the prompt: inside the server's reach (2.5 m). */
const GATHER_PROMPT_RANGE = 2.3;

installBvh();

export function WorldCanvas(props: WorldCanvasProps): React.ReactElement {
  const { onGpu, onQuality, quality } = props;
  const screen = useRef<ScreenState>({ underwater: 0 });
  const physicalSky = useRef<PhysicalSky | null>(null);
  const [skyEffects, setSkyEffects] = useState<Effect[]>([]);
  // The GPU's preset (null until detected), the preset running, and the resolution.
  const [detected, setDetected] = useState<QualityTier | null>(null);
  const cap: QualityTier = quality === "auto" ? (detected ?? "medium") : quality;
  const [active, setActive] = useState<QualityTier>(cap);
  const settings = QUALITY_PRESETS[active];
  const [dpr, setDpr] = useState(settings.dpr[1]);
  useEffect(() => {
    setActive(cap);
  }, [cap]);
  useEffect(() => {
    setDpr(QUALITY_PRESETS[active].dpr[1]);
  }, [active]);
  useEffect(() => {
    onQuality?.(active, detected);
  }, [active, detected, onQuality]);

  const decline = (): void => {
    const [lo] = QUALITY_PRESETS[active].dpr;
    if (dpr > lo + 1e-3) setDpr(Math.max(lo, dpr - 0.25));
    else if (quality === "auto") setActive((t) => stepTier(t, -1) ?? t);
  };
  const incline = (): void => {
    const [, hi] = QUALITY_PRESETS[active].dpr;
    if (dpr < hi - 1e-3) setDpr(Math.min(hi, dpr + 0.25));
    else if (quality === "auto") setActive((t) => stepTier(t, 1, cap) ?? t);
  };

  return (
    <Canvas
      className="block h-full w-full"
      // Plain three.js colour output (no tone mapping), as before R3F.
      flat
      dpr={dpr}
      gl={{ antialias: true, preserveDrawingBuffer: props.captureFrames === true }}
      camera={{ fov: 60, near: CAMERA_NEAR, far: CAMERA_FAR }}
      onCreated={({ gl }) => {
        const gpu = detectGpu(gl);
        onGpu?.(gpu);
        void detectQuality(gl, gpu.software).then((r) => setDetected(r.tier));
      }}
    >
      {/* Settles after flipping between better and worse a few times: then the current setting stays. */}
      <PerformanceMonitor onDecline={decline} onIncline={incline} flipflops={4} />
      <fog attach="fog" args={[SKY, FOG_NEAR, FOG_FAR]} />
      <PhysicalSkyHost settings={settings} skyRef={physicalSky} onEffects={setSkyEffects} />
      <MirrorWorld {...props} quality={quality} settings={settings} screen={screen} physicalSky={physicalSky} />
      <PostFx quality={settings} screen={screen}>
        {skyEffects.map((e) => (
          <primitive key={e.name} object={e} />
        ))}
      </PostFx>
    </Canvas>
  );
}

/**
 * The physical sky (quality "physical"): created with the renderer and
 * camera, its dome added to the scene, its effects handed to PostFx.
 * Loaded on demand: the low and medium presets never download it.
 */
function PhysicalSkyHost({
  settings,
  skyRef,
  onEffects,
}: {
  settings: QualitySettings;
  skyRef: { current: PhysicalSky | null };
  onEffects: (effects: Effect[]) => void;
}): null {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const on = settings.sky === "physical" && settings.effects;
  useEffect(() => {
    if (!on) return;
    let sky: PhysicalSky | null = null;
    let closed = false;
    import("./sky/physical-sky.js")
      .then(({ PhysicalSky }) => {
        if (closed) return;
        sky = new PhysicalSky(gl, camera);
        scene.add(sky.dome);
        skyRef.current = sky;
        onEffects([...sky.effects]);
      })
      .catch((e: unknown) => console.warn(`[sky] physical sky unavailable: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      closed = true;
      skyRef.current = null;
      onEffects([]);
      sky?.dispose();
    };
  }, [on, gl, camera, scene, skyRef, onEffects]);
  return null;
}

interface Runtime {
  /** IM8: one entity layer per neighbouring region's observer mirror. */
  observerLayers: Map<MirrorClient, EntityLayer>;
  sky: DaySky;
  particles: ParticleFx;
  map: WorldMap | null;
  terrain: TerrainRenderer;
  water: WaterRenderer;
  layer: EntityLayer;
  input: InputState;
  drops: DropLabels;
  resources: ResourceNodes;
  npcs: NpcMarkers;
  entrances: DungeonEntrances;
  streaming: StreamingCoordinator;
  weather: FieldService;
  clouds: CloudVolume;
  rain: RainCurtain;
  weatherFeel: WeatherFeel;
  /** Inside a dungeon run: its look (lights, fog, matte stone). */
  ambience: DungeonAmbience | null;
}

/** The world's content and frame loop (inside the Canvas). */
function MirrorWorld({
  client,
  observers,
  assets,
  pcg,
  lastStateAt,
  wireframe,
  showcase,
  bindings,
  onHud,
  listener,
  onFootstep,
  onBag,
  onStance,
  onTreat,
  onMend,
  onNearDrop,
  onNearResource,
  onQuests,
  onNearNpc,
  onNearEntrance,
  instance,
  getLook,
  combat,
  onCombat,
  view: viewProp,
  onViewChange,
  settings,
  screen,
  physicalSky,
  streamingRef,
  audio,
}: WorldCanvasProps & { settings: QualitySettings; screen: { current: ScreenState }; physicalSky: { current: PhysicalSky | null } }): null {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const rt = useRef<Runtime | null>(null);
  // Latest props for the effects and the frame loop, without re-creating the world.
  const latest = useRef({ observers, listener, onFootstep, wireframe, showcase, onHud, onBag, onStance, onTreat, onMend, onNearDrop, onNearResource, onQuests, onNearNpc, onNearEntrance, combat, onCombat, lastStateAt, settings });
  latest.current = { observers, listener, onFootstep, wireframe, showcase, onHud, onBag, onStance, onTreat, onMend, onNearDrop, onNearResource, onQuests, onNearNpc, onNearEntrance, combat, onCombat, lastStateAt, settings };
  const footsteps = useRef(new Footsteps());
  const camDistance = useRef(DEFAULT_CAM_DISTANCE);
  // Camera view: third-person follow or first-person. Controlled by the
  // `view` prop when given; otherwise the V key toggles it internally.
  const [viewState, setViewState] = useState<"third" | "first">("third");
  const view = viewProp ?? viewState;
  const viewRef = useRef(view);
  viewRef.current = view;
  // Last values sent: nearDrop, and the combat view's numbers (onCombat fires only when one moves).
  const loop = useRef({
    pointerMoved: false,
    nearDrop: null as bigint | null,
    nearResource: null as bigint | null,
    nearNpc: null as string | null,
    nearEntrance: null as string | null,
    hp: NaN,
    maxHp: NaN,
    target: null as bigint | null,
    targetHp: NaN,
    targetMax: NaN,
    targetName: "",
  });
  const perf = useRef(new PerfSampler(performance.now()));
  const pointer = useRef(new THREE.Vector2());
  // Scratch eye position for first-person mode (no per-frame allocation).
  const eyePos = useRef(new THREE.Vector3());
  // Nearest hit only: with BVHs (bvh.ts) a ray stops at its first triangle.
  const raycaster = useRef(Object.assign(new THREE.Raycaster(), { firstHitOnly: true }));
  // For CombatFeedback.prune, made once per client rather than every frame.
  const hasEntity = useCallback((wid: bigint) => client.state.entities.has(wid), [client]);
  // Chunk world size for streaming (updated when world loads).
  const chunkWorldSizeRef = useRef(client.world?.chunkWorldSize ?? 16);

  // Create the world's renderers and bind input; the same effect disposes
  // them, so StrictMode's mount/unmount/mount never sees a disposed one.
  useEffect(() => {
    const sky = new DaySky();
    const particles = new ParticleFx(camera);
    // Terrain blocks, PCG meshes and BVHs build in workers (src/workers); without Worker (tests, SSR) they build inline.
    const workers =
      typeof Worker === "undefined"
        ? undefined
        : new WorkerPool(
            () => new Worker(new URL("../workers/index.ts", import.meta.url), { type: "module" }) as never,
            Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1)),
          );
    const terrain = new TerrainRenderer(client.world?.chunkWorldSize ?? 16, workers);
    // The water reflects this sky (same uniform objects).
    const water = new WaterRenderer(sky.uniforms);
    // A dungeon run's look: hides what a run has no use for, and colours the shell's material slots (matte stone).
    const ambience = instance ? new DungeonAmbience(scene) : null;
    const layer = new EntityLayer(scene, camera, assets, terrain, { pcg, workers, ...(ambience ? { materialFor: ambience.materialFor } : {}) });
    if (ambience) layer.matte();
    const world = client.world;
    const map = world ? decodeWorldMap(world.map) : null;
    terrain.setWorld(world && map ? { map, bounds: world.bounds, seaLevel: world.seaLevel ?? null } : null);
    water.setWorld(map, world?.seaLevel ?? null);
    terrain.setWireframe(latest.current.wireframe);
    water.setWireframe(latest.current.wireframe);
    const drops = new DropLabels();
    const resources = new ResourceNodes();
    const npcs = new NpcMarkers();
    const entrances = new DungeonEntrances();
    // Weather: the field service (worker-advanced), cloud volumes, and rain curtain.
    const weatherMap = map ?? { cell: 8, width: 1, depth: 1, originX: 0, originZ: 0, heights: new Float32Array([0]), biome: new Uint8Array([0]), biomes: ["plains"], river: new Uint8Array([0]) };
    // The server sends a `climate` block in the welcome's WorldInfo; fall back to defaults.
    const worldClimate = (world as { climate?: ClimateParams } | undefined)?.climate ?? null;
    const weather = new FieldService(weatherMap, workers ?? null, 1234, worldClimate);
    const clouds = new CloudVolume(10);
    const rain = new RainCurtain();
    const weatherFeel = new WeatherFeel();
    weatherFeel.setAudio(audio ?? null);
    scene.add(sky.group, terrain.group, water.group, layer.group, particles.group, drops.group, npcs.group, entrances.group, clouds.group, rain.mesh);
    ambience?.hideWhileLit(sky.group, water.group, clouds.group, rain.mesh);
    // A dungeon instance (D4) has no terrain: a stand-in stone floor just under y = 0, where the
    // server keeps bodies, so the run isn't drawn in a void. The dungeon's own shell (walls,
    // floors, ceilings) arrives as an ordinary asset entity and draws over it.
    const floor = instance ? makeFloor() : null;
    if (floor) scene.add(floor);

    // Draw calls and triangles summed over every pass of a frame (the screen
    // effects render several); the frame loop reads and resets them.
    gl.info.autoReset = false;

    const canvas = gl.domElement;
    const input = new InputState();
    const unbind = bindInput(canvas, input, {
      // Interface keys (M3a): pick up the drop in range (else talk to the npc in range, else ask at the dungeon entrance), open the bag.
      onAction: (action) => {
        if (action === "bag") latest.current.onBag?.();
        else if (action === "technique" || action === "aim") latest.current.onStance?.(action);
        else if (action === "treat") latest.current.onTreat?.();
        else if (action === "mend") latest.current.onMend?.();
        else if (action === "quests") latest.current.onQuests?.();
        else if (drops.nearest !== null) client.pickup(drops.nearest);
        else if (resources.nearest !== null) client.gather(resources.nearest);
        else if (npcs.nearest !== null) client.quest({ kind: "quest", op: "talk", npc: npcs.nearest });
        else if (entrances.nearest !== null) client.dungeon({ kind: "dungeon", op: "enter", entrance: entrances.nearest });
      },
    });
    // Chunk streaming: request tiles around the camera from the region server.
    chunkWorldSizeRef.current = client.world?.chunkWorldSize ?? 16;
    const streaming = new StreamingCoordinator(terrain, { radius: 6, handoffMargin: 2 });
    streaming.attachClient(client);
    // Expose streaming coordinator for region-change notifications from App.
    if (streamingRef) streamingRef.current = streaming;
    // Register the initial world as a region. The welcome includes bounds and endpoint.
    if (world) {
      // Use the URL the client connected to (stored in the client's socket URL).
      const endpoint = (client as unknown as { socket?: { url?: string } }).socket?.url ?? "ws://localhost:7777";
      streaming.addRegion("main", world.bounds, endpoint);
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      camDistance.current = clampCamDistance(camDistance.current + e.deltaY * 0.01);
    };
    const onPointerMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      pointer.current.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      loop.current.pointerMoved = true;
    };
    // A left click on another body makes it the target (U12a).
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const h = layer.hovered;
      if (h !== null && h !== client.playerEntity) latest.current.combat?.select(h);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("mousedown", onMouseDown);

    // Textured ground, when the surfaces were fetched (npm run surfaces:fetch); flat colours until then.
    let surfaces: Surfaces | null = null;
    let closed = false;
    loadSurfaces()
      .then((s) => {
        if (closed) s?.dispose();
        else if (s) {
          surfaces = s;
          terrain.setSurfaces(s);
        }
      })
      .catch((e: unknown) => console.warn(`[client] terrain surfaces: ${e instanceof Error ? e.message : String(e)}`));

    const observerLayers = new Map<MirrorClient, EntityLayer>();
    rt.current = { observerLayers, sky, particles, map, terrain, water, layer, input, drops, resources, npcs, entrances, streaming, weather, clouds, rain, weatherFeel, ambience };
    particles.setBudget(budgetMultiplierForTier(latest.current.settings.tier));
    layer.setQuality(latest.current.settings);
    // Dev builds: a handle for probes (layer stats, scenery, input, client).
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      (window as unknown as { __mmoDebug?: unknown }).__mmoDebug = { layer, input, client };
    }
    if (latest.current.showcase) layer.setShowcaseVisible(true, camera.position);
    return () => {
      const streaming = rt.current?.streaming;
      rt.current = null;
      unbind();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      scene.remove(terrain.group, water.group);
      closed = true;
      terrain.setSurfaces(null);
      surfaces?.dispose();
      sky.dispose();
      particles.dispose();
      layer.dispose();
      for (const ol of observerLayers.values()) ol.dispose();
      scene.remove(drops.group, npcs.group, entrances.group);
      if (floor) {
        scene.remove(floor);
        floor.traverse((o) => {
          if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
      }
      drops.dispose();
      npcs.dispose();
      entrances.dispose();
      streaming?.streamManager.dispose();
      terrain.dispose();
      workers?.dispose();
      water.dispose();
      clouds.dispose();
      rain.dispose();
      ambience?.dispose();
    };
  }, [client, assets, pcg, scene, camera, gl]);

  useEffect(() => {
    rt.current?.particles.setBudget(budgetMultiplierForTier(settings.tier));
    rt.current?.layer.setQuality(settings);
  }, [settings]);

  useEffect(() => {
    rt.current?.terrain.setWireframe(wireframe);
    rt.current?.water.setWireframe(wireframe);
  }, [wireframe]);

  useEffect(() => {
    rt.current?.input.setBindings(bindings);
  }, [bindings]);

  // V toggles first/third person (uncontrolled mode only; a controlled
  // `view` prop owns the state instead).
  useEffect(() => {
    if (viewProp !== undefined) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "KeyV" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      setViewState((v) => {
        const next = v === "third" ? "first" : "third";
        onViewChange?.(next);
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewProp, onViewChange]);

  useEffect(() => {
    rt.current?.layer.setShowcaseVisible(showcase, camera.position);
  }, [showcase, camera]);

  useFrame((state, delta) => {
    const r = rt.current;
    if (!r) return;
    const now = performance.now();
    const l = loop.current;
    const ear = latest.current.listener;
    if (ear) {
      const dir = camera.getWorldDirection(earDir);
      const h = Math.hypot(dir.x, dir.z) || 1;
      ear.x = camera.position.x;
      ear.y = camera.position.y;
      ear.z = camera.position.z;
      ear.fx = dir.x / h;
      ear.fz = dir.z / h;
    }
    // What the last frame drew (every pass), before this one starts counting.
    perf.current.frame(delta * 1000, gl.info.render.calls, gl.info.render.triangles);
    gl.info.reset();
    if (r.input.consumeDirty()) client.sendIntent(r.input.toIntent());

    const tickInterval = 1000 / (client.tickHz || 30);
    const alpha = Math.max(0, Math.min(1, (now - latest.current.lastStateAt()) / tickInterval));
    const combat = latest.current.combat;
    if (combat) {
      combat.prune(hasEntity, now / 1000);
      r.layer.setFlashes(combat.flashUntil);
    }
    // Resource nodes: which one the interact key would gather from, and the worked-out ones drawn low.
    r.resources.sync(client.state, client.resources, r.layer.player, GATHER_PROMPT_RANGE);
    r.layer.setDepleted(r.resources.depleted);
    if (r.resources.nearest !== l.nearResource) {
      l.nearResource = r.resources.nearest;
      latest.current.onNearResource?.(l.nearResource);
    }
    r.layer.sync(client.state, client.interpolator, alpha, client.playerEntity, {
      tick: client.serverTick,
      tickHz: client.tickHz || 30,
    }, client.names);
    // Neighbouring regions near the border (IM8): each in its own layer, so their wire ids never mix
    // with this region's; their terrain chunks go to a renderer that is never drawn (ours covers it).
    const seen = new Set<MirrorClient>();
    for (const o of latest.current.observers?.() ?? []) {
      seen.add(o);
      let ol = r.observerLayers.get(o);
      if (!ol) r.observerLayers.set(o, (ol = new EntityLayer(scene, camera, assets, new TerrainRenderer(16), pcg ? { pcg } : {})));
      ol.sync(o.state, o.interpolator, alpha, null, { tick: o.serverTick, tickHz: o.tickHz || 30 }, o.names);
    }
    for (const [o, ol] of r.observerLayers) {
      if (seen.has(o)) continue;
      ol.dispose();
      r.observerLayers.delete(o);
    }
    // Ground items: names, beams, and which one the pick-up key would take.
    r.drops.sync(client.state, client.drops, camera, r.layer.player, PICKUP_PROMPT_RANGE);
    if (r.drops.nearest !== l.nearDrop) {
      l.nearDrop = r.drops.nearest;
      const info = l.nearDrop === null ? undefined : client.drops.get(l.nearDrop);
      latest.current.onNearDrop?.(l.nearDrop !== null && info ? { entity: l.nearDrop, name: info.name, color: info.color } : null);
    }
    // Quest givers: figures, markers, and which one the interact key would talk to.
    r.npcs.sync(client.npcs, (x, z) => r.terrain.heightAt(x, z), camera, r.layer.player, now);
    if (r.npcs.nearest !== l.nearNpc) {
      l.nearNpc = r.npcs.nearest;
      latest.current.onNearNpc?.(l.nearNpc);
    }
    // Dungeon entrances: rings, gates, and which one the interact key would ask at.
    r.entrances.sync(client.entrances, (x, z) => r.terrain.heightAt(x, z), camera, r.layer.player, now);
    if (r.entrances.nearest !== l.nearEntrance) {
      l.nearEntrance = r.entrances.nearest;
      latest.current.onNearEntrance?.(l.nearEntrance);
    }
    // The player and target frames, told only when a number moves (hits land between HUD samples).
    if (combat && latest.current.onCombat) {
      const mine = client.playerEntity !== null ? client.state.get(client.playerEntity)?.health : undefined;
      const t = combat.target;
      const theirs = t !== null ? client.state.get(t)?.health : undefined;
      const hp = mine?.current ?? NaN;
      const maxHp = mine?.max ?? NaN;
      const tHp = theirs?.current ?? NaN;
      const tMax = theirs?.max ?? NaN;
      const tName = t !== null ? (client.names.get(t) ?? "") : "";
      if (
        !Object.is(hp, l.hp) || !Object.is(maxHp, l.maxHp) || t !== l.target ||
        !Object.is(tHp, l.targetHp) || !Object.is(tMax, l.targetMax) || tName !== l.targetName
      ) {
        l.hp = hp;
        l.maxHp = maxHp;
        l.target = t;
        l.targetHp = tHp;
        l.targetMax = tMax;
        l.targetName = tName;
        latest.current.onCombat({
          hp: mine ? hp : null,
          maxHp: mine ? maxHp : null,
          target: t !== null && theirs ? { entity: t, name: tName, hp: tHp, maxHp: tMax } : null,
        });
      }
    }
    if (l.pointerMoved) {
      l.pointerMoved = false;
      raycaster.current.setFromCamera(pointer.current, camera);
      r.layer.hover(raycaster.current);
    }
    if (viewRef.current === "first" && r.layer.player) {
      // First person: camera at the avatar's eye, own avatar hidden.
      r.layer.setPlayerHidden(true);
      eyePos.current.copy(r.layer.player);
      eyePos.current.y += EYE_HEIGHT;
      firstPersonCamera(camera, eyePos.current, r.input.lookYaw, r.input.lookPitch);
    } else {
      r.layer.setPlayerHidden(false);
      followCamera(camera, r.layer.player, r.input.lookYaw, r.input.lookPitch, camDistance.current);
    }
    // Chunk streaming: track camera position and velocity for demand + handoff prediction.
    const me = client.playerEntity !== null ? client.state.get(client.playerEntity) : undefined;
    if (r.layer.player && me) {
      const playerVel = me.velocity ?? { lx: 0, ly: 0, lz: 0 };
      r.streaming.trackPlayer(camera.position.x, camera.position.z, playerVel.lx, playerVel.lz, chunkWorldSizeRef.current);
    }
    const surface = r.water.surfaceAt(camera.position.x, camera.position.z);
    screen.current.underwater = surface === null ? 0 : underwaterAmount(surface - camera.position.y);

    const timeOfDay = client.day ? timeOfDayAt(client.day, client.serverTick, client.tickHz || 30) : FIXED_TIME;
    const fog = scene.fog instanceof THREE.Fog ? scene.fog : null;
    r.sky.update(timeOfDay, fog);
    // The physical sky, once its tables are ready, draws the sky and the haze (aerial perspective) instead.
    const physical = physicalSky.current?.ready ? physicalSky.current : null;
    r.sky.setDomeVisible(!physical);
    physical?.setSun(r.sky.sunDir);
    if (fog) {
      // Always use the configured fog range for culling; physical sky adds
      // aerial perspective visually but we still need fog to limit far draws.
      fog.near = FOG_NEAR;
      fog.far = FOG_FAR;
    }
    r.sky.stars.setFrame(state.size.width, state.size.height, state.viewport.dpr, state.clock.elapsedTime);

    const seconds = now / 1000;
    // Weather from the field service (worker-advanced simulation).
    r.weather.setOverride(client.weatherOverride === "auto" ? null : client.weatherOverride);
    const wxSample = r.weather.sample(camera.position.x, camera.position.z);
    // Overcast blend from the weather sample.
    const overcast = overcastFromSample(wxSample, overcastScratch);
    if (fog) {
      fog.near = FOG_NEAR * overcast.fogPull;
      fog.far = FOG_FAR * overcast.fogPull;
      fog.color.lerp(OVERCAST_GREY, overcast.coverage * 0.5);
    }
    // Dim the sun and sky lights under overcast.
    r.sky.sunLight.intensity *= overcast.sunDim;
    r.sky.skyLight.intensity *= overcast.skyDarken;
    // Cloud volumes follow the camera, driven by the field's moisture.
    const moisture = r.weather.moistureAt(camera.position.x, camera.position.z);
    r.clouds.update(camera.position, moisture, overcast.coverage, wxSample.windX, wxSample.windZ, delta, camera.quaternion);
    // Rain curtain: visible only when raining.
    const rainIntensity = wxSample.kind === "rain" ? wxSample.intensity : 0;
    r.rain.update(seconds, wxSample.windX, wxSample.windZ, rainIntensity, camera.position);
    // A dungeon run's look wins over the sky: hidden sky and weather, near-black fog, torchlight on the nearest torches.
    if (r.ambience) {
      r.ambience.apply(getLook?.() ?? null);
      r.ambience.update(camera.position, r.layer.emitterPositions(r.ambience.emitterHashes), seconds);
    }
    // WX1 couplings: wet look, water ripples, and rain audio.
    r.weatherFeel.update(wxSample, delta, r.water, r.terrain);
    // Splashes where the player swims and moves.
    const swimming = me?.locomotion?.mode === LocomotionMode.Swim;
    const v = me?.velocity;
    if (swimming && r.layer.player && v && Math.hypot(v.lx, v.lz) > 0.5) {
      const surface = r.water.surfaceAt(r.layer.player.x, r.layer.player.z);
      if (surface !== null) r.particles.splash(splashAt.set(r.layer.player.x, surface, r.layer.player.z));
    }
    // Pass the weather (with wind vector) to the particle system.
    weatherScratch.kind = wxSample.kind === "clear" ? null : wxSample.kind;
    weatherScratch.intensity = wxSample.intensity;
    weatherScratch.windX = wxSample.windX;
    weatherScratch.windZ = wxSample.windZ;
    r.particles.update(Math.min(delta, 0.25), camera.position, weatherScratch);

    // A step sounds each stride on the ground, on the surface of the biome underfoot (content/materials).
    const onStep = latest.current.onFootstep;
    if (onStep && me?.transform) {
      const grounded = me.locomotion?.mode === LocomotionMode.Ground && Math.abs(v?.ly ?? 0) < 1.5;
      const materials = gameContent().materials;
      if (footsteps.current.step(delta, v ? Math.hypot(v.lx, v.lz) : 0, grounded, footstepStride(materials))) {
        const under = r.map ? biomeAt(r.map, me.transform.px, me.transform.pz) : null;
        onStep(footstepEvent(under, materials), { x: me.transform.px, y: me.transform.py, z: me.transform.pz });
      }
    }

    r.terrain.update(camera.position);
    r.water.update(seconds);
    updateTerrainFx(seconds);

    if (perf.current.due(now)) {
      const props = r.layer.stats;
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const sample = perf.current.sample(
        now,
        {
          geometries: gl.info.memory.geometries,
          textures: gl.info.memory.textures,
          programs: gl.info.programs?.length ?? 0,
          props: props.props,
          propDrawCalls: props.propDrawCalls,
          propTriangles: props.propTriangles,
          propFullTriangles: props.propFullTriangles,
          propsPerLevel: props.propsPerLevel,
          entities: client.state.entityCount,
          chunks: r.terrain.chunkCount,
          heapBytes: heap?.usedJSHeapSize ?? null,
        },
        client.traffic,
      );
      const p = me?.transform;
      latest.current.onHud?.({
        tick: client.serverTick,
        entities: client.state.entityCount,
        fps: Math.round(sample.fps),
        px: p?.px ?? 0,
        py: p?.py ?? 0,
        pz: p?.pz ?? 0,
        mode: me?.locomotion?.mode ?? null,
        breath: me?.locomotion?.breath ?? 1,
        time: client.day ? formatTimeOfDay(timeOfDay) : null,
        weather: wxSample.intensity > 0 ? wxSample.kind : null,
        hp: me?.health?.current ?? null,
        maxHp: me?.health?.max ?? null,
        sp: me?.stamina?.current ?? null,
        maxSp: me?.stamina?.max ?? null,
        perf: perf.current.history(),
      });
    }
  });

  return null;
}

/** A stand-in dungeon floor: dark flagstones with a faint grid, 400 m across, 6 cm under the shell's own floor (no z-fighting). */
function makeFloor(): THREE.Group {
  const g = new THREE.Group();
  g.name = "instance-floor";
  g.position.y = -0.06;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 1 }));
  plane.rotation.x = -Math.PI / 2;
  const grid = new THREE.GridHelper(400, 200, 0x4a4038, 0x3a332c);
  grid.position.y = 0.01;
  g.add(plane, grid);
  return g;
}
