/**
 * Pure proximity targeting for civic landmarks (Redwater Crossing sites,
 * settlement foundries, and discovered active mineral veins).
 */

import type { CivicUiState } from "./civic-panel.js";

export type CivicProximityKind = "site" | "foundry" | "vein";

export interface CivicProximityTarget {
  kind: CivicProximityKind;
  id: string;
  labelKey: string;
  actionLabelKey: string;
  distanceM: number;
}

export type CivicProximityState = Pick<CivicUiState, "sites" | "foundries" | "veins">;

export const SITE_PROXIMITY_RADIUS_M = 8;
export const FOUNDRY_PROXIMITY_RADIUS_M = 14;
export const VEIN_PROXIMITY_RADIUS_M = 16;

/**
 * Find the nearest civic landmark within its interaction radius from `(px, pz)`.
 *
 * Radii:
 * - Civic site (`sites`): `<= 8 m`
 * - Settlement foundry (`foundries`): `<= 14 m`
 * - Discovered active mineral vein (`veins` with `stock > 0` and `discoveredAt > 0`): `<= 16 m`
 *
 * Returns `null` when coordinates are non-finite or no landmark is in range.
 */
export function nearestCivicTarget(
  px: number,
  pz: number,
  civicState: CivicProximityState | null | undefined,
): CivicProximityTarget | null {
  if (!Number.isFinite(px) || !Number.isFinite(pz) || !civicState) {
    return null;
  }

  let best: CivicProximityTarget | null = null;
  const consider = (candidate: CivicProximityTarget): void => {
    if (best === null || candidate.distanceM < best.distanceM) {
      best = candidate;
    }
  };

  const sites = Array.isArray(civicState.sites) ? civicState.sites : [];
  for (const s of sites) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z)) continue;
    const distanceM = Math.hypot(s.x - px, s.z - pz);
    if (!Number.isFinite(distanceM) || distanceM > SITE_PROXIMITY_RADIUS_M) continue;
    const actionLabelKey = s.damaged
      ? "civic.promptRepair"
      : s.stage < s.maxStage
        ? "civic.promptContribute"
        : "civic.promptInspect";
    consider({
      kind: "site",
      id: s.siteId,
      labelKey: "civic.landmarkSite",
      actionLabelKey,
      distanceM,
    });
  }

  const foundries = Array.isArray(civicState.foundries) ? civicState.foundries : [];
  for (const f of foundries) {
    if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.z)) continue;
    const distanceM = Math.hypot(f.x - px, f.z - pz);
    if (!Number.isFinite(distanceM) || distanceM > FOUNDRY_PROXIMITY_RADIUS_M) continue;
    consider({
      kind: "foundry",
      id: f.townId,
      labelKey: "civic.landmarkFoundry",
      actionLabelKey: "civic.promptFoundry",
      distanceM,
    });
  }

  const veins = Array.isArray(civicState.veins) ? civicState.veins : [];
  for (const v of veins) {
    if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.z)) continue;
    if (!Number.isFinite(v.stock) || v.stock <= 0) continue;
    if (!Number.isFinite(v.discoveredAt) || v.discoveredAt <= 0) continue;
    const distanceM = Math.hypot(v.x - px, v.z - pz);
    if (!Number.isFinite(distanceM) || distanceM > VEIN_PROXIMITY_RADIUS_M) continue;
    consider({
      kind: "vein",
      id: v.veinBatchId,
      labelKey: "civic.landmarkVein",
      actionLabelKey: "civic.promptExtract",
      distanceM,
    });
  }

  return best;
}

/** Resolve the localized display name for a civic proximity target from state. */
export function civicTargetDisplayName(
  target: CivicProximityTarget,
  civicState: CivicProximityState,
): string {
  if (target.kind === "site") {
    return civicState.sites.find((s) => s.siteId === target.id)?.name ?? target.id;
  }
  if (target.kind === "foundry") {
    return civicState.foundries.find((f) => f.townId === target.id)?.name ?? target.id;
  }
  const vein = civicState.veins.find((v) => v.veinBatchId === target.id);
  return vein ? `${vein.traitName} (${vein.material})` : target.id;
}

export interface WorldPromptCandidate {
  x: number;
  z: number;
}

/**
 * Return `true` when any active standard world interaction target (drop, resource,
 * chest, NPC, or dungeon entrance) is closer to or equidistant with `civicDistanceM`,
 * so civic prompts never steal priority from closer standard world interactions.
 */
export function hasCloserWorldTarget(
  px: number,
  pz: number,
  civicDistanceM: number,
  worldTargets: ReadonlyArray<WorldPromptCandidate | null | undefined>,
): boolean {
  if (!Number.isFinite(px) || !Number.isFinite(pz) || !Number.isFinite(civicDistanceM)) {
    return true;
  }
  for (const target of worldTargets) {
    if (!target) continue;
    if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return true;
    if (Math.hypot(target.x - px, target.z - pz) <= civicDistanceM) {
      return true;
    }
  }
  return false;
}
