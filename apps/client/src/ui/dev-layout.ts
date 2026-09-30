/**
 * Where the dev HUD's panels sit: position, size, opacity, and whether
 * each is open or folded to its title. The player arranges them (drag,
 * resize, fade; ui/dev-panels.tsx) and the layout is kept in this
 * browser's localStorage, so it survives reloads. Anything stored that
 * no longer fits (an old version, a smaller window) falls back to the
 * defaults or is pulled back on screen.
 */

export interface PanelLayout {
  x: number;
  y: number;
  /** Width in px; height in px, or null to fit the content. */
  w: number;
  h: number | null;
  /** 0.2..1 */
  opacity: number;
  open: boolean;
  collapsed: boolean;
}

export interface DevLayout {
  /** Every dev panel hidden at once (the ` key), without losing which are open. */
  hidden: boolean;
  panels: Record<string, PanelLayout>;
}

export const MIN_OPACITY = 0.2;
export const MIN_W = 160;
export const MIN_H = 48;
/** How much of a panel must stay on screen to be grabbed back. */
const KEEP = 48;
const STORAGE_KEY = "mmo.devhud.v1";

export function clampPanel(p: PanelLayout, viewport: { width: number; height: number }): PanelLayout {
  const w = Math.max(MIN_W, Math.min(p.w, viewport.width));
  const h = p.h === null ? null : Math.max(MIN_H, Math.min(p.h, viewport.height));
  return {
    ...p,
    w,
    h,
    // The title bar stays reachable: at least KEEP px across, and never above the top.
    x: Math.round(Math.max(KEEP - w, Math.min(p.x, viewport.width - KEEP))),
    y: Math.round(Math.max(0, Math.min(p.y, viewport.height - 24))),
    opacity: Math.max(MIN_OPACITY, Math.min(1, p.opacity)),
  };
}

/** The stored layout over the defaults: unknown panels dropped, missing ones defaulted, bad values ignored. */
export function loadLayout(storage: Pick<Storage, "getItem"> | null, defaults: DevLayout): DevLayout {
  let stored: unknown = null;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const s = (stored ?? {}) as Partial<DevLayout>;
  const panels: Record<string, PanelLayout> = {};
  for (const [id, d] of Object.entries(defaults.panels)) {
    const p = s.panels?.[id];
    panels[id] = isPanel(p) ? p : d;
  }
  return { hidden: typeof s.hidden === "boolean" ? s.hidden : defaults.hidden, panels };
}

export function saveLayout(storage: Pick<Storage, "setItem"> | null, layout: DevLayout): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Private windows and blocked storage: the layout lasts this session only.
  }
}

/** localStorage, or null where the browser refuses it. */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isPanel(p: unknown): p is PanelLayout {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  return (
    num(o.x) && num(o.y) && num(o.w) && (o.h === null || num(o.h)) && num(o.opacity) &&
    typeof o.open === "boolean" && typeof o.collapsed === "boolean"
  );
}
