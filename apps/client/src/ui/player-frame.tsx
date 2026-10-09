/**
 * PlayerFrame (U2) — the player's own vitals over the world canvas.
 *
 * Health comes from the mirror's Health rows (authoritative, pushed at
 * 1 Hz through onHud with the rest of HudData). Bars come from the
 * shared ui/meter.tsx; stamina and mana (0x1c, from onMana) reuse it.
 */

import { t } from "../i18n.js";
import type { BodyMessage, NeedsLine } from "@mmo-engine/protocol";
import { BodyDoll, isHurt } from "./body-doll.js";
import { Bar } from "./meter.js";

export interface PlayerFrameProps {
  name: string | null;
  /** Current/max HP from the mirror (null: no Health row yet). */
  hp: number | null;
  maxHp: number | null;
  /** Current/max stamina from the mirror (null: no Stamina row yet). */
  sp: number | null;
  maxSp: number | null;
  /** The mana pool from the server (0x1c); absent until one arrives. */
  mana?: { current: number; max: number } | null;
  /** Hunger and thirst from the stats message (U3); absent until the server sends them. */
  needs?: NeedsLine | null;
  /** The player's body (0x18); a small doll shows beside the bars while anything is wrong. */
  body?: BodyMessage | null;
}

export function PlayerFrame({ name, hp, maxHp, sp, maxSp, mana, needs, body }: PlayerFrameProps): React.ReactElement | null {
  if (hp === null || maxHp === null) return null;
  const hurt = isHurt(body ?? null);
  return (
    <div className={`pointer-events-none flex gap-2 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm`}>
      <div className="min-w-0 flex-1">
        {name && <div className="mb-1 truncate text-sm font-semibold">{name}</div>}
        <Bar label={t("vitals.health")} value={hp} max={maxHp} tone="health" />
        {sp !== null && maxSp !== null && (
          <div className="mt-1.5">
            <Bar label={t("vitals.stamina")} value={sp} max={maxSp} tone="stamina" />
          </div>
        )}
        {mana && (
          <div className="mt-1.5">
            <Bar label={t("vitals.mana")} value={mana.current} max={mana.max} tone="mana" />
          </div>
        )}
        {needs && (
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <Bar label={t("vitals.hunger")} value={needs.hunger} max={needs.hungerMax} tone="hunger" />
            <Bar label={t("vitals.thirst")} value={needs.thirst} max={needs.thirstMax} tone="thirst" />
          </div>
        )}
      </div>
      {hurt && body && <BodyDoll body={body} size={84} />}
    </div>
  );
}
