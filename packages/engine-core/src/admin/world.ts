/**
 * World tweaks (roadmap A4): the time of day. Args schemas live here;
 * failures read as errors, like the player commands in admin/player.ts.
 *
 * Showing reads the shared day clock at the server tick; setting moves
 * the clock's offset so the tick now reads the requested hour. The same
 * object the gateway built its welcome from is mutated, so newcomers see
 * the new time and the change broadcast (cycle B) carries it live.
 */

import { z } from "zod";
import { formatTimeOfDay, timeOfDayAt, type DayClock, type WeatherOverride } from "@mmo-engine/protocol";

const TimeArgsSchema = z.strictObject({
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).default(0),
});

export interface AdminTimeResult {
  ok: boolean;
  message: string;
  /** The clock moved: the caller tells live clients. */
  changed: boolean;
}

export function runTimeCommand(
  day: DayClock | null,
  tick: number,
  tickHz: number,
  args: unknown,
): AdminTimeResult {
  if (day === null) return { ok: false, message: "no day cycle (MMO_DAY_SECONDS unset)", changed: false };
  const parsed = TimeArgsSchema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, message: "usage: time {hour 0-23, minute 0-59?}", changed: false };
  const { hour, minute } = parsed.data;
  if (hour !== undefined) {
    const want = (hour * 60 + minute) / (24 * 60);
    // A hair above the minute: float dust in the offset math would
    // otherwise floor the next show to the previous minute (1e-9 of a
    // day is under a millisecond — nothing can see it).
    day.offset = (((want - tick / tickHz / day.seconds) % 1 + 1) % 1) + 1e-9;
  }
  return { ok: true, message: `${formatTimeOfDay(timeOfDayAt(day, tick, tickHz))} (a day lasts ${day.seconds} s)`, changed: hour !== undefined };
}

const WeatherArgsSchema = z.strictObject({
  weather: z.enum(["auto", "clear", "rain", "snow", "ash"]).optional(),
});

export interface AdminWeatherResult {
  ok: boolean;
  message: string;
  /** The override to store and broadcast; absent on show and failure. */
  weather?: WeatherOverride;
}

/** Show the override, or parse a new one for the caller to store. */
export function parseWeatherCommand(current: WeatherOverride, args: unknown): AdminWeatherResult {
  const parsed = WeatherArgsSchema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, message: "usage: weather {auto|clear|rain|snow|ash}" };
  if (parsed.data.weather === undefined) {
    return {
      ok: true,
      message: current === "auto" ? "weather: auto (following the sky)" : `weather: ${current} (forced)`,
    };
  }
  return { ok: true, message: `weather: ${parsed.data.weather}`, weather: parsed.data.weather };
}
