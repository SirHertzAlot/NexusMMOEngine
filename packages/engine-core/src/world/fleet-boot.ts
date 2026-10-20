/**
 * Fleet boot planning (persistence P5): which boot mode a shard is
 * in, decided from the environment alone — a pure function so the
 * decision is unit-testable without booting a server.
 *
 * - standalone: no WORLD_URL. No WorldClient is constructed and no
 *   world call is ever made; behaviour is byte-identical to before
 *   the persistence layer.
 * - explicit: WORLD_URL set and REGION_CHUNK_RANGE explicitly set.
 *   Today's fleet path exactly: register with the fixed range,
 *   assignment is never consulted.
 * - assigned: WORLD_URL set and REGION_CHUNK_RANGE not set. The
 *   shard boots UNASSIGNED: it registers with its hostId, the world
 *   assigns a range sized by the host's reported resources, and the
 *   lease carries the range + epoch the P3 recall then runs for.
 */
import * as os from "node:os";
import type { ChunkRange } from "@mmo-engine/world-server";

export type FleetBootPlan =
  | { mode: "standalone" }
  | { mode: "explicit"; chunkRange: ChunkRange }
  | { mode: "assigned"; hostId: string };

export interface FleetBootEnv {
  WORLD_URL?: string;
  REGION_CHUNK_RANGE?: string;
  MMO_HOST_ID?: string;
}

/** "x0,z0,x1,z1" (the REGION_CHUNK_RANGE convention) as a ChunkRange. */
export function parseChunkRangeEnv(raw: string): ChunkRange {
  const [x0, z0, x1, z1] = raw.split(",").map(Number);
  return { x0, x1, z0, z1 };
}

/** The engine's long-standing default world extent (explicit-mode default before P5). */
export const DEFAULT_CHUNK_RANGE: ChunkRange = {
  x0: 0,
  x1: 4096,
  z0: 0,
  z1: 4096,
};

export function planFleetBoot(
  env: FleetBootEnv,
  hostname: string = os.hostname(),
): FleetBootPlan {
  if (!env.WORLD_URL) return { mode: "standalone" };
  if (env.REGION_CHUNK_RANGE !== undefined) {
    return {
      mode: "explicit",
      chunkRange: parseChunkRangeEnv(env.REGION_CHUNK_RANGE),
    };
  }
  const hostId = env.MMO_HOST_ID?.trim() ? env.MMO_HOST_ID.trim() : hostname;
  return { mode: "assigned", hostId };
}
