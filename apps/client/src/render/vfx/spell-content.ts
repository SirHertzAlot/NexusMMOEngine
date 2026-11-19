import type { EffectDefinition, FxTier } from "@mmo-engine/render-fx";
import RAW_VFX_DEFS from "virtual:spell-vfx-defs";
import VFX_BUDGETS from "virtual:vfx-budgets";
import RAW_SPELLS from "virtual:rules-spells";

export interface SpellBarEntry {
  id: string;
  name: string;
  manaCost: number;
  rangeM: number;
  target: "self" | "other" | "any" | "spline";
  elementColor: string;
  vfxAssetId?: string;
}

export const SPELL_VFX_DEFS: readonly EffectDefinition[] = Object.values(
  RAW_VFX_DEFS,
) as unknown as readonly EffectDefinition[];

export const SPELL_BUDGET_SLOTS: Record<string, Partial<Record<FxTier, number>>> =
  (VFX_BUDGETS as { fxSlots?: Record<string, Partial<Record<FxTier, number>>> }).fxSlots ?? {};

const ELEMENT_COLOR_BY_ID: Record<string, string> = {
  blazePath: "#ff5522",
  tidalSurge: "#22aaff",
  quakeLine: "#c49a6c",
  galeSphere: "#b8f7ff",
  tempestArc: "#60a5fa",
  glacialSpike: "#38bdf8",
  aegis: "#26aeff",
  mend: "#4ade80",
  "ember-bolt": "#ff8844",
};

interface RawSpellItem {
  id: string;
  name: string;
  mana: number;
  reach: number;
  target: "self" | "other" | "any" | "spline";
  vfx?: { castAsset?: string; persistentAsset?: string; color?: string };
}

const RAW_SPELL_LIST: readonly RawSpellItem[] = Array.isArray(RAW_SPELLS)
  ? (RAW_SPELLS as RawSpellItem[])
  : ((RAW_SPELLS as { spells?: RawSpellItem[] } | null)?.spells ?? []);

export const SPELL_BAR_ENTRIES: readonly SpellBarEntry[] = RAW_SPELL_LIST.map((s) => ({
  id: s.id,
  name: s.name,
  manaCost: s.mana,
  rangeM: s.reach,
  target: s.target,
  elementColor: s.vfx?.color ?? ELEMENT_COLOR_BY_ID[s.id] ?? "#a855f7",
  vfxAssetId: s.vfx?.persistentAsset ?? s.vfx?.castAsset,
}));
