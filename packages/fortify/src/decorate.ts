/**
 * The decoration pass — a stub in the style-profile shape.
 *
 * Fortify decides form and placement; decoration decides what it looks
 * like: materials, proportions, dressing. It runs downstream of the
 * emitter and only *attaches* decoration to placements — it never
 * moves or removes a structure. The profile shape mirrors the
 * style-driven procgen pipeline (`style-profile.json`: materials +
 * proportions per family), so when the corpus-derived profiles land,
 * they feed this same function.
 *
 * Era material tiers carry the Roman Short's other axis — earth →
 * turf → timber → stone — as data: an era's tier overrides the
 * profile's wall/tower materials, because a culture's *available*
 * materials are a fact of its century, not its taste.
 */

import type { SettlementBake, StructureKind } from "./emit.js";

export interface StyleProfile {
  id: string;
  materials: { wall: string; tower: string; gate: string; roof: string; earthwork: string };
  proportions: { wallHeightM: number; towerHeightM: number; keepHeightM: number };
  dressing: string[];
}

/** Material tier per era: what the century builds with. */
export const ERA_MATERIALS: Record<number, { wall: string; tower: string }> = {
  1: { wall: "turf-and-timber", tower: "timber" },
  2: { wall: "stone", tower: "stone" },
  3: { wall: "ashlar-stone", tower: "ashlar-stone" },
};

export const DEFAULT_PROFILES: Record<string, StyleProfile> = {
  pondlands: {
    id: "pondlands",
    materials: { wall: "stone", tower: "stone", gate: "oak-and-iron", roof: "thatch", earthwork: "pond-mud" },
    proportions: { wallHeightM: 6, towerHeightM: 9, keepHeightM: 11 },
    dressing: ["banner", "torch-sconce"],
  },
  roman: {
    id: "roman",
    materials: { wall: "stone", tower: "stone", gate: "timber-and-iron", roof: "tile", earthwork: "spoil" },
    proportions: { wallHeightM: 5, towerHeightM: 8, keepHeightM: 7 },
    dressing: ["red-banner"],
  },
};

const HEIGHTS = (p: StyleProfile): Partial<Record<StructureKind, number>> => ({
  "wall-run": p.proportions.wallHeightM,
  tower: p.proportions.towerHeightM,
  keep: p.proportions.keepHeightM,
  gate: p.proportions.wallHeightM,
  barbican: p.proportions.wallHeightM * 0.8,
  well: 1.2,
  granary: 3.5,
  moat: 0,
  "lilia-field": 0,
});

const MATERIAL_FOR = (p: StyleProfile, eraTier: { wall: string; tower: string } | undefined): Record<StructureKind, string> => ({
  "wall-run": eraTier?.wall ?? p.materials.wall,
  tower: eraTier?.tower ?? p.materials.tower,
  gate: p.materials.gate,
  barbican: eraTier?.wall ?? p.materials.wall,
  keep: eraTier?.tower ?? p.materials.tower,
  moat: p.materials.earthwork,
  "lilia-field": p.materials.earthwork,
  well: p.materials.wall,
  granary: p.materials.roof === "tile" ? "timber-and-tile" : "timber-and-thatch",
});

/**
 * Attach decoration to every placement of a bake. `era` selects the
 * material tier (unknown eras fall back to the profile's materials).
 * Returns the bake (mutated in place) for chaining.
 */
export function decorateBake(bake: SettlementBake, profile: StyleProfile, era: number): SettlementBake {
  const heights = HEIGHTS(profile);
  const materials = MATERIAL_FOR(profile, ERA_MATERIALS[era]);
  for (const pl of bake.placements) {
    pl.decoration = {
      material: materials[pl.kind],
      heightM: heights[pl.kind] ?? 0,
      dressing: pl.kind === "tower" || pl.kind === "gate" || pl.kind === "keep" ? [...profile.dressing] : [],
    };
  }
  return bake;
}
