/**
 * Track C6 — Mature-Town Foundry Pivot & Masterwork Repair/Reforge helpers.
 *
 * Pure deterministic rules evaluators for:
 * - Foundry maturity (`depletedPermille >= maturityThresholdPermille`)
 * - Reforging an owned item's existing provenance trait using the foundry's
 *   active specialization or the masterwork trait
 * - Repair-kit crafting cost validation and repair-kit efficiency bonus math on
 *   damaged civic infrastructure contributions (with strict overshoot clamping)
 */

import type { CivicFoundryDef, VeinTraitDef } from "@mmo-engine/rules";
import type { StoredFoundry } from "./civic-store.js";

export const REPAIR_KIT_MATERIAL_ID = "repair-kit";
export const MASTERWORK_TRAIT_ID = "masterwork";
export const REPAIR_KIT_EFFICIENCY_MULTIPLIER = 2;

/** True once local ore extraction has pushed the foundry to or past its maturity threshold. */
export function isFoundryMature(
  foundry: Pick<StoredFoundry, "depletedPermille">,
  def: Pick<CivicFoundryDef, "maturityThresholdPermille">,
): boolean {
  return foundry.depletedPermille >= def.maturityThresholdPermille;
}

export type ReforgeTraitResolution =
  | { ok: true; traitId: string; usedActiveSpecialty: boolean }
  | { ok: false; code: string; message: string };

/**
 * Resolve the target trait when reforging an item at a mature, specialized foundry.
 * - Prefers the foundry's active non-baseline specialization if the item does not already carry it.
 * - Falls back to promoting to `"masterwork"` when the item already matches the active specialty
 *   (or when the foundry was activated on baseline ore), provided `"masterwork"` exists in rules.
 */
export function resolveReforgeTargetTrait(
  existingTraitId: string,
  activeTraitId: string,
  traits: readonly VeinTraitDef[],
): ReforgeTraitResolution {
  if (existingTraitId === MASTERWORK_TRAIT_ID) {
    return {
      ok: false,
      code: "already_upgraded",
      message: "item already carries the highest available temper for this foundry",
    };
  }
  const hasMasterwork = traits.some((t) => t.id === MASTERWORK_TRAIT_ID);
  if (activeTraitId !== "bog-standard" && existingTraitId !== activeTraitId) {
    if (traits.some((t) => t.id === activeTraitId)) {
      return { ok: true, traitId: activeTraitId, usedActiveSpecialty: true };
    }
  }
  if (hasMasterwork) {
    return { ok: true, traitId: MASTERWORK_TRAIT_ID, usedActiveSpecialty: false };
  }
  return {
    ok: false,
    code: "already_upgraded",
    message: "item already carries the highest available temper for this foundry",
  };
}

export interface RepairContributionPlan {
  /** Exact clamped quantities debited from the contributor's pouch (includes `"repair-kit"` if used). */
  acceptedMaterials: Record<string, number>;
  /** Exact progress deltas applied to `site.repairProgress` (material keys from `repairNeed.materials`). */
  repairProgressDelta: Record<string, number>;
  /** Number of `"repair-kit"` units accepted and converted into bonus repair progress. */
  repairKitsUsed: number;
}

/**
 * Compute repair contribution deltas with `"repair-kit"` efficiency bonuses and
 * strict overshoot clamping across both repair kits and raw materials.
 */
export function planRepairContributionWithKits(
  offerMats: Readonly<Record<string, number>>,
  repairNeedMaterials: Readonly<Record<string, number>>,
  repairKitCost: Readonly<Record<string, number>> = { iron: 2, wood: 2 },
): RepairContributionPlan {
  const remaining: Record<string, number> = {};
  let totalMaterialNeed = 0;
  for (const [mat, need] of Object.entries(repairNeedMaterials)) {
    if (need > 0) {
      remaining[mat] = need;
      totalMaterialNeed += need;
    }
  }

  const acceptedMaterials: Record<string, number> = {};
  const repairProgressDelta: Record<string, number> = {};
  let repairKitsUsed = 0;

  const offeredKits = Math.max(0, Math.trunc(offerMats[REPAIR_KIT_MATERIAL_ID] ?? 0));
  if (offeredKits > 0 && totalMaterialNeed > 0) {
    const kitBaseUnits = Object.values(repairKitCost).reduce((a, b) => a + Math.max(0, b), 0);
    const kitEfficiencyUnits = Math.max(4, kitBaseUnits * REPAIR_KIT_EFFICIENCY_MULTIPLIER);
    const maxUsefulKits = Math.ceil(totalMaterialNeed / kitEfficiencyUnits);
    repairKitsUsed = Math.min(offeredKits, maxUsefulKits);

    if (repairKitsUsed > 0) {
      acceptedMaterials[REPAIR_KIT_MATERIAL_ID] = repairKitsUsed;
      let creditLeft = repairKitsUsed * kitEfficiencyUnits;

      // Distribute repair-kit progress deterministically: repairKitCost keys first, then sorted remaining keys.
      const preferredKeys = Object.keys(repairKitCost);
      const otherKeys = Object.keys(remaining)
        .filter((k) => !(k in repairKitCost))
        .sort();
      const orderedKeys = [...preferredKeys, ...otherKeys];

      for (const mat of orderedKeys) {
        if (creditLeft <= 0) break;
        const need = remaining[mat] ?? 0;
        if (need <= 0) continue;
        const apply = Math.min(need, creditLeft);
        repairProgressDelta[mat] = (repairProgressDelta[mat] ?? 0) + apply;
        remaining[mat] = need - apply;
        creditLeft -= apply;
      }
    }
  }

  // Clamp all normal repair materials against whatever material deficit remains after repair kits.
  for (const [mat, rawQty] of Object.entries(offerMats)) {
    if (mat === REPAIR_KIT_MATERIAL_ID) continue;
    const qty = Math.trunc(rawQty);
    const need = remaining[mat] ?? 0;
    if (need > 0 && qty > 0) {
      const take = Math.min(qty, need);
      acceptedMaterials[mat] = take;
      repairProgressDelta[mat] = (repairProgressDelta[mat] ?? 0) + take;
      remaining[mat] = need - take;
    }
  }

  return {
    acceptedMaterials,
    repairProgressDelta,
    repairKitsUsed,
  };
}
