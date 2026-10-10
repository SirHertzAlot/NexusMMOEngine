/**
 * "Start from" spawn resolution for the Play menu.
 *
 * Maps the menu's `from` choice to a spawn target the server can honor.
 * Pure function (no React, no DOM): the camera position is injected so
 * node:test can pass a fake.
 */

import { CAMERA_FROM, fromNodeId } from "./ui/play-setup.js";

export type SpawnTarget =
  | { kind: "default" }
  | { kind: "default"; note: string }
  | { kind: "at"; x: number; z: number }
  /** Any other flow node: the player's client starts there (the viewport shows only the world). */
  | { kind: "node"; node: string };

export interface CameraGroundPos {
  x: number;
  z: number;
}

/**
 * Resolve the Play menu's "Start from" value to a spawn target.
 * "World" (or the flow's world node, via worldNode) spawns at the default
 * point; "Camera position" at the scene camera; any other flow node is a
 * client start.
 */
export function resolveSpawnTarget(from: string, camera: CameraGroundPos | null, worldNode = "world"): SpawnTarget {
  if (from === CAMERA_FROM) {
    if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) return { kind: "at", x: camera.x, z: camera.z };
    return { kind: "default", note: "scene camera not available — using the default spawn" };
  }
  const node = fromNodeId(from);
  return node === worldNode ? { kind: "default" } : { kind: "node", node };
}
