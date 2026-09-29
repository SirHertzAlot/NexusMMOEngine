/**
 * Third-person follow camera: behind the player, orbiting with mouse look
 * (yaw/pitch from InputState), at a wheel-controlled distance.
 */

import type * as THREE from "three";

/** Follow distance limits (mouse wheel), metres. */
export const MIN_CAM_DISTANCE = 4;
export const MAX_CAM_DISTANCE = 24;
export const DEFAULT_CAM_DISTANCE = 9;

/** Where the camera looks before the player entity appears. */
const IDLE_TARGET = { x: 8, y: 2, z: 8 };

export function clampCamDistance(d: number): number {
  return Math.max(MIN_CAM_DISTANCE, Math.min(MAX_CAM_DISTANCE, d));
}

/** Place the camera behind `target` (the player) and aim it just above. */
export function followCamera(
  camera: THREE.Camera,
  target: THREE.Vector3 | null,
  lookYaw: number,
  lookPitch: number,
  distance: number,
): void {
  const t = target ?? IDLE_TARGET;
  const cp = Math.cos(lookPitch);
  const sp = Math.sin(lookPitch);
  const cx = t.x - Math.sin(lookYaw) * cp * distance;
  const cz = t.z - Math.cos(lookYaw) * cp * distance;
  const cy = t.y + sp * distance + 1.2;
  camera.position.set(cx, Math.max(cy, t.y + 0.6), cz);
  camera.lookAt(t.x, t.y + 1.0, t.z);
}
