/**
 * PlayerFrame (U2) — the player's own vitals over the world canvas.
 *
 * Health comes from the mirror's Health rows (authoritative, pushed at
 * 1 Hz through onHud with the rest of HudData). `Bar` is deliberately
 * generic so stamina and mana reuse it once their pools land (M1/M2) —
 * no new bar code then, just new props.
 */

const TONES: Record<string, string> = {
  health: "bg-red-500",
  stamina: "bg-green-500",
  mana: "bg-sky-500",
};

/** Fraction of a bar to fill, clamped to [0, 1]; non-positive maxima fill nothing. */
export function barFraction(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export interface BarProps {
  label: string;
  value: number;
  max: number;
  tone: keyof typeof TONES;
}

export function Bar({ label, value, max, tone }: BarProps): React.ReactElement {
  const pct = barFraction(value, max) * 100;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {Math.max(0, Math.round(value))}/{Math.max(0, Math.round(max))}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded bg-secondary"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.max(0, Math.round(value))}
        aria-valuemax={Math.max(0, Math.round(max))}
      >
        <div className={`h-full rounded ${TONES[tone]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

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
