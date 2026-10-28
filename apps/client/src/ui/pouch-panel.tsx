/**
 * The materials pouch (gathering, protocol 0x24): what the player has
 * gathered from tree stands, ore veins and fishing spots, by tier.
 * Shown over the bag; materials stack, unlike bag items.
 */

import type { PouchMaterial } from "@mmo-engine/protocol";
import { t } from "../i18n.js";

/** One colour per crafting tier (1 common .. 5 legendary), like item ranks. */
const TIER_COLORS = ["#d4d4d4", "#7dd87d", "#6fa8ff", "#c38bff", "#ffb347"];

export function tierColor(tier: number): string {
  return TIER_COLORS[Math.min(TIER_COLORS.length, Math.max(1, tier)) - 1]!;
}

export function PouchPanel({ materials }: { materials: readonly PouchMaterial[] }): React.ReactElement {
  return (
    <div className="pointer-events-auto mb-2 w-80 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm" aria-label={t("pouch.title")}>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-semibold">{t("pouch.title")}</div>
        <div className="text-xs text-muted-foreground tabular-nums">{materials.reduce((n, m) => n + m.count, 0)}</div>
      </div>
      {materials.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t("pouch.empty")}</div>
      ) : (
        <ul className="space-y-1">
          {materials.map((m) => (
            <li key={m.material} className="flex items-center justify-between text-sm">
              <span style={{ color: tierColor(m.tier) }}>{m.name}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                <span>{t("pouch.tier", { tier: m.tier })}</span>
                <span className="min-w-8 text-right text-sm text-card-foreground">{m.count}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
