/**
 * Small shared presentation widgets: Pill (status chip), BarRow (labelled
 * meter), SectionLabel (dock section heading).
 */

import * as React from "react";

type Tone = "ok" | "err" | "warn" | "info" | "plain";

const TONES: Record<Tone, { background: string; color: string }> = {
  ok: { background: "rgba(156,214,125,.14)", color: "#9CD67D" },
  err: { background: "rgba(255,180,171,.14)", color: "#FFB4AB" },
  warn: { background: "rgba(232,163,61,.16)", color: "#E8A33D" },
  info: { background: "rgba(185,195,255,.14)", color: "#B9C3FF" },
  plain: { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" },
};

export function Pill({ tone = "plain", children }: { tone?: Tone; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
      style={TONES[tone]}
    >
      {children}
    </span>
  );
}

export function BarRow({ label, pct, text, bar }: { label: string; pct: number; text: string; bar: string }): React.JSX.Element {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-baseline text-xs">
        <span style={{ color: "var(--m3-on-surface)" }}>{label}</span>
        <span className="ml-auto font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>{text}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--m3-surface-4)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: bar }} />
      </div>
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
      {children}
    </p>
  );
}
