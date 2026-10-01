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

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { Effect } from "postprocessing";
import { PerformanceMonitor } from "@react-three/drei";
import { decodeWorldMap, formatTimeOfDay, LocomotionMode, timeOfDayAt, type WorldMap } from "@mmo-engine/protocol";
import type { MirrorClient } from "@mmo-engine/mirror";
import type { PcgRpcClient } from "@mmo-engine/picg";
import { InputState, bindInput } from "../input/input.js";
import type { Bindings } from "../input/bindings.js";
import type { AssetProvider } from "./assets.js";
import { EntityLayer } from "./entity-layer.js";
import { clampCamDistance, DEFAULT_CAM_DISTANCE, followCamera } from "./follow-camera.js";
import { underwaterAmount } from "./effects/underwater-effect.js";
import { detectGpu, type GpuInfo } from "./gpu.js";
import { PostFx, type ScreenState } from "./post-fx.js";
import { installBvh } from "./bvh.js";
import { detectQuality, QUALITY_PRESETS, stepTier, type QualitySettings, type QualityTier } from "./quality.js";
import { DaySky } from "./sky/day-sky.js";
import type { PhysicalSky } from "./sky/physical-sky.js";
import { ParticleFx, WEATHER_RULES } from "./fx/particle-fx.js";
import { biomeAt, weatherAt } from "./fx/weather.js";
import { updateTerrainFx } from "./terrain-fx.js";
import { TerrainRenderer } from "./terrain/terrain-renderer.js";
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

export interface WorldCanvasProps {
  /** A joined mirror client (welcome received). */
  client: MirrorClient;
  assets: AssetProvider;
  /** The region's Pcg service: props whose AssetRef is a PCG asset show its cooked mesh. */
  pcg?: PcgRpcClient;
  /** performance.now() of the last snapshot or delta (interpolation alpha). */
  lastStateAt: () => number;
  wireframe: boolean;
  showcase: boolean;
  /** Remappable keyboard bindings (input.ts reads them live). */
  bindings: Bindings;
  /** "auto": the preset for this GPU, stepped down (and back up) by the frame-rate governor; else a pinned preset. */
  quality: "auto" | QualityTier;
  onGpu?: (gpu: GpuInfo) => void;
  /** The preset running now, and the one detected for the GPU (null until known). */
  onQuality?: (active: QualityTier, detected: QualityTier | null) => void;
  onHud?: (hud: HudData) => void;
}

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
      gl={{ antialias: true }}
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
  sky: DaySky;
  particles: ParticleFx;
  map: WorldMap | null;
  terrain: TerrainRenderer;
  water: WaterRenderer;
  layer: EntityLayer;
  input: InputState;
}

/** The world's content and frame loop (inside the Canvas). */
function MirrorWorld({
  client,
  assets,
  pcg,
  lastStateAt,
  wireframe,
  showcase,
  bindings,
  onHud,
  settings,
  screen,
  physicalSky,
}: WorldCanvasProps & { settings: QualitySettings; screen: { current: ScreenState }; physicalSky: { current: PhysicalSky | null } }): null {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const rt = useRef<Runtime | null>(null);
  // Latest props for the effects and the frame loop, without re-creating the world.
  const latest = useRef({ wireframe, showcase, onHud, lastStateAt, settings });
  latest.current = { wireframe, showcase, onHud, lastStateAt, settings };
  const camDistance = useRef(DEFAULT_CAM_DISTANCE);
  const loop = useRef({ pointerMoved: false });
  const perf = useRef(new PerfSampler(performance.now()));
  const pointer = useRef(new THREE.Vector2());
  // Nearest hit only: with BVHs (bvh.ts) a ray stops at its first triangle.
  const raycaster = useRef(Object.assign(new THREE.Raycaster(), { firstHitOnly: true }));

  // Create the world's renderers and bind input; the same effect disposes
  // them, so StrictMode's mount/unmount/mount never sees a disposed one.
  useEffect(() => {
    const sky = new DaySky();
    const particles = new ParticleFx(camera);
    const terrain = new TerrainRenderer(client.world?.chunkWorldSize ?? 16);
    // The water reflects this sky (same uniform objects).
    const water = new WaterRenderer(sky.uniforms);
    const layer = new EntityLayer(scene, camera, assets, terrain, { pcg });
    const world = client.world;
    const map = world ? decodeWorldMap(world.map) : null;
    terrain.setWorld(world && map ? { map, bounds: world.bounds, seaLevel: world.seaLevel ?? null } : null);
    water.setWorld(map, world?.seaLevel ?? null);
    terrain.setWireframe(latest.current.wireframe);
    water.setWireframe(latest.current.wireframe);
    scene.add(sky.group, terrain.group, water.group, layer.group, particles.group);

    // Draw calls and triangles summed over every pass of a frame (the screen
    // effects render several); the frame loop reads and resets them.
    gl.info.autoReset = false;

    const canvas = gl.domElement;
    const input = new InputState();
    const unbind = bindInput(canvas, input);
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
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove);

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

    rt.current = { sky, particles, map, terrain, water, layer, input };
    particles.setBudget(latest.current.settings.particles);
    layer.setQuality(latest.current.settings);
    // Dev builds: a handle for probes (layer stats, scenery, input, client).
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      (window as unknown as { __mmoDebug?: unknown }).__mmoDebug = { layer, input, client };
    }
    if (latest.current.showcase) layer.setShowcaseVisible(true, camera.position);
    return () => {
      rt.current = null;
      unbind();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointermove", onPointerMove);
      scene.remove(terrain.group, water.group);
      closed = true;
      terrain.setSurfaces(null);
      surfaces?.dispose();
      sky.dispose();
      particles.dispose();
      layer.dispose();
      terrain.dispose();
      water.dispose();
    };
  }, [client, assets, pcg, scene, camera, gl]);

  useEffect(() => {
    rt.current?.particles.setBudget(settings.particles);
    rt.current?.layer.setQuality(settings);
  }, [settings]);

  useEffect(() => {
    rt.current?.terrain.setWireframe(wireframe);
    rt.current?.water.setWireframe(wireframe);
  }, [wireframe]);

  useEffect(() => {
    rt.current?.input.setBindings(bindings);
  }, [bindings]);

  useEffect(() => {
    rt.current?.layer.setShowcaseVisible(showcase, camera.position);
  }, [showcase, camera]);

  useFrame((state, delta) => {
    const r = rt.current;
    if (!r) return;
    const now = performance.now();
    const l = loop.current;
    // What the last frame drew (every pass), before this one starts counting.
    perf.current.frame(delta * 1000, gl.info.render.calls, gl.info.render.triangles);
    gl.info.reset();
    if (r.input.consumeDirty()) client.sendIntent(r.input.toIntent());

    const tickInterval = 1000 / (client.tickHz || 30);
    const alpha = Math.max(0, Math.min(1, (now - latest.current.lastStateAt()) / tickInterval));
    r.layer.sync(client.state, client.interpolator, alpha, client.playerEntity, {
      tick: client.serverTick,
      tickHz: client.tickHz || 30,
    }, client.names);
    if (l.pointerMoved) {
      l.pointerMoved = false;
      raycaster.current.setFromCamera(pointer.current, camera);
      r.layer.hover(raycaster.current);
    }
    followCamera(camera, r.layer.player, r.input.lookYaw, r.input.lookPitch, camDistance.current);
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
      fog.near = physical ? CAMERA_FAR * 10 : FOG_NEAR;
      fog.far = physical ? CAMERA_FAR * 20 : FOG_FAR;
    }
    r.sky.stars.setFrame(state.size.width, state.size.height, state.viewport.dpr, state.clock.elapsedTime);

    // Weather where the camera is, the same on every client (biome + tick).
    const tick = client.serverTick;
    const hz = client.tickHz || 30;
    const biome = r.map ? biomeAt(r.map, camera.position.x, camera.position.z) : null;
    const weather = weatherAt(WEATHER_RULES, biome, tick, hz);
    // Splashes where the player swims and moves.
    const me = client.playerEntity !== null ? client.state.get(client.playerEntity) : undefined;
    const swimming = me?.locomotion?.mode === LocomotionMode.Swim;
    const v = me?.velocity;
    if (swimming && r.layer.player && v && Math.hypot(v.lx, v.lz) > 0.5) {
      const surface = r.water.surfaceAt(r.layer.player.x, r.layer.player.z);
      if (surface !== null) r.particles.splash(splashAt.set(r.layer.player.x, surface, r.layer.player.z));
    }
    r.particles.update(Math.min(delta, 0.25), camera.position, weather);

    const seconds = now / 1000;
    r.terrain.update();
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
        weather: weather.intensity > 0 ? weather.kind : null,
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
