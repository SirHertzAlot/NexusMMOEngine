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
 * The ground is TerrainRenderer's: the streamed chunks near the player,
 * and the whole world far away from the welcome's coarse map, so
 * mountains stand on the horizon kilometres off; WaterRenderer lays the
 * sea and lakes over it. A daylight haze (the scene fog) fades distance
 * into the sky, which is what makes far things read as far.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { decodeWorldMap } from "@mmo-engine/protocol";
import type { MirrorClient } from "@mmo-engine/mirror";
import type { PcgRpcClient } from "@mmo-engine/picg";
import { InputState, bindInput } from "../input/input.js";
import type { AssetProvider } from "./assets.js";
import { EntityLayer } from "./entity-layer.js";
import { clampCamDistance, DEFAULT_CAM_DISTANCE, followCamera } from "./follow-camera.js";
import { detectGpu, type GpuInfo } from "./gpu.js";
import { updateTerrainFx } from "./terrain-fx.js";
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
  onGpu?: (gpu: GpuInfo) => void;
  onHud?: (hud: HudData) => void;
}

export function WorldCanvas(props: WorldCanvasProps): React.ReactElement {
  const { onGpu } = props;
  return (
    <Canvas
      className="block h-full w-full"
      // Plain three.js colour output (no tone mapping), as before R3F.
      flat
      dpr={[1, 2]}
      gl={{ antialias: true }}
      camera={{ fov: 60, near: CAMERA_NEAR, far: CAMERA_FAR }}
      onCreated={({ gl }) => onGpu?.(detectGpu(gl))}
    >
      <color attach="background" args={[SKY]} />
      <fog attach="fog" args={[SKY, FOG_NEAR, FOG_FAR]} />
      <hemisphereLight args={[0xbdd4ff, 0x2a2118, 0.9]} />
      <directionalLight color={0xfff2dd} intensity={1.6} position={[30, 50, 20]} />
      <MirrorWorld {...props} />
    </Canvas>
  );
}

interface Runtime {
  terrain: TerrainRenderer;
  water: WaterRenderer;
  layer: EntityLayer;
  input: InputState;
}

/** The world's content and frame loop (inside the Canvas). */
function MirrorWorld({ client, assets, pcg, lastStateAt, wireframe, showcase, onHud }: WorldCanvasProps): null {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const rt = useRef<Runtime | null>(null);
  // Latest props for the effects and the frame loop, without re-creating the world.
  const latest = useRef({ wireframe, showcase, onHud, lastStateAt });
  latest.current = { wireframe, showcase, onHud, lastStateAt };
  const camDistance = useRef(DEFAULT_CAM_DISTANCE);
  const loop = useRef({ frames: 0, fpsAt: performance.now(), pointerMoved: false });
  const pointer = useRef(new THREE.Vector2());
  const raycaster = useRef(new THREE.Raycaster());

  // Create the world's renderers and bind input; the same effect disposes
  // them, so StrictMode's mount/unmount/mount never sees a disposed one.
  useEffect(() => {
    const terrain = new TerrainRenderer(client.world?.chunkWorldSize ?? 16);
    const water = new WaterRenderer();
    const layer = new EntityLayer(scene, camera, assets, terrain, { pcg });
    const world = client.world;
    const map = world ? decodeWorldMap(world.map) : null;
    terrain.setWorld(world && map ? { map, bounds: world.bounds, seaLevel: world.seaLevel ?? null } : null);
    water.setWorld(map, world?.seaLevel ?? null);
    terrain.setWireframe(latest.current.wireframe);
    water.setWireframe(latest.current.wireframe);
    scene.add(terrain.group, water.group, layer.group);

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

    rt.current = { terrain, water, layer, input };
    if (latest.current.showcase) layer.setShowcaseVisible(true, camera.position);
    return () => {
      rt.current = null;
      unbind();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointermove", onPointerMove);
      scene.remove(terrain.group, water.group);
      layer.dispose();
      terrain.dispose();
      water.dispose();
    };
  }, [client, assets, pcg, scene, camera, gl]);

  useEffect(() => {
    rt.current?.terrain.setWireframe(wireframe);
    rt.current?.water.setWireframe(wireframe);
  }, [wireframe]);

  useEffect(() => {
    rt.current?.layer.setShowcaseVisible(showcase, camera.position);
  }, [showcase, camera]);

  useFrame(() => {
    const r = rt.current;
    if (!r) return;
    const now = performance.now();
    const l = loop.current;
    l.frames++;
    if (r.input.consumeDirty()) client.sendIntent(r.input.toIntent());

    const tickInterval = 1000 / (client.tickHz || 30);
    const alpha = Math.max(0, Math.min(1, (now - latest.current.lastStateAt()) / tickInterval));
    r.layer.sync(client.state, client.interpolator, alpha, client.playerEntity);
    if (l.pointerMoved) {
      l.pointerMoved = false;
      raycaster.current.setFromCamera(pointer.current, camera);
      r.layer.hover(raycaster.current);
    }
    followCamera(camera, r.layer.player, r.input.lookYaw, r.input.lookPitch, camDistance.current);

    const seconds = now / 1000;
    r.terrain.update();
    r.water.update(seconds);
    updateTerrainFx(seconds);

    if (now - l.fpsAt >= 1000) {
      const fps = Math.round((l.frames * 1000) / (now - l.fpsAt));
      l.frames = 0;
      l.fpsAt = now;
      const me = client.playerEntity !== null ? client.state.get(client.playerEntity) : undefined;
      const p = me?.transform;
      latest.current.onHud?.({
        tick: client.serverTick,
        entities: client.state.entityCount,
        fps,
        px: p?.px ?? 0,
        py: p?.py ?? 0,
        pz: p?.pz ?? 0,
        mode: me?.locomotion?.mode ?? null,
        breath: me?.locomotion?.breath ?? 1,
      });
    }
  });

  return null;
}
