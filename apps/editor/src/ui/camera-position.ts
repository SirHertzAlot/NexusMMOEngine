/**
 * Scene camera ground position, shared with the Play menu's "Start from".
 *
 * The scene viewport publishes its camera's ground (x, z) here; the
 * play-mode start path reads it when the user picks "Camera position".
 * Null when the viewport has never been mounted.
 */

import { createStore } from "../store.js";

export interface GroundPos {
  x: number;
  z: number;
}

// Every report counts as a change (the camera moved), so nothing is "equal".
const store = createStore<GroundPos | null>(null, () => false);

export const setSceneCameraPos = (p: GroundPos): void => store.set({ x: p.x, z: p.z });
export const getSceneCameraPos = (): GroundPos | null => {
  const p = store.get();
  return p ? { ...p } : null;
};
export const subscribeSceneCameraPos = store.subscribe;
