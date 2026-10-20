/**
 * `settlement:scale-fit`: the per-model factor that brings each mapped model to
 * its kind's real height (`buildingHeightM`, or the wall's), held back where its
 * footprint would no longer fit its room (`kindRoom`: the parcel minus the margin,
 * or a wall piece): the smaller of the two.
 * The result is a ScaleDoc whose `assets` entries ride on the doc's own building
 * factor. It names licensed models, so it is written to a gitignored file.
 */

import { resolveScale, SCALE_MAX, SCALE_MIN, type ScaleDoc } from "@mmo-engine/scene";
import { buildArtMap, type CatalogModel } from "./art.js";
import { kindRoom } from "./report.js";
import type { SettlementRules } from "./rules.js";

/** `base`'s categories and global kept, `assets` replaced by one fitted factor per mapped model that has a size. */
export function fitScale(models: readonly CatalogModel[], patterns: Record<string, string[]>, rules: SettlementRules, base: ScaleDoc = { version: 1, global: 1, categories: {}, assets: {} }): ScaleDoc {
  const byId = new Map(models.map((m) => [m.id, m]));
  const bf = resolveScale(base, "building");
  const assets: Record<string, number> = {};
  for (const [kind, ids] of Object.entries(buildArtMap(models, patterns))) {
    const fit = kindRoom(kind, rules, bf);
    if (!fit) continue;
    for (const id of ids) {
      const size = byId.get(id)!.size;
      if (!size || size.some((v) => !(v > 0))) continue;
      const want = Math.min(fit.heightM / size[1], fit.roomM[0] / size[0], fit.roomM[1] / size[2]) / bf;
      // Shave and round down so the report's `>` test never sees an overflow from float noise.
      const f = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.floor(want * (1 - 1e-9) * 1e4) / 1e4));
      assets[id] = Math.min(assets[id] ?? Infinity, f); // a model mapped to several kinds takes the tightest
    }
  }
  return { ...base, assets };
}
