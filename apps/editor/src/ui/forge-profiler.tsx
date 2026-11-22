/**
 * Forge profiler — per-system tick cost against the tick budget
 * (docs/EDITOR-UI-2026.md §3 item 12, slice EU7).
 *
 * The gap list had "profiler / per-system tick cost" as missing. It was
 * not: `TickTimings` in engine-core has recorded both since the gateway
 * was written, the debug API serves them (`query: "timings"`), and the
 * Debug workspace has shown the top five as a plain list. What was
 * missing is the part a profiler is for — the budget. A system costing
 * 0.8 ms means nothing until you know the tick has 33.33 ms, and that
 * 0.8 ms is 2.4% of it.
 *
 * So this panel adds no measurement. It reads the SAME snapshot the
 * Material 3 panel reads, through `useTickTimings()` below, which both
 * mount — the anti-drift rule the inspector slice set.
 *
 * One honest label. The server's snapshot mixes two windows and always
 * has: `p50`/`p99` come from a 1,000-tick ring, while each system's
 * `avg` and `max` are running totals since the process started, so a
 * spike never decays out of `max` and a regression starting now is
 * diluted by all the history before it. The panel says which number is
 * which rather than implying one window. Making the per-system figures
 * windowed is a change to the tick path, so it belongs in its own PR
 * behind a `valgrind:perf` run, not in a UI slice.
 */

import * as React from "react";
import { getPlayController } from "./play-controller-slot.js";

/** The tick budget, from `STEP_MS` in engine-core's tick-loop (30 Hz). */
export const TICK_BUDGET_MS = 1000 / 30;

export interface SystemCost {
  name: string;
  avg: number;
  max: number;
}

export interface Timings {
  ticks: number;
  p50: number;
  p99: number;
  systems: SystemCost[];
}

export type TimingsState =
  | { kind: "timings"; timings: Timings }
  | { kind: "idle" }
  | { kind: "unavailable"; reason: string };

/**
 * One poller for the play server's timings, shared by both presentations.
 * `read` is injected by the tests; live it is the play controller's own
 * debug query, exactly as the Debug workspace has always called it.
 */
export function useTickTimings(
  read?: () => Promise<Timings | null>,
  periodMs = 2000,
): TimingsState {
  const [state, setState] = React.useState<TimingsState>({ kind: "idle" });
  const fetcher = React.useMemo(
    () =>
      read ??
      (async (): Promise<Timings | null> => {
        const c = getPlayController();
        if (!c || c.getState() !== "running") return null;
        const res = await c.debugTimings();
        if (res.query !== "timings") return null;
        return { ticks: res.ticks, p50: res.p50, p99: res.p99, systems: res.systems };
      }),
    [read],
  );

  React.useEffect(() => {
    let live = true;
    // One query at a time: a slow server must not pile up a request every 2 s.
    let inFlight = false;
    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetcher();
        if (!live) return;
        setState(next ? { kind: "timings", timings: next } : { kind: "idle" });
      } catch {
        // Running but unanswered: the query rides the player's client,
        // which Simulate does not connect.
        if (live) {
          setState({
            kind: "unavailable",
            reason: "Tick timings come through the player's client; Simulate runs without one.",
          });
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), periodMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [fetcher, periodMs]);

  return state;
}

export interface BudgetRow extends SystemCost {
  /** Mean cost as a share of the tick budget, 0..1 (can exceed 1). */
  share: number;
  /** Worst recorded cost as a share of the budget, 0..1 (can exceed 1). */
  peakShare: number;
}

/** Systems as shares of the budget, dearest first. */
export function budgetRows(systems: readonly SystemCost[], budgetMs = TICK_BUDGET_MS): BudgetRow[] {
  return systems
    .map((s) => ({ ...s, share: s.avg / budgetMs, peakShare: s.max / budgetMs }))
    .sort((a, b) => b.avg - a.avg);
}

/**
 * What a share of the budget costs you. The thresholds are the ones the
 * tick itself cares about: under half is fine, over the whole budget
 * means the tick cannot keep 30 Hz.
 */
export function budgetTone(share: number): "ok" | "warn" | "bad" {
  if (share >= 1) return "bad";
  if (share >= 0.5) return "warn";
  return "ok";
}

/** Measured cost, and what is left of the tick. Never below zero. */
export function headroomMs(p99: number, budgetMs = TICK_BUDGET_MS): number {
  return Math.max(0, budgetMs - p99);
}

const TONE: Readonly<Record<"ok" | "warn" | "bad", string>> = {
  ok: "var(--fg-ok)",
  warn: "var(--fg-warn)",
  bad: "var(--fg-bad)",
};

function Bar({ share, tone }: { share: number; tone: "ok" | "warn" | "bad" }): React.JSX.Element {
  return (
    <span className="fg-bar-track" aria-hidden>
      <span
        className="fg-bar-fill"
        style={{ width: `${Math.min(100, share * 100)}%`, background: TONE[tone] }}
      />
    </span>
  );
}

export function ForgeProfilerView({
  state,
  budgetMs = TICK_BUDGET_MS,
}: {
  state: TimingsState;
  budgetMs?: number;
}): React.JSX.Element {
  if (state.kind === "unavailable") {
    return (
      <section className="fg-panel p-3">
        <span className="fg-label">Profiler</span>
        <p className="fg-data mt-1">{state.reason}</p>
      </section>
    );
  }
  if (state.kind === "idle") {
    return (
      <section className="fg-panel p-3">
        <span className="fg-label">Profiler</span>
        <p className="fg-data mt-1">Start play mode to see live tick timings.</p>
      </section>
    );
  }

  const { timings } = state;
  const rows = budgetRows(timings.systems, budgetMs);
  const measured = rows.reduce((sum, r) => sum + r.avg, 0);
  const left = headroomMs(timings.p99, budgetMs);

  return (
    <section className="fg-panel flex min-h-0 flex-col">
      <header className="flex items-baseline gap-3 p-3">
        <span className="fg-label">Profiler</span>
        <span className="fg-data fg-dim">
          {timings.ticks} ticks · {budgetMs.toFixed(1)} ms budget at 30 Hz
        </span>
      </header>

      {/* ------------------------------------------------- tick budget */}
      <div className="flex flex-col gap-1.5 px-3 pb-3">
        {(
          [
            ["p50", timings.p50],
            ["p99", timings.p99],
          ] as const
        ).map(([label, ms]) => {
          const share = ms / budgetMs;
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="fg-label" style={{ width: 28 }}>
                {label}
              </span>
              <Bar share={share} tone={budgetTone(share)} />
              <span className="fg-data" style={{ color: "var(--fg-text)", width: 64, textAlign: "right" }}>
                {ms.toFixed(2)} ms
              </span>
              <span className="fg-data fg-dim" style={{ width: 44, textAlign: "right" }}>
                {(share * 100).toFixed(0)}%
              </span>
            </div>
          );
        })}
        <p className="fg-data fg-dim">
          {left.toFixed(2)} ms of headroom at p99 · last 1,000 ticks
        </p>
      </div>

      {/* ---------------------------------------------------- systems */}
      <div className="m3-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="flex items-baseline gap-2 pb-1.5">
          <span className="fg-label">Systems ({rows.length})</span>
          <span className="fg-data fg-dim">{measured.toFixed(2)} ms measured per tick</span>
        </div>
        {rows.length === 0 && <p className="fg-data fg-dim">No system has reported a cost yet.</p>}
        {rows.map((r) => (
          <div key={r.name} className="fg-row flex items-center gap-2 px-2 py-1.5">
            <span
              className="fg-data min-w-0 flex-1 truncate"
              style={{ color: "var(--fg-text)" }}
              title={r.name}
            >
              {r.name}
            </span>
            <Bar share={r.share} tone={budgetTone(r.share)} />
            <span className="fg-data" style={{ color: "var(--fg-text)", width: 62, textAlign: "right" }}>
              {r.avg.toFixed(3)} ms
            </span>
            <span className="fg-data fg-dim" style={{ width: 40, textAlign: "right" }}>
              {(r.share * 100).toFixed(1)}%
            </span>
            <span className="fg-data fg-dim" style={{ width: 70, textAlign: "right" }}>
              peak {r.max.toFixed(2)}
            </span>
          </div>
        ))}
        <p className="fg-data fg-dim mt-2 leading-relaxed">
          p50 and p99 are over the last 1,000 ticks. Each system&apos;s mean and peak are running
          totals since the server started, so a peak never decays — they are not the same window.
        </p>
      </div>
    </section>
  );
}

/** Live panel: the shared poller, rendered by the view above. */
export function ForgeProfilerPanel(): React.JSX.Element {
  return <ForgeProfilerView state={useTickTimings()} />;
}
