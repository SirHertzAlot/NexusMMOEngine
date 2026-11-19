/**
 * Interface choreography (roadmap CF3): menus as data plus one runtime.
 *
 *   ENTER   staggered cascade along the layout motif   (theme.enter, staggerMs)
 *   FOCUS   a state machine: the focused item grows, offsets and inverts,
 *           the rest dim and drift                      (theme.focus, idle)
 *   CONFIRM punch + flash on activation                 (theme.confirm)
 *
 * The theme is a token set: swap `color` at runtime and every menu follows.
 * Rarity tiers select a colour and sheen strength wherever items are shown.
 * Pure helpers here; ui/choreo-menu.tsx drives the DOM. Presentation only.
 */

import { lerpFollow, type Recipe } from "../motion/index.js";

export type Motif = "cascade" | "chevron" | "stack";

export interface MenuTheme {
  /** The theme colour: focus fill, border, indicator. Swappable at runtime. */
  color: string;
  /** Skew of the whole menu, degrees (0: upright). */
  slantDeg: number;
  motif: Motif;
  /** Per-item step of the motif, px. */
  motifStep: { x: number; y: number };
  /** Delay between one item's entrance and the next, ms. */
  staggerMs: number;
  /** Each item's entrance. */
  enter: Recipe;
  focus: {
    scale: number;
    /** Sideways push of the focused item, px. */
    offsetX: number;
    /** Text turns dark on the filled item. */
    invert: boolean;
    /** Opacity of the items that are not focused (0..1). */
    dim: number;
    /** How fast the treatment chases its target, per second. */
    rate: number;
  };
  /** Unfocused drift (px, Hz); amp 0 turns it off. */
  idle: { amp: number; freq: number };
  /** On activation. */
  confirm: Recipe;
  /** Rarity tier -> colour and sheen strength (0..1). */
  rarity: Record<string, { color: string; sheen: number }>;
}

export const DEFAULT_THEME: MenuTheme = {
  color: "#f5c542",
  slantDeg: 0,
  motif: "cascade",
  motifStep: { x: 6, y: 0 },
  staggerMs: 45,
  enter: { steps: [{ p: "pop", ms: 140, from: 0.85, overshoot: 1.04 }, { p: "fade", ms: 140, parallel: true }] },
  focus: { scale: 1.03, offsetX: 8, invert: true, dim: 0.72, rate: 14 },
  idle: { amp: 1.2, freq: 0.5 },
  confirm: { steps: [{ p: "punch", ms: 140, amp: 0.06, shake: 2 }, { p: "flash", ms: 160, amount: 0.5, parallel: true }] },
  rarity: {
    common: { color: "#d1d5db", sheen: 0 },
    uncommon: { color: "#4ade80", sheen: 0.15 },
    rare: { color: "#60a5fa", sheen: 0.3 },
    epic: { color: "#c084fc", sheen: 0.5 },
    legendary: { color: "#fb923c", sheen: 0.8 },
  },
};

/** Where item `i` of `n` sits relative to a plain column, px. */
export function itemOffset(motif: Motif, i: number, n: number, step: MenuTheme["motifStep"]): { x: number; y: number } {
  if (motif === "cascade") return { x: i * step.x, y: i * step.y };
  if (motif === "chevron") {
    const d = Math.abs(i - (n - 1) / 2);
    return { x: (((n - 1) / 2) - d) * step.x, y: 0 };
  }
  return { x: 0, y: 0 };
}

/** Move focus one item; wraps at the ends, or stops there with `wrap` false. */
export function moveFocus(cur: number, dir: 1 | -1, n: number, wrap = true): number {
  if (n <= 0) return -1;
  if (cur < 0) return dir > 0 ? 0 : n - 1;
  const next = cur + dir;
  if (wrap) return (next + n) % n;
  return Math.max(0, Math.min(n - 1, next));
}

/** What one item currently shows; chases the target each frame. */
export interface Treat {
  /** 0 unfocused .. 1 focused. */
  focus: number;
}

export const newTreat = (focused: boolean): Treat => ({ focus: focused ? 1 : 0 });

/** Advance toward focused/unfocused; true while still moving. */
export function stepTreat(t: Treat, focused: boolean, rate: number, dt: number): boolean {
  t.focus = lerpFollow(t.focus, focused ? 1 : 0, rate, dt);
  const target = focused ? 1 : 0;
  if (Math.abs(t.focus - target) < 0.002) t.focus = target;
  return t.focus !== target;
}

/** The rarity's colour and sheen; unknown tiers fall back to the first one. */
export function rarityStyle(theme: MenuTheme, tier: string | undefined): { color: string; sheen: number } {
  return (tier && theme.rarity[tier]) || Object.values(theme.rarity)[0] || { color: "#fff", sheen: 0 };
}
