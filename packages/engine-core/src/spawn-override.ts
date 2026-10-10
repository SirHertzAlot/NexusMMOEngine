/**
 * MMO_SPAWN_OVERRIDE parsing for the world server.
 *
 * The editor's play mode passes the Play menu's "Start from" spawn target
 * as MMO_SPAWN_OVERRIDE="x,z". It takes precedence over the world's stored
 * spawn_point. Malformed or absent values yield null (default spawn wins).
 */

export interface SpawnOverride {
  x: number;
  z: number;
}

/** Parse MMO_SPAWN_OVERRIDE. Returns null when absent or malformed. */
export function parseSpawnOverride(raw: string | undefined): SpawnOverride | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}
