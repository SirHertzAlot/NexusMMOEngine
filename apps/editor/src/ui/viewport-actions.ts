/**
 * What the View menu's viewport items act on. The active 3D viewport
 * (scene, dungeon, terrain…) registers while it is mounted; with nothing
 * registered the items disable with a reason instead of "soon".
 */

export interface ViewportActions {
  label: string;
  canZoomIn: boolean;
  canZoomOut: boolean;
  canReset: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

let current: ViewportActions | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

export function registerViewportActions(actions: ViewportActions): void {
  current = actions;
  emit();
}

export function clearViewportActions(actions: ViewportActions): void {
  if (current === actions) {
    current = null;
    emit();
  }
}

export function getViewportActions(): ViewportActions | null {
  return current;
}

export function subscribeViewportActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
