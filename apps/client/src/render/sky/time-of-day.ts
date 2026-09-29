/**
 * Time of day: a 0..1 time (0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk)
 * to the sun's position, the sky's colours, the haze, and the light.
 * Keyframes, interpolated linearly; colours are linear RGB.
 *
 * Adapted from ProceduralTerrains' TimeOfDay.js (MIT, © 2026 ZyFou; see
 * THIRD_PARTY_NOTICES.md), typed, with the sun direction added.
 */

import * as THREE from "three";

type Rgb = readonly [number, number, number];

export interface TimeOfDayLook {
  /** Degrees above the horizon (negative: below). */
  sunElevation: number;
  /** Degrees clockwise from north: 90 east, 180 south, 270 west. */
  sunAzimuth: number;
  zenith: Rgb;
  horizon: Rgb;
  sunColor: Rgb;
  fogColor: Rgb;
  /** Direct sunlight, relative (noon 1.5). */
  lightIntensity: number;
  /** Sky light, relative (noon 0.5). */
  ambientIntensity: number;
}

interface Keyframe extends TimeOfDayLook {
  time: number;
}

const KEYFRAMES: readonly Keyframe[] = [
  { time: 0.0, sunElevation: -25, sunAzimuth: 0, zenith: [0.01, 0.01, 0.03], horizon: [0.03, 0.04, 0.07], sunColor: [0.15, 0.15, 0.25], fogColor: [0.02, 0.03, 0.06], lightIntensity: 0.08, ambientIntensity: 0.15 }, // midnight
  { time: 0.2, sunElevation: -5, sunAzimuth: 80, zenith: [0.04, 0.04, 0.12], horizon: [0.2, 0.1, 0.08], sunColor: [0.85, 0.4, 0.2], fogColor: [0.12, 0.07, 0.06], lightIntensity: 0.3, ambientIntensity: 0.25 }, // pre-dawn
  { time: 0.28, sunElevation: 8, sunAzimuth: 95, zenith: [0.15, 0.18, 0.42], horizon: [0.7, 0.38, 0.18], sunColor: [1.0, 0.72, 0.42], fogColor: [0.45, 0.28, 0.15], lightIntensity: 0.75, ambientIntensity: 0.35 }, // dawn
  { time: 0.38, sunElevation: 30, sunAzimuth: 120, zenith: [0.22, 0.38, 0.68], horizon: [0.55, 0.6, 0.72], sunColor: [1.0, 0.95, 0.85], fogColor: [0.52, 0.56, 0.65], lightIntensity: 1.2, ambientIntensity: 0.45 }, // morning
  { time: 0.5, sunElevation: 65, sunAzimuth: 180, zenith: [0.18, 0.35, 0.72], horizon: [0.5, 0.62, 0.78], sunColor: [1.0, 0.98, 0.92], fogColor: [0.55, 0.62, 0.75], lightIntensity: 1.5, ambientIntensity: 0.5 }, // noon
  { time: 0.62, sunElevation: 35, sunAzimuth: 240, zenith: [0.2, 0.35, 0.65], horizon: [0.55, 0.58, 0.68], sunColor: [1.0, 0.94, 0.82], fogColor: [0.5, 0.54, 0.62], lightIntensity: 1.3, ambientIntensity: 0.45 }, // afternoon
  { time: 0.72, sunElevation: 8, sunAzimuth: 265, zenith: [0.12, 0.12, 0.35], horizon: [0.75, 0.32, 0.12], sunColor: [1.0, 0.55, 0.22], fogColor: [0.5, 0.25, 0.12], lightIntensity: 0.7, ambientIntensity: 0.3 }, // dusk
  { time: 0.8, sunElevation: -5, sunAzimuth: 280, zenith: [0.04, 0.04, 0.14], horizon: [0.22, 0.08, 0.06], sunColor: [0.6, 0.25, 0.12], fogColor: [0.1, 0.06, 0.05], lightIntensity: 0.2, ambientIntensity: 0.2 }, // after dusk
  { time: 1.0, sunElevation: -25, sunAzimuth: 360, zenith: [0.01, 0.01, 0.03], horizon: [0.03, 0.04, 0.07], sunColor: [0.15, 0.15, 0.25], fogColor: [0.02, 0.03, 0.06], lightIntensity: 0.08, ambientIntensity: 0.15 }, // midnight again
];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** The look at a time of day (wrapped into 0..1). */
export function evaluateTimeOfDay(time: number): TimeOfDayLook {
  const t = ((time % 1) + 1) % 1;
  let i = 0;
  while (i < KEYFRAMES.length - 2 && t > KEYFRAMES[i + 1].time) i++;
  const a = KEYFRAMES[i];
  const b = KEYFRAMES[i + 1];
  const k = b.time > a.time ? (t - a.time) / (b.time - a.time) : 0;
  return {
    sunElevation: lerp(a.sunElevation, b.sunElevation, k),
    sunAzimuth: lerp(a.sunAzimuth, b.sunAzimuth, k),
    zenith: lerpRgb(a.zenith, b.zenith, k),
    horizon: lerpRgb(a.horizon, b.horizon, k),
    sunColor: lerpRgb(a.sunColor, b.sunColor, k),
    fogColor: lerpRgb(a.fogColor, b.fogColor, k),
    lightIntensity: lerp(a.lightIntensity, b.lightIntensity, k),
    ambientIntensity: lerp(a.ambientIntensity, b.ambientIntensity, k),
  };
}

/**
 * Unit vector toward the sun. World axes: +y up, north is -z (the frozen
 * north of the baked worlds), so south is +z and east +x.
 */
export function sunDirection(look: TimeOfDayLook, out = new THREE.Vector3()): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(look.sunElevation);
  const az = THREE.MathUtils.degToRad(look.sunAzimuth);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}
