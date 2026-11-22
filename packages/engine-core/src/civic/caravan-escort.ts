/**
 * Track C5 — Caravan Escort Synergy & Bounded Risk Window Coordinator.
 *
 * Evaluates heavy bridge hauls (`qty > 5` across `requiresBridgeId`) and heavy
 * frontier contract deliveries (`qty > 5`):
 * - Enforces a per-character cooldown to prevent cooldown farming.
 * - Enforces a capped ambush spawn window via optional `onEscortAmbush(siteId, x, z, charId)`.
 * - Awards bounded `escortBonusGold` when verified nearby party/escort helpers
 *   (`nearbyEscortCount > 0`) assist, guarded against self-escort exploits.
 */

export const HEAVY_HAUL_THRESHOLD = 5;
export const DEFAULT_ESCORT_RADIUS_M = 24;
export const DEFAULT_ESCORT_COOLDOWN_MS = 60_000;
export const DEFAULT_AMBUSH_WINDOW_MS = 120_000;
export const DEFAULT_MAX_AMBUSHES_PER_WINDOW = 3;
export const DEFAULT_MAX_ESCORT_HELPERS = 3;
export const DEFAULT_BASE_ESCORT_BONUS_GOLD = 6;
export const DEFAULT_PER_EXTRA_ESCORT_GOLD = 4;
export const DEFAULT_MAX_ESCORT_BONUS_GOLD = 25;

export interface CaravanEscortOptions {
  heavyHaulThreshold?: number;
  escortRadiusM?: number;
  cooldownMs?: number;
  ambushWindowMs?: number;
  maxAmbushesPerWindow?: number;
  maxEscortHelpers?: number;
  baseBonusGold?: number;
  perExtraEscortGold?: number;
  maxBonusGold?: number;
  onEscortAmbush?: (siteId: string, x: number, z: number, charId: number) => void;
}

export interface EscortEvaluationInput {
  charId: number;
  siteId: string;
  x: number;
  z: number;
  qty: number;
  nearbyEscortCount: number;
  nowMs: number;
}

export interface EscortEvaluationResult {
  triggered: boolean;
  ambushSpawned: boolean;
  escortBonusGold: number;
  reason: "below_heavy_qty" | "cooldown" | "evaluated";
}

export interface EscortParticipant {
  characterId: number | null;
  entity(): number;
}

/**
 * Count distinct, alive, non-self escort helpers standing within `radiusM` of `(x, z)`.
 * Guards against self-escort (never counts `haulerCharId`) and duplicate character entries.
 */
export function countNearbyEscorts(
  haulerCharId: number,
  x: number,
  z: number,
  radiusM: number,
  participants: Iterable<EscortParticipant>,
  pxOf: ArrayLike<number>,
  pzOf: ArrayLike<number>,
  isAlive: (eid: number) => boolean,
  maxCount = DEFAULT_MAX_ESCORT_HELPERS,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radiusM) || radiusM <= 0) {
    return 0;
  }
  const seenChars = new Set<number>();
  const rSq = radiusM * radiusM;
  let count = 0;

  for (const p of participants) {
    const otherId = p.characterId;
    if (otherId === null || otherId === haulerCharId || seenChars.has(otherId)) continue;
    const eid = p.entity();
    if (eid < 0 || !isAlive(eid)) continue;
    const ox = pxOf[eid] ?? NaN;
    const oz = pzOf[eid] ?? NaN;
    if (!Number.isFinite(ox) || !Number.isFinite(oz)) continue;
    const dx = ox - x;
    const dz = oz - z;
    if (dx * dx + dz * dz <= rSq) {
      seenChars.add(otherId);
      count++;
      if (count >= maxCount) break;
    }
  }
  return count;
}

/** Bounded stateful evaluator for heavy caravan escort risks and helper gold payouts. */
export class CaravanEscortCoordinator {
  readonly heavyHaulThreshold: number;
  readonly escortRadiusM: number;
  readonly cooldownMs: number;
  readonly ambushWindowMs: number;
  readonly maxAmbushesPerWindow: number;
  readonly maxEscortHelpers: number;
  readonly baseBonusGold: number;
  readonly perExtraEscortGold: number;
  readonly maxBonusGold: number;
  private readonly onEscortAmbush?: (siteId: string, x: number, z: number, charId: number) => void;

  private readonly lastTriggerByChar = new Map<number, number>();
  private readonly ambushTimestamps: number[] = [];

  constructor(opts: CaravanEscortOptions = {}) {
    this.heavyHaulThreshold = Math.max(1, Math.trunc(opts.heavyHaulThreshold ?? HEAVY_HAUL_THRESHOLD));
    this.escortRadiusM = Math.max(1, opts.escortRadiusM ?? DEFAULT_ESCORT_RADIUS_M);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_ESCORT_COOLDOWN_MS);
    this.ambushWindowMs = Math.max(1, opts.ambushWindowMs ?? DEFAULT_AMBUSH_WINDOW_MS);
    this.maxAmbushesPerWindow = Math.max(0, Math.trunc(opts.maxAmbushesPerWindow ?? DEFAULT_MAX_AMBUSHES_PER_WINDOW));
    this.maxEscortHelpers = Math.max(1, Math.trunc(opts.maxEscortHelpers ?? DEFAULT_MAX_ESCORT_HELPERS));
    this.baseBonusGold = Math.max(0, Math.trunc(opts.baseBonusGold ?? DEFAULT_BASE_ESCORT_BONUS_GOLD));
    this.perExtraEscortGold = Math.max(0, Math.trunc(opts.perExtraEscortGold ?? DEFAULT_PER_EXTRA_ESCORT_GOLD));
    this.maxBonusGold = Math.max(0, Math.trunc(opts.maxBonusGold ?? DEFAULT_MAX_ESCORT_BONUS_GOLD));
    this.onEscortAmbush = opts.onEscortAmbush;
  }

  /** Evaluate heavy haul escort risk window, ambush spawn cap, and bounded helper gold payout. */
  evaluate(input: EscortEvaluationInput): EscortEvaluationResult {
    if (!Number.isFinite(input.qty) || input.qty <= this.heavyHaulThreshold) {
      return { triggered: false, ambushSpawned: false, escortBonusGold: 0, reason: "below_heavy_qty" };
    }
    if (!Number.isFinite(input.nowMs)) {
      return { triggered: false, ambushSpawned: false, escortBonusGold: 0, reason: "cooldown" };
    }

    const prev = this.lastTriggerByChar.get(input.charId) ?? -Infinity;
    if (input.nowMs - prev < this.cooldownMs) {
      return { triggered: false, ambushSpawned: false, escortBonusGold: 0, reason: "cooldown" };
    }
    this.lastTriggerByChar.set(input.charId, input.nowMs);

    // Bounded retention of per-character cooldown history.
    if (this.lastTriggerByChar.size > 4096) {
      const cutoff = input.nowMs - this.cooldownMs;
      for (const [cid, ts] of this.lastTriggerByChar) {
        if (ts < cutoff) this.lastTriggerByChar.delete(cid);
      }
    }

    // Prune expired ambush timestamps and enforce global window spawn cap.
    const windowCutoff = input.nowMs - this.ambushWindowMs;
    while (this.ambushTimestamps.length > 0 && this.ambushTimestamps[0]! <= windowCutoff) {
      this.ambushTimestamps.shift();
    }

    let ambushSpawned = false;
    if (this.onEscortAmbush && this.ambushTimestamps.length < this.maxAmbushesPerWindow) {
      this.ambushTimestamps.push(input.nowMs);
      this.onEscortAmbush(input.siteId, input.x, input.z, input.charId);
      ambushSpawned = true;
    }

    const validEscorts = Number.isFinite(input.nearbyEscortCount)
      ? Math.max(0, Math.min(this.maxEscortHelpers, Math.trunc(input.nearbyEscortCount)))
      : 0;

    let escortBonusGold = 0;
    if (validEscorts > 0 && this.maxBonusGold > 0) {
      const qtyScale = Math.min(8, Math.floor((input.qty - this.heavyHaulThreshold) / 5) * 2);
      const rawBonus = this.baseBonusGold + (validEscorts - 1) * this.perExtraEscortGold + qtyScale;
      escortBonusGold = Math.min(this.maxBonusGold, Math.max(1, rawBonus));
    }

    return {
      triggered: true,
      ambushSpawned,
      escortBonusGold,
      reason: "evaluated",
    };
  }
}
