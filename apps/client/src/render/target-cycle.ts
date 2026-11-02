/**
 * Tab targeting (roadmap M5, target selection): the Tab key walks the bodies
 * near the player, nearest first, so a duel partner can be targeted without
 * hovering and clicking the avatar. Pure functions; the world canvas feeds
 * them the mirror's rows and sets the result on the combat feedback.
 */

/** How far Tab reaches, metres. Matches the duel challenge's visible range, not the strike's reach. */
export const TARGET_CYCLE_RANGE_M = 30;

/** A body Tab may select: its wire id and where it stands. */
export interface TargetCandidate {
  wid: bigint;
  x: number;
  z: number;
}

/**
 * The next target after `current`. Candidates within `range` of the player,
 * sorted nearest first; Tab moves to the next one and wraps. With no current
 * target (or one out of range) Tab picks the nearest. Returns null when nothing is in range.
 */
export function nextTarget(
  candidates: readonly TargetCandidate[],
  me: { x: number; z: number } | null,
  current: bigint | null,
  range = TARGET_CYCLE_RANGE_M,
): bigint | null {
  if (me === null) return null;
  const r2 = range * range;
  const inRange = candidates
    .map((c) => ({ wid: c.wid, d2: (c.x - me.x) ** 2 + (c.z - me.z) ** 2 }))
    .filter((c) => c.d2 <= r2)
    .sort((a, b) => a.d2 - b.d2 || (a.wid < b.wid ? -1 : a.wid > b.wid ? 1 : 0));
  if (inRange.length === 0) return null;
  const at = inRange.findIndex((c) => c.wid === current);
  return inRange[at === -1 ? 0 : (at + 1) % inRange.length]!.wid;
}
