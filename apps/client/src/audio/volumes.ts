/**
 * Audio volumes (U4): a master level, one level per bus, and mute.
 * Persisted per browser like the UI scale; missing or blocked storage
 * just starts at the defaults.
 */

import { t } from "../i18n.js";

export const AUDIO_BUSES = ["effects", "interface", "ambience"] as const;
export type AudioBus = (typeof AUDIO_BUSES)[number];

/** What a bus is called in the settings menu (the string table's `audio.bus.<id>`). */
export const busLabel = (b: AudioBus): string => t(`audio.bus.${b}`);

export interface Volumes {
  /** 0..1 each. */
  master: number;
  effects: number;
  interface: number;
  ambience: number;
  muted: boolean;
}

export const DEFAULT_VOLUMES: Volumes = { master: 0.8, effects: 0.8, interface: 0.7, ambience: 0.5, muted: false };

const STORAGE_KEY = "mmo.audio.v1";

const level = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

/** Anything stored (or nothing) to a valid Volumes; unknown fields are dropped, bad ones defaulted. */
export function parseVolumes(raw: unknown): Volumes {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    master: level(o.master, DEFAULT_VOLUMES.master),
    effects: level(o.effects, DEFAULT_VOLUMES.effects),
    interface: level(o.interface, DEFAULT_VOLUMES.interface),
    ambience: level(o.ambience, DEFAULT_VOLUMES.ambience),
    muted: o.muted === true,
  };
}

export function loadVolumes(): Volumes {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    return raw ? parseVolumes(JSON.parse(raw) as unknown) : { ...DEFAULT_VOLUMES };
  } catch {
    return { ...DEFAULT_VOLUMES };
  }
}

export function saveVolumes(v: Volumes): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // Persistence is a convenience; the session keeps working.
  }
}

/**
 * Slider position to gain. Loudness is roughly logarithmic, so a squared
 * curve makes the slider's middle sound like the middle.
 */
export function sliderGain(v: number): number {
  const x = level(v, 0);
  return x * x;
}

/** The master node's gain: zero when muted. */
export function masterGain(v: Volumes): number {
  return v.muted ? 0 : sliderGain(v.master);
}
