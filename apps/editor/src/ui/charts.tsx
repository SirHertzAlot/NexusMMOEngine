import * as React from "react";

export function StatTile({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }): React.JSX.Element {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
      <p className="text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>{label}</p>
      <p className="text-2xl font-medium" style={accent ? { color: accent } : undefined}>
        {value}
      </p>
      <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{sub}</p>
    </div>
  );
}

export function Chart({ points, color, height = 120, fill = true, caption }: {
  points: number[];
  color: string;
  height?: number;
  fill?: boolean;
  caption?: string;
}): React.JSX.Element {
  const w = 300;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 8 - ((p - min) / span) * (height - 20)).toFixed(1)}`).join(" ");
  const id = React.useId().replace(/:/g, "");
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ display: "block" }} aria-hidden="true">
        {fill && (
          <>
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.35" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${path} L${w},${height} L0,${height} Z`} fill={`url(#${id})`} />
          </>
        )}
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      {caption && (
        <p className="mt-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{caption}</p>
      )}
    </div>
  );
}
