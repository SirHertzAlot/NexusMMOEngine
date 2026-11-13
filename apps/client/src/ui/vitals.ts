/**
 * Vitals readout (roadmap CF2): a bar that tells the truth late, on purpose.
 * The server's value is the truth; what the bar shows trails it:
 *
 *   DRAIN  the fill chases the truth (fast down, slower up)
 *   GHOST  a chunk holds where the bar was, then catches up, so the eye
 *          sees what the last blow cost
 *   STATE  colour from % bands
 *   REACT  the caller flashes / shakes / punches by the size of the drop
 *
 * All values are fractions 0..1. Pure: the Bar component drives it per frame.
 */

import { lerpFollow } from "../motion/index.js";

export interface VitalsRecipe {
  /** Fill chase rates, per second (the exponential rate). */
  drainRate: number;
  healRate: number;
  /** How long the ghost holds before it catches up, ms, and its catch-up rate. */
  ghostHoldMs: number;
  ghostRate: number;
  /** Colour bands: the first whose `upTo` is at or above the fraction. */
  bands: { upTo: number; color: string }[];
  /** A drop of at least this fraction gets the heavy reaction (punch + shake). */
  bigHit: number;
}

export const DEFAULT_VITALS: VitalsRecipe = {
  drainRate: 14,
  healRate: 6,
  ghostHoldMs: 350,
  ghostRate: 4,
  bands: [
    { upTo: 0.25, color: "#ef4444" },
    { upTo: 0.5, color: "#f59e0b" },
    { upTo: 1, color: "#22c55e" },
  ],
  bigHit: 0.15,
};

export interface VitalsState {
  /** What the fill shows. */
  shown: number;
  /** The trailing chunk (never below `shown`). */
  ghost: number;
  /** ms left before the ghost starts to catch up. */
  hold: number;
  /** The last truth seen, to tell a hit from a heal. */
  truth: number;
}

export const newVitals = (truth: number): VitalsState => ({ shown: truth, ghost: truth, hold: 0, truth });

export function bandColor(frac: number, bands: VitalsRecipe["bands"]): string {
  for (const b of bands) if (frac <= b.upTo) return b.color;
  return bands[bands.length - 1]?.color ?? "#fff";
}

/** The truth moved: returns the change (negative: damage). Starts the ghost hold on damage. */
export function observeVitals(s: VitalsState, truth: number, r: VitalsRecipe): number {
  const d = truth - s.truth;
  s.truth = truth;
  if (d < 0) {
    s.ghost = Math.max(s.ghost, s.shown);
    s.hold = r.ghostHoldMs;
  }
  return d;
}

/** Advance `dt` seconds; true while anything is still moving. */
export function stepVitals(s: VitalsState, dt: number, r: VitalsRecipe): boolean {
  const rate = s.truth < s.shown ? r.drainRate : r.healRate;
  s.shown = lerpFollow(s.shown, s.truth, rate, dt);
  if (Math.abs(s.shown - s.truth) < 0.0005) s.shown = s.truth;
  if (s.hold > 0) s.hold -= dt * 1000;
  else s.ghost = lerpFollow(s.ghost, s.shown, r.ghostRate, dt);
  if (s.ghost - s.shown < 0.0005) s.ghost = s.shown;
  if (s.ghost < s.shown) s.ghost = s.shown;
  return s.shown !== s.truth || s.ghost !== s.shown || s.hold > 0;
}
