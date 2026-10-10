/**
 * First-person camera: the sibling of followCamera.
 *
 * Same yaw/pitch convention as the third-person follow camera —
 * yaw 0 faces +Z, and positive pitch (from mouse-up) looks down —
 * so toggling views never inverts the controls. The camera sits at the
 * eye point and looks along the view direction; movement stays
 * server-authoritative (the input module already feeds lookYaw/lookPitch
 * from pointer-lock mouse deltas).
 */

import type * as THREE from "three";

/** Eye height above the avatar's feet, metres. */
export const EYE_HEIGHT = 1.6;

/**
 * Place the camera at `eye` and aim it along (lookYaw, lookPitch).
 * A null eye leaves the camera untouched (the caller falls back to the
 * follow camera's idle target).
 */
export function firstPersonCamera(
  camera: THREE.Camera,
  eye: THREE.Vector3 | null,
  lookYaw: number,
  lookPitch: number,
): void {
  if (!eye) return;
  const cp = Math.cos(lookPitch);
  camera.position.copy(eye);
  camera.lookAt(
    eye.x + Math.sin(lookYaw) * cp,
    eye.y - Math.sin(lookPitch),
    eye.z + Math.cos(lookYaw) * cp,
  );
}
