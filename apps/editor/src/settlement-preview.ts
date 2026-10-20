/**
 * Browser-safe client for the town generator's rules (content/settlements/rules.json, settlement-host.ts):
 * read, save (checked on the host; a refusal comes back as RulesSaveError with per-path issues) and
 * preview one town built from unsaved rules.
 */

import { requestJson } from "./api.js";
import { RulesSaveError } from "./rules-client.js";
import type { RuleIssueView } from "./rules-tree.js";

/** The land a preview town stands on (settlement-host.ts LAND_PRESETS). */
export type LandPreset = "none" | "forest" | "mountains" | "coast" | "farmland";
export const LAND_PRESET_LABELS: Record<LandPreset, string> = {
  none: "No land (no industry)",
  forest: "Forest",
  mountains: "Mountains",
  coast: "Sea coast",
  farmland: "Farmland",
};

/** One preview town, summed up, with a plan in metres (parcels as squares of their area, resource nodes as points). */
export type SettlementPreview =
  | {
      ok: true;
      rulesVersion: string;
      population: number;
      households: number;
      homeless: number;
      walled: boolean;
      structures: number;
      archetypes: [string, number][];
      industry: { primary: string; workplace: string | null; product: { material: string; tier: number; export: string } | null } | null;
      guild: { profession: string; hasHall: boolean; ranks: string[] } | null;
      resources: { kind: string; material: string; tier: number; nodes: number; stock: number }[];
      gates: { total: number; failed: string[] };
      plan: { parcels: { x: number; z: number; side: number; kind: string }[]; resources: { x: number; z: number; kind: string }[] };
    }
  | { ok: false; error?: string; issues?: RuleIssueView[] };

const URL_RULES = "/api/editor/settlements/rules";
const refused = (issues: RuleIssueView[]): Error => new RulesSaveError(issues);

export async function getSettlementRules(base = ""): Promise<{ content: unknown; missing: boolean }> {
  const body = await requestJson<{ content: unknown; missing?: boolean }>(`${base}${URL_RULES}`, { fail: "town rules read failed", refused });
  return { content: body.content, missing: body.missing ?? false };
}

export const saveSettlementRules = (base = "", content: unknown): Promise<void> =>
  requestJson(`${base}${URL_RULES}`, { method: "PUT", body: { content }, fail: "town rules save failed", refused });

export const previewSettlement = (base = "", content: unknown, population: number, seed: number, land: LandPreset): Promise<SettlementPreview> =>
  requestJson<SettlementPreview>(`${base}/api/editor/settlements/preview`, { method: "POST", body: { content, population, seed, land }, fail: "town preview failed" });
