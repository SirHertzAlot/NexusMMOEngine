/**
 * `settlement:scale-report`: for each structure kind, the mapped models' sizes
 * before and after the building factor, against the parcel they must fit.
 * A model's own factor (an `assets` entry in the scale doc) applies at spawn on
 * top of the building factor; the parcel follows the building factor only.
 */

import { resolveScale, type ScaleDoc } from "@mmo-engine/scene";
import { buildArtMap, type CatalogModel } from "./art.js";
import { scaledLayout } from "./layout.js";
import type { SettlementRules } from "./rules.js";

/** Space the footprint leaves to the parcel's edge, each side, metres (matches the scene's margin). */
const MARGIN_M = 1;

export interface ScaleReportRow {
  kind: string;
  model: string;
  factor: number;
  /** [width, height, depth] metres, as authored and after the factor. */
  before: [number, number, number];
  after: [number, number, number];
  /** The parcel's width and depth, metres, at the building factor. */
  parcel: [number, number];
  overflow: boolean;
}

export function scaleReport(models: readonly CatalogModel[], patterns: Record<string, string[]>, doc: ScaleDoc, rules: SettlementRules): ScaleReportRow[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const [pw, pd] = scaledLayout(rules, resolveScale(doc, "building")).parcelMm;
  const parcel: [number, number] = [pw / 1000, pd / 1000];
  const rows: ScaleReportRow[] = [];
  for (const [kind, ids] of Object.entries(buildArtMap(models, patterns))) {
    for (const id of ids) {
      const size = byId.get(id)!.size;
      if (!size) continue;
      const factor = resolveScale(doc, "building", id);
      const after = size.map((v) => v * factor) as [number, number, number];
      rows.push({ kind, model: id, factor, before: size, after, parcel, overflow: after[0] > parcel[0] - 2 * MARGIN_M || after[2] > parcel[1] - 2 * MARGIN_M });
    }
  }
  return rows;
}

export function formatScaleReport(rows: readonly ScaleReportRow[]): string {
  const f = (s: readonly number[]): string => s.map((v) => v.toFixed(1)).join("x");
  return rows.map((r) => `${r.overflow ? "OVERFLOW" : "ok      "} ${r.kind.padEnd(14)} ${r.model}  ${f(r.before)} -> ${f(r.after)} (x${r.factor.toFixed(2)})  parcel ${f(r.parcel)}`).join("\n");
}
