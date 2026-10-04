/**
 * PlayerFrame (U2) — the player's own vitals over the world canvas.
 *
 * Health comes from the mirror's Health rows (authoritative, pushed at
 * 1 Hz through onHud with the rest of HudData). Bars come from the
 * shared ui/meter.tsx; stamina and mana (0x1c, from onMana) reuse it.
 */

import type { NeedsLine } from "@mmo-engine/protocol";
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
}

export function PlayerFrame({ name, hp, maxHp, sp, maxSp, mana, needs }: PlayerFrameProps): React.ReactElement | null {
  if (hp === null || maxHp === null) return null;
  return (
    <div className="pointer-events-none w-64 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm">
      {name && <div className="mb-1 truncate text-sm font-semibold">{name}</div>}
      <Bar label="health" value={hp} max={maxHp} tone="health" />
      {sp !== null && maxSp !== null && (
        <div className="mt-1.5">
          <Bar label="stamina" value={sp} max={maxSp} tone="stamina" />
        </div>
      )}
      {mana && (
        <div className="mt-1.5">
          <Bar label="mana" value={mana.current} max={mana.max} tone="mana" />
        </div>
      )}
      {needs && (
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          <Bar label="hunger" value={needs.hunger} max={needs.hungerMax} tone="hunger" />
          <Bar label="thirst" value={needs.thirst} max={needs.thirstMax} tone="thirst" />
        </div>
      )}
    </div>
  );
}
