/**
 * The active 3D viewport, shared outside React: the toolbar's viewport
 * options (Grid, Gizmos, Wireframe, Screenshot) and the View menu (Zoom,
 * Reset Viewport) act on whichever viewport is registered — the Scenes
 * viewport in edit mode, the game view in play mode. A viewport lists what
 * it supports; the menus disable what the active one cannot do and say why.
 */

export interface ViewportFlags {
  grid: boolean;
  gizmos: boolean;
  wireframe: boolean;
}

export interface ViewportAdapter {
  label: string;
  /** Which toggles this viewport has. */
  supports: Partial<Record<keyof ViewportFlags, boolean>>;
  /** Dolly by a factor (> 1 zooms in); absent when the viewport owns its camera. */
  zoom?: (factor: number) => void;
  reset?: () => void;
  /** A PNG of what the viewport shows now. */
  screenshot: () => Promise<Blob | null>;
}

let flags: ViewportFlags = { grid: true, gizmos: true, wireframe: false };
let active: ViewportAdapter | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((fn) => fn());

export const getViewportFlags = (): ViewportFlags => flags;
export const getViewport = (): ViewportAdapter | null => active;

export function setViewportFlag(key: keyof ViewportFlags, value: boolean): void {
  if (flags[key] === value) return;
  flags = { ...flags, [key]: value };
  emit();
}

export function toggleViewportFlag(key: keyof ViewportFlags): void {
  setViewportFlag(key, !flags[key]);
}

/** Make `adapter` the active viewport; returns the function that unregisters it. */
export function registerViewport(adapter: ViewportAdapter): () => void {
  active = adapter;
  emit();
  return () => {
    if (active !== adapter) return;
    active = null;
    emit();
  };
}

export function subscribeViewport(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export type ViewportCommand = "zoom-in" | "zoom-out" | "reset";

/** Why a command is unavailable right now, or null when it can run. */
export function viewportBlocked(cmd: ViewportCommand): string | null {
  if (!active) return "no 3D viewport is open (open Scenes or play the game)";
  if (cmd === "reset" ? !active.reset : !active.zoom) {
    return `the ${active.label} owns its camera (use the mouse wheel and drag)`;
  }
  return null;
}

export function runViewportCommand(cmd: ViewportCommand): void {
  if (viewportBlocked(cmd) !== null || !active) return;
  if (cmd === "reset") active.reset?.();
  else active.zoom?.(cmd === "zoom-in" ? 1.25 : 0.8);
}

/** Why a toggle is unavailable, or null. */
export function flagBlocked(key: keyof ViewportFlags): string | null {
  if (!active) return "no 3D viewport is open (open Scenes or play the game)";
  return active.supports[key] ? null : `the ${active.label} has no ${key}`;
}
