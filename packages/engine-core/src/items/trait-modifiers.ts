/**
 * Pure vein-trait modifier helpers (Redwater Crossing Track A1):
 * project provenance vein traits onto ItemView stats/durability and
 * server-authoritative combat Weapon specs without mutating base definitions.
 */

import type { VeinTraitDef } from "@mmo-engine/rules";
import type { Weapon } from "../combat.js";

/** Projected ItemView stats and durability after applying a vein trait. */
export interface TraitItemViewResult {
  stats: Record<string, number>;
  durability: number;
}

function finiteOrZero(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Resolve a vein trait definition by id; returns undefined when absent or unknown. */
export function resolveTraitById(
  traits: readonly VeinTraitDef[] | ReadonlyMap<string, VeinTraitDef> | null | undefined,
  traitId: string | null | undefined,
): VeinTraitDef | undefined {
  if (!traits || !traitId) return undefined;
  if (traits instanceof Map) return traits.get(traitId);
  if (Array.isArray(traits)) {
    for (let i = 0; i < traits.length; i++) {
      if (traits[i]!.id === traitId) return traits[i];
    }
    return undefined;
  }
  const maybeMap = traits as ReadonlyMap<string, VeinTraitDef>;
  if (typeof maybeMap.get === "function") return maybeMap.get(traitId);
  for (const t of traits as Iterable<VeinTraitDef>) {
    if (t.id === traitId) return t;
  }
  return undefined;
}

/**
 * Apply a vein trait onto an item's ItemView stats and durability.
 * Missing/unknown or `"bog-standard"` traits are exact no-ops; positive base power
 * and durability are floored at 1 even under negative percentages; armour penetration
 * is clamped to [0, 100] and stamina reduction to [0, 50], included only when nonzero.
 */
export function applyTraitToItemViewStats(
  baseStats: Readonly<Record<string, number>>,
  baseDurability: number,
  trait: VeinTraitDef | null | undefined,
): TraitItemViewResult {
  const stats: Record<string, number> = { ...baseStats };
  if (!trait || trait.id === "bog-standard") {
    return { stats, durability: baseDurability };
  }

  const powerPct = finiteOrZero(trait.powerBonusPct);
  const durPct = finiteOrZero(trait.durabilityBonusPct);
  const armourPen = clamp(finiteOrZero(trait.armourPenetrationPct), 0, 100);
  const stamRed = clamp(finiteOrZero(trait.staminaReductionPct), 0, 50);

  if (powerPct !== 0 && typeof stats.power === "number" && Number.isFinite(stats.power) && stats.power > 0) {
    stats.power = Math.max(1, Math.round(stats.power * (1 + powerPct / 100)));
  }

  let durability = baseDurability;
  if (durPct !== 0 && Number.isFinite(baseDurability) && baseDurability > 0) {
    durability = Math.max(1, Math.round(baseDurability * (1 + durPct / 100)));
  }

  if (armourPen > 0) {
    stats.armourPenetrationPct = armourPen;
  }
  if (stamRed > 0) {
    stats.staminaReductionPct = stamRed;
  }

  return { stats, durability };
}

/**
 * Apply a vein trait onto a combat Weapon spec.
 * Scales `weapon.item.mass` by `(1 + powerBonusPct / 100)^(1 / massPower)` so
 * `computeDamage` receives the exact proportional power multiplier, and attaches
 * clamped optional `armourPenetrationPct` ([0, 100]) and `staminaReductionPct` ([0, 50]).
 */
export function applyTraitToWeapon(
  weapon: Weapon,
  trait: VeinTraitDef | null | undefined,
  massPower = 0.5,
): Weapon {
  const copy: Weapon = {
    ...weapon,
    item: { ...weapon.item },
  };
  if (!trait || trait.id === "bog-standard") {
    return copy;
  }

  const powerPct = finiteOrZero(trait.powerBonusPct);
  const armourPen = clamp(finiteOrZero(trait.armourPenetrationPct), 0, 100);
  const stamRed = clamp(finiteOrZero(trait.staminaReductionPct), 0, 50);

  if (powerPct !== 0 && Number.isFinite(copy.item.mass) && copy.item.mass > 0) {
    const safeMassPower = Number.isFinite(massPower) && massPower > 0 ? massPower : 0.5;
    const scale = Math.max(0.01, 1 + powerPct / 100);
    copy.item.mass = copy.item.mass * Math.pow(scale, 1 / safeMassPower);
  }
  if (armourPen > 0) {
    copy.armourPenetrationPct = armourPen;
  }
  if (stamRed > 0) {
    copy.staminaReductionPct = stamRed;
  }

  return copy;
}
