/**
 * Civic logistics, dynamic surveying, settlement foundry specialization,
 * escrow work-order contracts, and item provenance messages (0x11 `kind: "civic"`).
 *
 * All game state lives authoritatively on the server; these are wire views and
 * Zod-validated player intents. Never leak un-surveyed vein coordinates or
 * private admin data on public views.
 */

import type { ItemProvenanceView } from "./items.js";

export type SurveyBand = "none" | "faint" | "warm" | "hot" | "pinpoint";
export type SurveyDirection = "here" | "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export interface CivicSiteStageView {
  stage: number;
  label: string;
  requirements: Record<string, number>;
  goldCost: number;
}

export interface CivicSiteView {
  siteId: string;
  name: string;
  kind: "bridge" | "crossing" | "monument";
  x: number;
  z: number;
  stage: number;
  maxStage: number;
  damaged: boolean;
  wear: number;
  wearMax: number;
  eraTag: string;
  progress: Record<string, number>;
  goldProgress: number;
  nextRequirements: Record<string, number>;
  nextGoldCost: number;
  repairRequirements: Record<string, number>;
  repairGoldCost: number;
  heavyHaulAllowed: boolean;
  totalContributors: number;
}

export interface CivicVeinView {
  veinBatchId: string;
  templateId: string;
  traitId: string;
  traitName: string;
  material: string;
  x: number;
  z: number;
  stock: number;
  maxStock: number;
  discoveredAt: number;
}

export interface CivicFoundryView {
  townId: string;
  name: string;
  x: number;
  z: number;
  activeTraitId: string;
  traitName: string;
  activeVeinBatchId: string | null;
  batchesRemaining: number;
  expiresAt: number | null;
  oreBuffer: Record<string, number>;
  activationThreshold: number;
  depletedPermille: number;
  mature: boolean;
  reforgeGoldCost?: number;
  repairKitCost?: Record<string, number>;
  craftBonusSummary: string;
}

export interface CivicContractView {
  contractId: string;
  posterId: number;
  posterName: string;
  targetKind: "site" | "foundry";
  targetId: string;
  material: string;
  totalQty: number;
  deliveredQty: number;
  rewardPerUnit: number;
  status: "open" | "filled" | "cancelled" | "expired";
  createdAt: number;
  expiresAt: number;
}

export interface CivicContributorView {
  characterId: number;
  characterName: string;
  rawScore: number;
  effectiveWeight: number;
}

export interface CivicHistoryEntryView {
  seq: number;
  siteId: string;
  eventType: "contributed" | "stage_advanced" | "damaged" | "repaired" | "foundry_specialized" | "era_shift" | "admin_override";
  actorId: number;
  actorName: string;
  eraTag: string;
  detail: string;
  createdAt: number;
}

export type CivicClientMessage =
  | { kind: "civic"; op: "state" }
  | { kind: "civic"; op: "survey" }
  | { kind: "civic"; op: "extract"; veinBatchId: string; qty?: number }
  | { kind: "civic"; op: "contribute"; siteId: string; opId: string; materials?: Record<string, number>; gold?: number }
  | { kind: "civic"; op: "plaque"; siteId: string; offset?: number; limit?: number }
  | { kind: "civic"; op: "foundry_supply"; townId: string; opId: string; veinBatchId: string; material: string; qty: number }
  | { kind: "civic"; op: "foundry_craft"; townId: string; opId: string; item: string; rank: string }
  | { kind: "civic"; op: "foundry_reforge"; townId: string; opId: string; itemId: number }
  | { kind: "civic"; op: "craft_repair_kit"; townId: string; opId: string }
  | { kind: "civic"; op: "contract_post"; opId: string; targetKind: "site" | "foundry"; targetId: string; material: string; qty: number; rewardPerUnit: number; ttlHours?: number }
  | { kind: "civic"; op: "contract_deliver"; opId: string; contractId: string; qty: number }
  | { kind: "civic"; op: "contract_cancel"; opId: string; contractId: string };

export type CivicServerMessage =
  | {
      kind: "civic";
      op: "state";
      tick: number;
      sites: CivicSiteView[];
      veins: CivicVeinView[];
      foundries: CivicFoundryView[];
      contracts: CivicContractView[];
      pendingCreditsClaimed: number;
    }
  | {
      kind: "civic";
      op: "survey_result";
      band: SurveyBand;
      direction: SurveyDirection;
      distanceBucketM: number;
      veinBatchId?: string;
      traitId?: string;
      traitName?: string;
      material?: string;
      stockRemaining?: number;
      newlyDiscovered?: boolean;
    }
  | {
      kind: "civic";
      op: "extracted";
      veinBatchId: string;
      traitId: string;
      material: string;
      qty: number;
      stockRemaining: number;
    }
  | {
      kind: "civic";
      op: "contributed";
      siteId: string;
      opId: string;
      acceptedMaterials: Record<string, number>;
      acceptedGold: number;
      stage: number;
      damaged: boolean;
      wear: number;
      stageAdvanced: boolean;
      repaired: boolean;
      eraTag: string;
      repairKitsUsed?: number;
      replayed: boolean;
    }
  | {
      kind: "civic";
      op: "plaque";
      siteId: string;
      siteName: string;
      stage: number;
      damaged: boolean;
      wear: number;
      eraTag: string;
      totalContributors: number;
      contributors: CivicContributorView[];
      history: CivicHistoryEntryView[];
      offset: number;
      limit: number;
      totalHistory: number;
    }
  | {
      kind: "civic";
      op: "foundry_updated";
      opId: string;
      foundry: CivicFoundryView;
      specialized: boolean;
      escortBonusGold?: number;
      replayed: boolean;
    }
  | {
      kind: "civic";
      op: "foundry_crafted";
      opId: string;
      townId: string;
      item: string;
      rank: string;
      itemId: number;
      provenance: ItemProvenanceView;
      foundry: CivicFoundryView;
      replayed: boolean;
    }
  | {
      kind: "civic";
      op: "foundry_reforge";
      opId: string;
      townId: string;
      itemId: number;
      provenance: ItemProvenanceView;
      goldCost: number;
      foundry: CivicFoundryView;
      replayed: boolean;
    }
  | {
      kind: "civic";
      op: "craft_repair_kit";
      opId: string;
      townId: string;
      qty: number;
      consumedMaterials: Record<string, number>;
      foundry: CivicFoundryView;
      replayed: boolean;
    }
  | {
      kind: "civic";
      op: "contract_update";
      opId: string;
      action: "posted" | "delivered" | "cancelled";
      contract: CivicContractView;
      acceptedQty?: number;
      payoutGold?: number;
      escortBonusGold?: number;
      refundedGold?: number;
      replayed: boolean;
    }
  | {
      kind: "civic";
      op: "notice";
      ok: boolean;
      code: string;
      message: string;
      opId?: string;
    };
