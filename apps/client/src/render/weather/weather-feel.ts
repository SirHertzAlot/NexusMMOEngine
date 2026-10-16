/**
 * WeatherFeel — the WX1 couplings that make the weather felt:
 * wet surfaces, water ripples, and rain audio.
 *
 * One update() per frame, driven by a single weather.sample() call.
 * No per-frame allocation: all state is preallocated.
 */

import type { WeatherSample } from "./field.js";
import type { AudioEngine } from "../../audio/engine.js";
import type { WaterRenderer } from "../water.js";
import type { TerrainRenderer } from "../terrain/terrain-renderer.js";

export class WeatherFeel {
  private wetness = 0;
  private rainLevel = 0;
  private audio: AudioEngine | null = null;

  /** The audio engine for rain sound (set once the app has one). */
  setAudio(audio: AudioEngine | null): void {
    this.audio = audio;
    if (audio && this.rainLevel > 0) audio.setRain(this.rainLevel);
  }

  /**
   * Update all three couplings from a weather sample.
   *
   * @param sample the field's sample at the camera
   * @param delta seconds since the last frame
   * @param water the water renderer (rain ripples)
   * @param terrain the terrain renderer (wet look)
   */
  update(sample: WeatherSample, delta: number, water: WaterRenderer, terrain: TerrainRenderer): void {
    // Wet look: fade in fast, fade out slow (surfaces stay wet after rain).
    const targetWet = sample.kind === "rain" ? sample.intensity : 0;
    const rate = targetWet > this.wetness ? 1.5 : 0.3;
    this.wetness += (targetWet - this.wetness) * Math.min(1, rate * delta);
    terrain.setWetness(this.wetness);

    // Water ripples: direct from the field's rain intensity.
    water.setRainIntensity(sample.kind === "rain" ? sample.intensity : 0);

    // Weather audio: smooth volume follows the rain.
    const targetRain = sample.kind === "rain" ? sample.intensity : 0;
    this.rainLevel += (targetRain - this.rainLevel) * Math.min(1, 2 * delta);
    if (this.audio) this.audio.setRain(this.rainLevel);
  }
}
