/**
 * EA21 playback planning: the server's Animation row → what the client
 * plays. Pure (no three.js, no clock): the same function runs in the game,
 * in the editor's preview and in tests, and three.js only executes the
 * plan (see the client's CharacterAnimator).
 *
 * The server sends (clipId, startTick, rate, layerMask); this turns it into
 * a library clip name, the layers it plays on, how far into it the client
 * already is, and the speed — then the crossfade weights between two
 * clips over time.
 */

import type { ClipMapEntry } from "./clip-map.js";

/** layerMask bits (protocol Animation component). */
export const LAYER_BASE = 1;
export const LAYER_UPPER = 2;

/** The server's playback rate, kept to a range the mixer can use. */
export const MIN_RATE = 0.1;
export const MAX_RATE = 4;

/** The Animation row as the client mirrors it. */
export interface AnimationState {
  clipId: number;
  startTick: number;
  rate: number;
  layerMask: number;
}

export interface Layers {
  /** The whole body (the locomotion layer, or a one-shot over it). */
  base: boolean;
  /** The upper body only: the legs keep their locomotion. */
  upper: boolean;
}

/** The layers a mask names; an empty mask is the base layer. */
export function layersOf(mask: number): Layers {
  const upper = (mask & LAYER_UPPER) !== 0;
  const base = (mask & LAYER_BASE) !== 0 || !upper;
  return { base, upper };
}

export function clampRate(rate: number): number {
  return Number.isFinite(rate) ? Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) : 1;
}

/** Seconds from a server tick to now (never negative: a clip that starts on the next tick has not started). */
export function secondsSince(startTick: number, nowTick: number, tickHz: number): number {
  return Math.max(0, (nowTick - startTick) / tickHz);
}

/** What to play for one entity right now. */
export interface ClipPlan {
  clipId: number;
  /** The clip's name in the animation library. */
  clip: string;
  layers: Layers;
  loop: boolean;
  /** Seconds the clip has been running, in real time (the playhead is this × timeScale). */
  elapsed: number;
  timeScale: number;
  /** Crossfade seconds. */
  fade: number;
  /** Changes when the server starts a new clip (a repeat of the same clip included). */
  key: string;
}

/**
 * The plan for a row, or null when there is nothing to play: no row, clip
 * 0 (the server says "locomotion fallback"), or an id the map does not know.
 */
export function planClip(
  row: AnimationState | undefined,
  map: ReadonlyMap<number, ClipMapEntry>,
  nowTick: number,
  tickHz: number,
): ClipPlan | null {
  if (!row || row.clipId === 0) return null;
  const entry = map.get(row.clipId);
  if (!entry) return null;
  return {
    clipId: row.clipId,
    clip: entry.clip,
    layers: layersOf(row.layerMask),
    loop: entry.loop,
    elapsed: secondsSince(row.startTick, nowTick, tickHz),
    timeScale: clampRate(row.rate),
    fade: entry.fade,
    key: `${row.clipId}:${row.startTick}`,
  };
}

/** Where in a clip of `duration` seconds the playhead is: a loop wraps, a one-shot holds its last pose. */
export function playhead(elapsed: number, timeScale: number, duration: number, loop: boolean): number {
  if (duration <= 0) return 0;
  const t = Math.max(0, elapsed) * timeScale;
  return loop ? t % duration : Math.min(t, duration);
}

/** Smoothstep: the crossfade eases in and out instead of kinking at both ends. */
const ease = (t: number): number => t * t * (3 - 2 * t);

export interface FadeWeights {
  /** The clip being left. */
  from: number;
  /** The clip being entered. */
  to: number;
}

/**
 * The blend of two clips `elapsed` seconds into a crossfade of `duration`.
 * The weights always add to 1, so the pose never dips or overshoots.
 */
export function crossfadeWeights(elapsed: number, duration: number): FadeWeights {
  if (!(duration > 0)) return { from: 0, to: 1 };
  const t = ease(Math.min(1, Math.max(0, elapsed / duration)));
  return { from: 1 - t, to: t };
}
