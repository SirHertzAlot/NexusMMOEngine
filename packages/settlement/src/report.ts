/**
 * `settlement:scale-report`: for each structure kind, the mapped models' sizes
 * before and after the building factor, against the parcel they must fit.
 * A model's own factor (an `assets` entry in the scale doc) applies at spawn on
 * top of the building factor; the parcel follows the building factor only.
 */

import { resolveScale, type ScaleDoc } from "@mmo-engine/scene";
import { buildArtMap, type CatalogModel } from "./art.js";
import { fortificationSizesM, scaledLayout, type WallPieceKind } from "./layout.js";
import { buildingHeightM, type SettlementRules } from "./rules.js";

/** Space the footprint leaves to the parcel's edge, each side, metres (matches the scene's margin). */
export const MARGIN_M = 1;

/**
 * What a model of `kind` must fit at building factor `bf`, metres: its height, and the room for its footprint
 * (width, depth). A building gets its parcel less the margin; a wall piece its own length and thickness (pieces
 * abut, so no margin). Null for a kind the rules do not know.
 */
export function kindRoom(kind: string, rules: SettlementRules, bf: number): { heightM: number; roomM: [number, number] } | null {
  const a = rules.archetypes[kind];
  if (a) {
    const [pw, pd] = scaledLayout(rules, bf).parcelMm;
    return { heightM: buildingHeightM(a, rules.architecture), roomM: [pw / 1000 - 2 * MARGIN_M, pd / 1000 - 2 * MARGIN_M] };
  }
  const w = fortificationSizesM(rules)[kind as WallPieceKind];
  return w ? { heightM: w.heightM, roomM: [w.lengthM * bf, w.thicknessM * bf] } : null;
}

export interface ScaleReportRow {
  kind: string;
  model: string;
  factor: number;
  /** [width, height, depth] metres, as authored and after the factor. */
  before: [number, number, number];
  after: [number, number, number];
  /** The room its footprint must fit (width, depth), metres, at the building factor: the parcel less the margin, or a wall piece. */
  room: [number, number];
  overflow: boolean;
}

export function scaleReport(models: readonly CatalogModel[], patterns: Record<string, string[]>, doc: ScaleDoc, rules: SettlementRules): ScaleReportRow[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const bf = resolveScale(doc, "building");
  const rows: ScaleReportRow[] = [];
  for (const [kind, ids] of Object.entries(buildArtMap(models, patterns))) {
    const fit = kindRoom(kind, rules, bf);
    if (!fit) continue;
    for (const id of ids) {
      const size = byId.get(id)!.size;
      if (!size) continue;
      const factor = resolveScale(doc, "building", id);
      const after = size.map((v) => v * factor) as [number, number, number];
      rows.push({ kind, model: id, factor, before: size, after, room: fit.roomM, overflow: after[0] > fit.roomM[0] || after[2] > fit.roomM[1] });
    }
  }
  return rows;
}

export function formatScaleReport(rows: readonly ScaleReportRow[]): string {
  const f = (s: readonly number[]): string => s.map((v) => v.toFixed(1)).join("x");
  return rows.map((r) => `${r.overflow ? "OVERFLOW" : "ok      "} ${r.kind.padEnd(14)} ${r.model}  ${f(r.before)} -> ${f(r.after)} (x${r.factor.toFixed(2)})  room ${f(r.room)}`).join("\n");
}
