/**
 * What the View menu's viewport items and the toolbar's viewport options act
 * on. The active 3D viewport (the Scenes viewport in edit mode, the game view
 * in play mode) registers while it is mounted and says what it supports; the
 * menus disable what the active one cannot do and say why, instead of "soon".
 */

import { createSlot, createStore } from "../store.js";

export interface ViewportFlags {
  grid: boolean;
  gizmos: boolean;
  wireframe: boolean;
}

export interface ViewportActions {
  label: string;
  canZoomIn: boolean;
  canZoomOut: boolean;
  canReset: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  /** Which toggles this viewport has (absent: none). */
  supports?: Partial<Record<keyof ViewportFlags, boolean>>;
  /** A PNG of what the viewport shows now (absent: it cannot take one). */
  screenshot?: () => Promise<Blob | null>;
}

const slot = createSlot<ViewportActions>();

/** The toggles, shared so the toolbar menu and any panel's own button stay in step. */
export const viewportFlags = createStore<ViewportFlags>({ grid: true, gizmos: true, wireframe: false });

export const toggleViewportFlag = (key: keyof ViewportFlags): void => viewportFlags.set((f) => ({ ...f, [key]: !f[key] }));

/** Why a toggle is unavailable, or null. */
export function flagBlocked(key: keyof ViewportFlags): string | null {
  const vp = slot.get();
  if (!vp) return "no 3D viewport is open (open Scenes or play the game)";
  return vp.supports?.[key] ? null : `the ${vp.label} has no ${key}`;
}

/** Why a screenshot is unavailable, or null. */
export function screenshotBlocked(): string | null {
  const vp = slot.get();
  if (!vp) return "no 3D viewport is open (open Scenes or play the game)";
  return vp.screenshot ? null : `the ${vp.label} cannot take a screenshot`;
}

export const registerViewportActions = (actions: ViewportActions): void => slot.set(actions);
export const clearViewportActions = (actions: ViewportActions): void => {
  if (slot.get() === actions) slot.set(null);
};
export const getViewportActions = slot.get;
export const subscribeViewportActions = slot.subscribe;
