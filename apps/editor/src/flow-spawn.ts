/**
 * "Start from" spawn resolution for the Play menu.
 *
 * Maps the menu's `from` choice to a spawn target the server can honor.
 * Pure function (no React, no DOM): the camera position is injected so
 * node:test can pass a fake.
 */

export type SpawnTarget =
  | { kind: "default" }
  | { kind: "default"; note: string }
  | { kind: "at"; x: number; z: number }
  | { kind: "preview"; reason: string };

export interface CameraGroundPos {
  x: number;
  z: number;
}

/**
 * Resolve the Play menu's "Start from" value to a spawn target.
 * Unknown values fall back to the default spawn (never throws).
 */
export function resolveSpawnTarget(from: string, camera: CameraGroundPos | null): SpawnTarget {
  switch (from) {
    case "World":
      return { kind: "default" };
    case "Camera position":
      if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
        return { kind: "at", x: camera.x, z: camera.z };
      }
      return { kind: "default", note: "scene camera not available — using the default spawn" };
    case "Login":
    case "Character creation":
      return {
        kind: "preview",
        reason:
          "needs the client to run the actual login/character-creation UI instead of auto-login — not a spawn point",
      };
    default:
      return { kind: "default" };
  }
}
