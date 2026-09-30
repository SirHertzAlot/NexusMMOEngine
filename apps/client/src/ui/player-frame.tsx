/**
 * PlayerFrame (U2) — the player's own vitals over the world canvas.
 *
 * Health comes from the mirror's Health rows (authoritative, pushed at
 * 1 Hz through onHud with the rest of HudData). Bars come from the
 * shared ui/meter.tsx — stamina and mana reuse it once their pools land
 * (M1/M2), with no new bar code.
 */

import { Bar } from "./meter.js";

export interface PlayerFrameProps {
  name: string | null;
  /** Current/max HP from the mirror (null: no Health row yet). */
  hp: number | null;
  maxHp: number | null;
}

export function PlayerFrame({ name, hp, maxHp }: PlayerFrameProps): React.ReactElement | null {
  if (hp === null || maxHp === null) return null;
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 w-64 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm">
      {name && <div className="mb-1 truncate text-sm font-semibold">{name}</div>}
      <Bar label="health" value={hp} max={maxHp} tone="health" />
    </div>
  );
}
