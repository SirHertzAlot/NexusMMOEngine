/**
 * Pure helpers for the scene viewport camera (developer tools: the editor,
 * not the game client). Kept free of three.js and the DOM so they test in
 * plain node.
 */

/** Parse "x, z" (or "x z") into ground coordinates; null when malformed. */
export function parseGoTo(text: string): { x: number; z: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const x = Number(m[1]);
  const z = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}

/** Fly-camera axes from the held keys (lower-case). W/S forward-back, D/A right-left, E/Q up-down. */
export function flyAxes(keys: ReadonlySet<string>): { forward: number; right: number; up: number } {
  const on = (k: string): number => (keys.has(k) ? 1 : 0);
  return {
    forward: on("w") - on("s"),
    right: on("d") - on("a"),
    up: on("e") - on("q"),
  };
}

/** Fly speed in metres per second; Shift triples it. */
export const FLY_SPEED = 12;
export const FLY_BOOST = 3;

/** Keys the fly camera uses; the viewport must not also act on them as tool shortcuts. */
export const FLY_KEYS: ReadonlySet<string> = new Set(["w", "a", "s", "d", "q", "e"]);
