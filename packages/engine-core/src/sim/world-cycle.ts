/**
 * World Cycle System: Macro Seasonal & Climate Dynamics.
 *
 * Drives the world from awake to dormant across four distinct seasons:
 *  - Spring: Awakening from dormancy, snowmelt, lush flora, high vitality, fawning/lambing, animal playfulness.
 *  - Summer: Peak solar energy, high metabolic expenditure, heat, frequent drinking, active foraging.
 *  - Autumn: Rutting & spurring season! Male sparring, headbutts, vocalizations, aggressive territory defense,
 *            hyperphagia (eating heavily to store fat for winter).
 *  - Winter: Dormancy / torpor / hibernation for certain species (bears denning, small critters torpid),
 *            scarce forage, clustering near shelter, conserved stamina.
 *
 * Adheres strictly to Universal SI Metric and zero-allocation hot-path invariants (AGENTS.md §5, §6).
 */

import type { DayClock } from "@mmo-engine/protocol";

export type Season = "spring" | "summer" | "autumn" | "winter";

export interface SeasonClock {
  /** Game days per season (default: 7 days, so 28 game days = 1 full game year). */
  daysPerSeason: number;
  /** Real seconds per game day (inherited from DayClock.seconds). */
  secondsPerDay: number;
  /** Day offset at tick 0. */
  offsetDay: number;
}

export const DEFAULT_SEASON_CLOCK: Readonly<SeasonClock> = Object.freeze({
  daysPerSeason: 7,
  secondsPerDay: 2400, // 40 minutes per game day
  offsetDay: 0,        // Starts in Year 1, Spring Day 1
});

export interface WorldCycleState {
  /** Total elapsed game days since world inception. */
  dayIndex: number;
  /** Game year (1-indexed). */
  year: number;
  /** Current season. */
  season: Season;
  /** Day within the current season (0 .. daysPerSeason - 1). */
  dayOfSeason: number;
  /** Progress through the current season (0.0 to 1.0). */
  seasonProgress: number;
  /** Progress through the full annual cycle (0.0 to 1.0, 0 = Spring equinox). */
  yearProgress: number;
  /** Time of day (0.0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk). */
  timeOfDay: number;
  /** World dormancy factor (0.0 = fully active Summer, 1.0 = deep dormant Winter). */
  dormancyFactor: number;
  /** Ambient surface temperature in Celsius. */
  ambientTemperatureC: number;
  /** Relative abundance of forage/vegetation (0.2 in deep winter to 1.25 in spring/summer). */
  forageAbundance: number;
  /** Hydration loss multiplier (hot summer accelerates thirst; cold winter reduces it). */
  hydrationRateMultiplier: number;
  /** Whether the annual mating/rutting season is currently active for ungulates/caprines (Autumn rut). */
  ungulateRutActive: boolean;
  /** Whether spring breeding/nesting season is active (birds, hares, predators). */
  springBreedingActive: boolean;
}

const SEASONS: readonly Season[] = ["spring", "summer", "autumn", "winter"] as const;

/**
 * Calculates the complete macro world cycle state for a given tick.
 * Pure mathematical derivation — deterministic across server and clients.
 */
export function calculateWorldCycle(
  dayClock: DayClock | undefined,
  seasonClock: SeasonClock = DEFAULT_SEASON_CLOCK,
  tick: number,
  tickHz = 30,
): WorldCycleState {
  const secPerDay = dayClock?.seconds ?? seasonClock.secondsPerDay;
  const dayOffset = dayClock?.offset ?? 0;
  const totalDaysExact = seasonClock.offsetDay + dayOffset + tick / (tickHz * secPerDay);
  const dayIndex = Math.floor(totalDaysExact);
  const timeOfDay = ((totalDaysExact % 1) + 1) % 1;

  const daysPerSeason = Math.max(1, seasonClock.daysPerSeason);
  const daysPerYear = daysPerSeason * 4;

  const year = Math.floor(dayIndex / daysPerYear) + 1;
  const dayOfYear = ((dayIndex % daysPerYear) + daysPerYear) % daysPerYear;
  const seasonIndex = Math.floor(dayOfYear / daysPerSeason) % 4;
  const season = SEASONS[seasonIndex]!;
  const dayOfSeason = dayOfYear % daysPerSeason;

  const seasonProgress = (dayOfSeason + timeOfDay) / daysPerSeason;
  const yearProgress = (dayOfYear + timeOfDay) / daysPerYear;

  // Environmental curves across the annual cycle:
  // yearProgress: 0.00 = Spring start, 0.25 = Summer, 0.50 = Autumn, 0.75 = Winter
  // Solar wave: +1.0 at peak summer (0.25), -1.0 at deep winter (0.75)
  const solarPhase = Math.sin(yearProgress * Math.PI * 2);

  // Temperature ranges from -8°C (Winter minimum) to +28°C (Summer peak)
  const meanTemp = 11.0;
  const tempAmplitude = 18.0;
  const diurnalAmplitude = 5.0 * Math.sin((timeOfDay - 0.25) * Math.PI * 2); // Warmest mid-afternoon
  const ambientTemperatureC = Math.round((meanTemp + tempAmplitude * solarPhase + diurnalAmplitude) * 10) / 10;

  // Dormancy factor: 0.0 in summer, smoothly climbing through autumn to 1.0 in winter
  let dormancyFactor = 0.0;
  if (season === "autumn") {
    dormancyFactor = 0.15 + 0.35 * seasonProgress; // 0.15 -> 0.50
  } else if (season === "winter") {
    dormancyFactor = 0.50 + 0.50 * Math.sin(seasonProgress * Math.PI); // Peaks at 1.0 mid-winter
  } else if (season === "spring") {
    dormancyFactor = Math.max(0.0, 0.50 * (1.0 - seasonProgress * 1.5)); // Rapid thaw
  }

  // Forage availability:
  let forageAbundance = 1.0;
  if (season === "spring") {
    forageAbundance = 0.8 + 0.45 * seasonProgress; // 0.8 -> 1.25 fresh sprouts
  } else if (season === "summer") {
    forageAbundance = 1.25;
  } else if (season === "autumn") {
    forageAbundance = 1.2 - 0.5 * seasonProgress; // 1.2 -> 0.7 late harvest
  } else {
    forageAbundance = 0.25; // 0.25 scarce winter browse
  }

  // Hydration demand:
  const hydrationRateMultiplier = Math.max(0.6, 1.0 + (ambientTemperatureC - 15.0) * 0.03);

  // Mating / Rutting schedules:
  // Autumn Rut: Cervids (deer, elk, stag), Caprines (bighorn, sheep, goat), Boars
  const ungulateRutActive = season === "autumn" && seasonProgress >= 0.15 && seasonProgress <= 0.85;

  // Spring Breeding: Small mammals (hares, squirrels), birds, canines
  const springBreedingActive = season === "spring";

  return {
    dayIndex,
    year,
    season,
    dayOfSeason,
    seasonProgress,
    yearProgress,
    timeOfDay,
    dormancyFactor,
    ambientTemperatureC,
    forageAbundance,
    hydrationRateMultiplier,
    ungulateRutActive,
    springBreedingActive,
  };
}
