/**
 * Scene camera ground position, shared with the Play menu's "Start from".
 *
 * The scene viewport publishes its camera's ground (x, z) here; the
 * play-mode start path reads it when the user picks "Camera position".
 * Null when the viewport has never been mounted.
 */

export interface GroundPos {
  x: number;
  z: number;
}

let pos: GroundPos | null = null;
const listeners = new Set<() => void>();

/** Called by the scene viewport (throttled by the caller). */
export function setSceneCameraPos(p: GroundPos): void {
  pos = { x: p.x, z: p.z };
  for (const l of listeners) l();
}

export function getSceneCameraPos(): GroundPos | null {
  return pos ? { ...pos } : null;
}

export function subscribeSceneCameraPos(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
