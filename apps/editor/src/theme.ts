/**
 * Editor theme selection (docs/EDITOR-UI-2026.md §4).
 *
 * Two themes live side by side while the rebuild lands: `m3`, the
 * Material 3 scheme app.css has always defined, and `forge`, the 2026
 * design language in forge.css. Both are plain token sets on
 * `:root[data-theme]`, so switching one costs nothing at runtime and
 * nothing in the component tree.
 *
 * Precedence: `?theme=` in the URL (so a capture or a bug report can
 * pin one), then the stored choice, then `m3`. Storage is wrapped —
 * a blocked or full localStorage leaves the editor on the default
 * rather than failing, the same rule editor-prefs.ts follows.
 */

import { createStore } from "./store.js";

export type ThemeId = "m3" | "forge";

export const THEME_KEY = "mmo-editor.theme";
export const DEFAULT_THEME: ThemeId = "m3";

const THEMES: readonly ThemeId[] = ["m3", "forge"];

/**
 * The theme as state. `data-theme` on the root is what CSS reads, but a
 * few components need to know which language they are drawn in — the
 * forge chrome bar has no Material 3 counterpart, so it mounts only
 * under `forge` rather than being restyled into nothing.
 */
const themeStore = createStore<ThemeId>(DEFAULT_THEME);

/** The theme in force right now. */
export const currentTheme = themeStore.get;

/** The theme as React state: a component re-renders when it switches. */
export const useTheme = themeStore.useValue;

function isTheme(value: string | null): value is ThemeId {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/** The theme asked for in the URL query, if it names a real one. */
export function themeFromSearch(search: string): ThemeId | null {
  try {
    const value = new URLSearchParams(search).get("theme");
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** The stored choice, if there is a readable one. */
export function storedTheme(): ThemeId | null {
  try {
    const value = window.localStorage?.getItem(THEME_KEY) ?? null;
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Resolve the theme to use, URL first, then storage, then the default. */
export function resolveTheme(search: string): ThemeId {
  return themeFromSearch(search) ?? storedTheme() ?? DEFAULT_THEME;
}

/** Write the theme onto the document root. Returns what it set. */
export function setTheme(theme: ThemeId, remember = true): ThemeId {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
  themeStore.set(theme);
  if (remember) {
    try {
      window.localStorage?.setItem(THEME_KEY, theme);
    } catch {
      /* storage blocked: the theme still applies for this session */
    }
  }
  return theme;
}

/** Apply the resolved theme at startup. Safe to call before React mounts. */
export function applyStoredTheme(): ThemeId {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const theme = resolveTheme(search);
  // A theme pinned in the URL is for this load only; it is not stored.
  return setTheme(theme, themeFromSearch(search) === null);
}
