/**
 * UI scale (U4): root font-size percent; Tailwind utilities are
 * rem-based, so the whole interface scales together. Persisted per
 * browser; missing/blocked storage simply stays at 100%.
 */

export const UI_SCALES = [90, 100, 110, 125] as const;
export type UiScale = (typeof UI_SCALES)[number];

const STORAGE_KEY = "mmo.uiScale.v1";

export function parseUiScale(raw: unknown): UiScale {
  if (typeof raw === "number" && (UI_SCALES as readonly number[]).includes(raw)) {
    return raw as UiScale;
  }
  return 100;
}

export function loadUiScale(): UiScale {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return 100;
    return parseUiScale(JSON.parse(raw) as unknown);
  } catch {
    return 100;
  }
}

/** Apply to the document root; returns the applied scale. */
export function applyUiScale(scale: UiScale): UiScale {
  document.documentElement.style.fontSize = `${scale}%`;
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(scale));
  } catch {
    // Persistence is a convenience; the session keeps working.
  }
  return scale;
}
