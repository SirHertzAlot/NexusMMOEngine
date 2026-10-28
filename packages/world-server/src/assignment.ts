/**
 * Chunk assignment policy (persistence P5): a narrow, swappable,
 * pure function behind an interface — host reports + total world
 * chunk space + live leases in, one chunk range out. The world core
 * owns everything around it (auth, freshness filtering, epoch
 * issuance, overlap enforcement); swapping the sizing strategy means
 * replacing this module's implementation, never touching the core
 * op or the store.
 *
 * The default policy is deliberately simple and deterministic —
 * same inputs, same assignment, no clocks, no randomness:
 *
 * - Weight: a host's weight is cpuCores × RAM in GiB, so a host that
 *   is bigger on either axis outweighs a smaller one on both.
 * - Partitioning: assignments are vertical strips — the requesting
 *   host's share of the total X width (its weight over the summed
 *   weights of every reported host), spanning the space's full Z
 *   depth, carved from the lowest-x free interval that fits it (or
 *   the largest free interval when none fits the full share).
 * - Exclusion: a live lease's X span is never carved into — free
 *   intervals are the complement of live ranges' X projections, so
 *   a range held by a live lease can never be double-assigned.
 */
import type {
  AssignmentPolicyInput,
  ChunkRange,
  HostResourceReport,
} from "./types.js";

export interface ChunkAssignmentPolicy {
  /**
   * The range for a shard on `hostId`, or null when no chunk space
   * is free. `input.hostReports` carries fresh reports only (the
   * core filters staleness); when the requesting host has no report
   * it is weighted at FALLBACK_WEIGHT (a shard whose sidecar is down
   * still boots — with the smallest share).
   */
  assign(hostId: string, input: AssignmentPolicyInput): ChunkRange | null;
}

/** Weight of a host with no fresh report (see ChunkAssignmentPolicy). */
export const FALLBACK_WEIGHT = 1;

const GIB = 1024 * 1024 * 1024;

/** A host's assignment weight: cpuCores × RAM in GiB (always > 0 for a valid report). */
export function hostWeight(report: HostResourceReport): number {
  return report.cpuCores * (report.ramTotalBytes / GIB);
}

interface Interval {
  x0: number;
  x1: number;
}

/** The free X intervals of the space: its X span minus live ranges' X projections, merged and sorted. */
function freeIntervals(
  space: ChunkRange,
  liveLeases: AssignmentPolicyInput["liveLeases"],
): Interval[] {
  const blocked = liveLeases
    .map((l) => ({
      x0: Math.max(l.chunkRange.x0, space.x0),
      x1: Math.min(l.chunkRange.x1, space.x1),
    }))
    .filter((i) => i.x1 > i.x0)
    .sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);
  const free: Interval[] = [];
  let cursor = space.x0;
  for (const b of blocked) {
    if (b.x0 > cursor) free.push({ x0: cursor, x1: b.x0 });
    if (b.x1 > cursor) cursor = b.x1;
  }
  if (cursor < space.x1) free.push({ x0: cursor, x1: space.x1 });
  return free;
}

export class DefaultChunkAssignmentPolicy implements ChunkAssignmentPolicy {
  assign(hostId: string, input: AssignmentPolicyInput): ChunkRange | null {
    const space = input.totalWorldChunkSpace;
    const totalWidth = space.x1 - space.x0;
    if (totalWidth <= 0 || space.z1 - space.z0 <= 0) return null;

    // Sorted by hostId so the weight sum's float order is stable:
    // identical inputs (in any order) yield identical assignments.
    const reports = [...input.hostReports].sort((a, b) =>
      a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0,
    );
    let totalWeight = 0;
    let ownWeight: number | null = null;
    for (const r of reports) {
      const w = hostWeight(r);
      totalWeight += w;
      if (r.hostId === hostId) ownWeight = w;
    }
    if (ownWeight === null) {
      ownWeight = FALLBACK_WEIGHT;
      totalWeight += FALLBACK_WEIGHT;
    }
    const targetWidth = Math.min(
      totalWidth,
      Math.max(1, Math.round(totalWidth * (ownWeight / totalWeight))),
    );

    const free = freeIntervals(space, input.liveLeases);
    if (free.length === 0) return null;
    // The lowest-x free interval that fits the full share wins; when
    // none fits, the largest free interval is assigned whole (ties
    // break to the lowest x) rather than failing the boot.
    const fitting = free.find((i) => i.x1 - i.x0 >= targetWidth);
    if (fitting) {
      return {
        x0: fitting.x0,
        x1: fitting.x0 + targetWidth,
        z0: space.z0,
        z1: space.z1,
      };
    }
    let largest = free[0];
    for (const i of free) {
      if (i.x1 - i.x0 > largest.x1 - largest.x0) largest = i;
    }
    return { x0: largest.x0, x1: largest.x1, z0: space.z0, z1: space.z1 };
  }
}
