import * as React from "react";
import type { MirrorClient } from "@mmo-engine/mirror";
import {
  TELEMETRY_COUNTERS,
  telemetryFromAdmin,
  type PlayTelemetrySnapshot,
  type TelemetryCounter,
} from "../telemetry.js";
import { Button } from "./components.js";

const POLL_MS = 10_000;
const WIDTH = 120;
const HEIGHT = 24;

const LABELS: Record<TelemetryCounter, string> = {
  kills: "kills",
  deaths: "deaths",
  pickups: "pickups",
  drops: "drops",
  damageDealt: "damage dealt",
  damageTaken: "damage taken",
};

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function PlayTelemetryPanel({ client }: { client: MirrorClient }): React.JSX.Element {
  const [snapshot, setSnapshot] = React.useState<PlayTelemetrySnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const inFlight = React.useRef(false);

  const refresh = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      setSnapshot(telemetryFromAdmin(await client.admin("stats")));
      setError(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!message.includes("already in flight")) setError(message);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [client]);

  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!snapshot) {
    return (
      <div className="space-y-2 text-xs">
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Loading telemetry…" : "Refresh telemetry"}
        </Button>
        <p className="text-muted-foreground" role={error ? "alert" : undefined}>
          {error ?? "Waiting for the first telemetry snapshot…"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          last {snapshot.buckets * snapshot.bucketSeconds / 60} min · {snapshot.bucketSeconds}s buckets
        </span>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="grid grid-cols-[5.5rem_minmax(48px,1fr)_auto] items-center gap-x-2 gap-y-1">
        {TELEMETRY_COUNTERS.map((counter) => (
          <React.Fragment key={counter}>
            <span className="text-muted-foreground">{LABELS[counter]}</span>
            <TelemetrySparkline label={LABELS[counter]} values={snapshot.series[counter]} />
            <span title={`total ${format(snapshot.totals[counter])}`}>
              {format(snapshot.series[counter].at(-1) ?? 0)}
            </span>
          </React.Fragment>
        ))}
      </div>
      <div className="border-t border-border/50 pt-2">
        tick p50 <span className="text-foreground">{snapshot.tick.p50Ms.toFixed(1)} ms</span>
        {" · "}p99 <span className="text-foreground">{snapshot.tick.p99Ms.toFixed(1)} ms</span>
        {" · "}max <span className="text-foreground">{snapshot.tick.maxMs.toFixed(1)} ms</span>
        {" · "}<span className="text-muted-foreground">{snapshot.tick.count} ticks sampled</span>
      </div>
      {error && <p className="text-red-400" role="alert">{error}</p>}
    </div>
  );
}

function TelemetrySparkline({ label, values }: { label: string; values: readonly number[] }): React.JSX.Element {
  const top = Math.max(1, ...values);
  const step = WIDTH / Math.max(1, values.length - 1);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? WIDTH : index * step;
    const y = HEIGHT - 2 - (value / top) * (HEIGHT - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg
      role="img"
      aria-label={`${label}: current ${format(values.at(-1) ?? 0)}, total ${format(values.reduce((sum, value) => sum + value, 0))} across the visible window`}
      width="100%"
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="block"
    >
      <title>{label}</title>
      <line x1={0} y1={HEIGHT - 1} x2={WIDTH} y2={HEIGHT - 1} stroke="#64748b" strokeOpacity={0.35} vectorEffect="non-scaling-stroke" />
      <polyline points={points} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
