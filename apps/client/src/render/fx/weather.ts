/**
 * Weather: what falls from the sky where the camera is, decided the same
 * way on every client (no messages): by the biome under the camera and the
 * world tick. Time is cut into spells (`spellMinutes`); in each spell each
 * biome's weather is on or off by a hash of the spell and the biome, so it
 * rains in the rainforest more often than on the plains, and everyone in
 * the same place sees the same shower start and stop.
 *
 * The rules live in particles.json (the `biomes` table), so a game tunes
 * them without code.
 */

import type { WeatherOverride, WorldMap } from "@mmo-engine/protocol";

export type WeatherKind = "snow" | "rain" | "ash";

export interface WeatherRules {
  /** Biome id -> what falls there, and the share of spells it falls in (0..1). */
  biomes: Record<string, { kind: WeatherKind; chance: number }>;
  /** Length of a weather spell, real minutes. */
  spellMinutes: number;
}

export interface Weather {
  kind: WeatherKind | null;
  /** 0..1 (the renderer fades toward it). */
  intensity: number;
  /**
   * Prevailing wind, unit XZ. The particle system emits upwind of the camera
   * by a few metres, so precipitation visibly slants downwind.
   */
  windX?: number;
  windZ?: number;
}

/** FNV-1a over a string: a stable 0..1 roll per (spell, biome). */
function roll(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * The weather in `biome` at a server tick, or the server's forced sky:
 * a forced kind falls at full intensity, forced clear falls nothing.
 */
export function weatherAt(
  rules: WeatherRules,
  biome: string | null,
  tick: number,
  tickHz: number,
  override: WeatherOverride = "auto",
): Weather {
  if (override === "clear") return { kind: null, intensity: 0 };
  if (override !== "auto") return { kind: override, intensity: 1 };
  const rule = biome ? rules.biomes[biome] : undefined;
  if (!rule) return { kind: null, intensity: 0 };
  const spell = Math.floor(tick / tickHz / (rules.spellMinutes * 60));
  const on = roll(`${spell}:${biome}`) < rule.chance;
  return on ? { kind: rule.kind, intensity: 1 } : { kind: rule.kind, intensity: 0 };
}

/** The biome id under world (x, z) from the map (nearest cell), or null outside it. */
export function biomeAt(map: WorldMap, x: number, z: number): string | null {
  const u = Math.round((x - map.originX) / map.cell);
  const v = Math.round((z - map.originZ) / map.cell);
  if (u < 0 || v < 0 || u >= map.width || v >= map.depth) return null;
  return map.biomes[map.biome[v * map.width + u]] ?? null;
}
