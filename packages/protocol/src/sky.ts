/**
 * Sky broadcasts (roadmap A4): the server's day clock and weather
 * override ride the chat envelope (0x11), like dungeons and quests.
 * Newcomers read them from the welcome; live clients update on these.
 */

import type { DayClock } from "./day-clock.js";

/**
 * Who owns the sky's weather: the deterministic tick/biome hash (`auto`),
 * a forced-clear sky, or one forced kind at full intensity.
 */
export type WeatherOverride = "auto" | "clear" | "rain" | "snow" | "ash";

/** The day changed (`time`): replace the welcome's clock from here on. */
export interface TimeMessage {
  kind: "time";
  day: DayClock;
}

/** The weather override changed (`weather`): replace the welcome's one. */
export interface WeatherMessage {
  kind: "weather";
  weather: WeatherOverride;
}
