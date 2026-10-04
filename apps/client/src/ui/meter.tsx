/**
 * Meter — the shared bar UI for the client (U2's PlayerFrame today,
 * stamina/mana tomorrow, anything else that needs a value/max bar).
 *
 * Props-driven: callers pass their own data, so no bar is ever
 * re-implemented per consumer. For sparklines and segmented LOD views,
 * see ui/perf-hud.tsx instead — different visualisations, not bars.
 */

const TONES: Record<string, string> = {
  health: "bg-red-500",
  stamina: "bg-green-500",
  mana: "bg-sky-500",
  hunger: "bg-amber-500",
  thirst: "bg-cyan-400",
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
