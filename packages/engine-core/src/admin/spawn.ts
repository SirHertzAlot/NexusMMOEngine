/**
 * Spawning (roadmap A3): plant a spawn-table archetype as a live entity,
 * and remove entities again. Props and archetypes only — creatures need
 * a shared spawner with the bot/character systems first (noted in the
 * roadmap row), and cursor targeting waits for the E4 overlays, so
 * placement is at the caller's avatar or at explicit x/z.
 */

import { z } from "zod";
import { fnv1a32, type EntitySpawn, type SpawnTable } from "@mmo-engine/scatter";

export const SpawnArgsSchema = z
  .object({
    /** Spawn-table asset id (see `spawnlist`). */
    asset: z.string().min(1).max(128),
    /** World x/z; defaults to the caller's avatar. */
    x: z.number().finite().optional(),
    z: z.number().finite().optional(),
    /** Facing, radians about +Y. */
    yaw: z.number().finite().optional(),
  })
  .strict();

export type SpawnArgs = z.infer<typeof SpawnArgsSchema>;

export const DespawnArgsSchema = z
  .object({
    entity: z.string().min(1).max(32),
  })
  .strict();

export type DespawnArgs = z.infer<typeof DespawnArgsSchema>;

/** Archetype names the table offers, sorted (for `spawnlist`). */
export function listAssets(table: SpawnTable): string[] {
  return Object.keys(table.archetypes).sort();
}

/**
 * Build the EntitySpawn for one asset at (x, y, z). Unknown assets read
 * as an error string, never throw (the gateway answers 4003 with it).
 */
export function buildSpawn(
  table: SpawnTable,
  asset: string,
  x: number,
  y: number,
  z: number,
  yaw: number,
): EntitySpawn | { error: string } {
  const archetype = table.archetypes[asset];
  if (!archetype) return { error: `unknown asset ${JSON.stringify(asset)} (see spawnlist)` };
  return {
    x, y, z, yaw, pitch: 0, roll: 0,
    sx: 1, sy: 1, sz: 1,
    assetId: asset,
    assetHash: fnv1a32(asset),
    variant: 0,
    seed: (Math.floor(x * 13 + z * 71 + yaw * 7) >>> 0) || 1,
    archetype,
  };
}
