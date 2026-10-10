/**
 * What the View menu's viewport items act on. The active 3D viewport
 * (scene, dungeon, terrain…) registers while it is mounted; with nothing
 * registered the items disable with a reason instead of "soon".
 */

import { createSlot } from "../store.js";

export interface ViewportActions {
  label: string;
  canZoomIn: boolean;
  canZoomOut: boolean;
  canReset: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

const slot = createSlot<ViewportActions>();

export const registerViewportActions = (actions: ViewportActions): void => slot.set(actions);
export const clearViewportActions = (actions: ViewportActions): void => {
  if (slot.get() === actions) slot.set(null);
};
export const getViewportActions = slot.get;
export const subscribeViewportActions = slot.subscribe;
