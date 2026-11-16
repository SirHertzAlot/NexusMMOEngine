/**
 * Damage states (DE1): how worn a breakable looks, from the health it replicates. Pure: no THREE, no state
 * beyond the last health seen per entity.
 *
 * Stage 0 is whole; each threshold the health fraction falls to or under is one stage more (default: cracked at
 * two thirds, battered at one third). A prop that is broken for good is drawn lowered (BROKEN_VARIANT), not here.
 */

/** Health fractions at which a prop looks worse, highest first. */
export const STAGE_THRESHOLDS: readonly number[] = [0.66, 0.33];

/** Colour multiplier per stage (index = stage; the last holds for any worse). */
export const STAGE_BRIGHTNESS: readonly number[] = [1, 0.82, 0.62];

export function damageStage(current: number, max: number, thresholds: readonly number[] = STAGE_THRESHOLDS): number {
  if (!(max > 0) || current >= max) return 0;
  const frac = Math.max(0, current) / max;
  let stage = 0;
  for (const t of thresholds) if (frac <= t) stage++;
  return stage;
}

export function stageBrightness(stage: number, totalStages = STAGE_THRESHOLDS.length): number {
  if (stage <= 0) return 1;
  if (totalStages === 2) return STAGE_BRIGHTNESS[Math.min(stage, STAGE_BRIGHTNESS.length - 1)] ?? 0.62;
  const clamped = Math.min(stage, Math.max(1, totalStages));
  if (totalStages <= 1) return 0.68;
  const u = (clamped - 1) / (totalStages - 1);
  return Math.round((0.86 - 0.32 * u) * 100) / 100;
}

/** Pick per-asset/per-health custom thresholds when the server sent them, else the default 2-stage thresholds. */
export function thresholdsFor(
  stages: Readonly<Record<string, readonly number[]>> | null | undefined,
  assetHash: number | undefined,
  maxHealth: number,
): readonly number[] {
  if (!stages || assetHash === undefined) return STAGE_THRESHOLDS;
  const h = assetHash >>> 0;
  return stages[`${h}:${maxHealth}`] ?? stages[String(h)] ?? STAGE_THRESHOLDS;
}

export interface DamageChange {
  stage: number;
  totalStages: number;
  /** Fraction of max health lost since last seen (0 on first sight, or when it healed). */
  lost: number;
}

/** Remembers each entity's last health so a change can be noticed once. */
export class DamageWatch {
  private readonly last = new Map<bigint, { current: number; stage: number }>();

  /** The change since this entity was last seen, or null when its health did not move (or it is whole and new). */
  observe(wid: bigint, current: number, max: number, thresholds: readonly number[] = STAGE_THRESHOLDS): DamageChange | null {
    const stage = damageStage(current, max, thresholds);
    const totalStages = thresholds.length || STAGE_THRESHOLDS.length;
    const before = this.last.get(wid);
    if (!before) {
      this.last.set(wid, { current, stage });
      return stage === 0 ? null : { stage, totalStages, lost: 0 };
    }
    if (before.current === current) return null;
    this.last.set(wid, { current, stage });
    return { stage, totalStages, lost: current < before.current && max > 0 ? (before.current - current) / max : 0 };
  }

  forget(wid: bigint): void {
    this.last.delete(wid);
  }

  /** Drop entities that are no longer in the world. */
  prune(exists: (wid: bigint) => boolean): void {
    for (const wid of this.last.keys()) if (!exists(wid)) this.last.delete(wid);
  }
}
