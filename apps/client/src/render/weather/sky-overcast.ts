/**
 * SkyOvercast — blend the physical sky / fog toward overcast from a
 * weather sample.
 *
 * Given a WeatherSample, returns parameters that dim the sun, grey the
 * sky, and pull the fog in. Cheap, no per-frame allocation (out-parameter
 * pattern), and degrades gracefully to the current look when the weather
 * is clear.
 */

import type { WeatherSample } from "./field.js";

/** Overcast blend parameters, computed from a weather sample. */
export interface OvercastParams {
  /** 0 = clear sky, 1 = fully overcast. */
  coverage: number;
  /** Sun brightness multiplier (1 = no dim, 0 = no sun). */
  sunDim: number;
  /** Fog distance multiplier (1 = normal, <1 = pulled in). */
  fogPull: number;
  /** Sky brightness multiplier (1 = normal, <1 = darkened). */
  skyDarken: number;
}

/**
 * Compute overcast parameters from a weather sample into `out`.
 *
 * Clear weather (kind "clear" or intensity 0) returns the neutral blend.
 * Heavy rain/snow/ash returns a visibly darker, closer-fog blend scaled
 * by intensity. Rain dims the sun more than snow; ash is darkest.
 */
export function overcastFromSample(sample: WeatherSample, out: OvercastParams): OvercastParams {
  if (sample.kind === "clear" || sample.intensity <= 0) {
    out.coverage = 0;
    out.sunDim = 1;
    out.fogPull = 1;
    out.skyDarken = 1;
    return out;
  }

  const t = sample.intensity;
  // How much the sun dims at full intensity, per kind.
  const dimFactor = sample.kind === "rain" ? 0.7 : sample.kind === "snow" ? 0.8 : 0.5;
  // How much fog pulls in at full intensity, per kind.
  const fogFactor = sample.kind === "rain" ? 0.5 : sample.kind === "snow" ? 0.3 : 0.7;
  // How much the sky darkens at full intensity, per kind.
  const darkFactor = sample.kind === "rain" ? 0.6 : sample.kind === "snow" ? 0.8 : 0.4;

  out.coverage = t;
  out.sunDim = 1 - (1 - dimFactor) * t;
  out.fogPull = 1 - fogFactor * t;
  out.skyDarken = 1 - (1 - darkFactor) * t;
  return out;
}
