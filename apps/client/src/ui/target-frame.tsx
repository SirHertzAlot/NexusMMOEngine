/**
 * TargetFrame (U12a) — the selected target's name and health, top centre.
 *
 * The target is what the player last struck, what last struck them (when
 * nothing was targeted), or what they clicked; it follows the mirror's
 * Health rows every frame, so a hit shows the moment it lands.
 */

import { Bar } from "./meter.js";
import { t } from "../i18n.js";

export interface TargetFrameProps {
  target: { name: string; hp: number; maxHp: number } | null;
}

export function TargetFrame({ target }: TargetFrameProps): React.ReactElement | null {
  if (!target) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 w-64 -translate-x-1/2 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm">
      <div className="mb-1 truncate text-sm font-semibold">{target.name || t("target.unknown")}</div>
      <Bar label={t("stat.health")} value={target.hp} max={target.maxHp} tone="health" />
    </div>
  );
}
