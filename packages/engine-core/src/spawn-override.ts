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
  // Number("") is 0, so an empty half (" ,5") would spawn at x = 0.
  if (parts.length !== 2 || parts.some((p) => p === "")) return null;
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

/**
 * Keep a spawn point inside a baked world's chunk range, so a camera
 * parked past the edge does not spawn the player off the world.
 */
export function clampSpawn(
  spawn: SpawnOverride,
  minChunk: number,
  maxChunk: number,
  chunkSize: number,
): SpawnOverride {
  const lo = minChunk * chunkSize;
  // Just inside the last chunk: (maxChunk + 1) * size is the next chunk's edge.
  const hi = (maxChunk + 1) * chunkSize - 0.001;
  const clamp = (v: number): number => Math.min(hi, Math.max(lo, v));
  return { x: clamp(spawn.x), z: clamp(spawn.z) };
}
