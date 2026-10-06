import * as React from "react";
import { BackendClient } from "../backend.js";
import type { TelemetrySnapshot } from "../backend-models.js";
import type { TelemetryPollState } from "../liveops-telemetry.js";
import { TelemetryPoller } from "../liveops-telemetry.js";
import { Badge, Button, Input } from "./components.js";
import { Chart, StatTile } from "./charts.js";

const DEFAULT_URL =
  typeof window !== "undefined" && window.location.hostname
    ? `ws://${window.location.hostname}:7777`
    : "ws://127.0.0.1:7777";

const COUNTERS: ReadonlyArray<{ key: string; label: string; color: string }> = [
  { key: "kills", label: "Kills", color: "#FFB59A" },
  { key: "pickups", label: "Pickups", color: "#B9C3FF" },
  { key: "damageDealt", label: "Damage dealt", color: "#9CD67D" },
];

const DISCONNECTED_STATE: TelemetryPollState = {
  snapshot: null,
  error: null,
  loading: false,
  updatedAt: null,
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function series(snapshot: TelemetrySnapshot, key: string): number[] {
  return snapshot.series[key] ?? Array.from({ length: snapshot.buckets }, () => 0);
}

function usePollState(poller: TelemetryPoller | null) {
  return React.useSyncExternalStore(
    (listener) => poller?.subscribe(listener) ?? (() => {}),
    () => poller?.get() ?? DISCONNECTED_STATE,
  );
}

export function LiveOpsTelemetry(): React.JSX.Element {
  const [url, setUrl] = React.useState(DEFAULT_URL);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [poller, setPoller] = React.useState<TelemetryPoller | null>(null);
  const backendRef = React.useRef<BackendClient | null>(null);
  const state = usePollState(poller);

  React.useEffect(() => () => {
    poller?.stop();
    backendRef.current?.stop();
  }, [poller]);

  async function connect(): Promise<void> {
    if (!username) {
      setConnectionError("Enter a dev username to read protected telemetry.");
      return;
    }
    setConnecting(true);
    setConnectionError(null);
    try {
      const backend = await BackendClient.connect(
        url,
        { username, password },
        {
          onTick: () => {},
          onClose: () => {},
          onReconnect: () => {},
          onError: (error) => setConnectionError(error.message),
        },
      );
      const next = new TelemetryPoller(backend);
      backendRef.current = backend;
      setPoller(next);
      next.start();
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }

  function disconnect(): void {
    poller?.stop();
    setPoller(null);
    backendRef.current?.stop();
    backendRef.current = null;
    setConnectionError(null);
  }

  const snapshot = state.snapshot;
  return (
    <section className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-sm font-medium">Server telemetry</h2>
          <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
            Read-only admin `stats` snapshots refresh once per server bucket.
          </p>
        </div>
        <div className="ml-auto">
          {poller ? (
            <Badge tone={state.error ? "bad" : "ok"}>
              {state.loading ? "refreshing" : state.error ? "refresh failed" : `live · ${snapshot?.bucketSeconds ?? 10} s`}
            </Badge>
          ) : (
            <Badge tone="warn">disconnected</Badge>
          )}
        </div>
      </div>

      {!poller ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_150px_150px_auto]">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="ws://127.0.0.1:7777" aria-label="Telemetry server URL" />
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username" aria-label="Telemetry username" autoComplete="username" />
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="password" aria-label="Telemetry password" autoComplete="current-password" />
          <Button onClick={() => void connect()} disabled={connecting}>{connecting ? "Connecting…" : "Connect"}</Button>
        </div>
      ) : (
        <div className="mb-3 flex items-center gap-2 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          <span>Reading <span className="font-mono">{url}</span></span>
          {state.updatedAt !== null && <span>· updated {new Date(state.updatedAt).toLocaleTimeString()}</span>}
          <Button variant="outline" size="sm" className="ml-auto" onClick={disconnect}>Disconnect</Button>
        </div>
      )}
      {connectionError && <p className="mt-2 text-xs text-red-400">{connectionError}</p>}
      {state.error && <p className="mt-2 text-xs text-red-400">Telemetry request failed: {state.error}</p>}

      {snapshot ? <TelemetryCharts snapshot={snapshot} /> : poller && !state.error ? (
        <p className="mt-3 text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>Waiting for the first telemetry snapshot…</p>
      ) : null}
    </section>
  );
}

function TelemetryCharts({ snapshot }: { snapshot: TelemetrySnapshot }): React.JSX.Element {
  const { tick, totals } = snapshot;
  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-5">
        <StatTile label="Tick p50" value={`${tick.p50Ms.toFixed(1)} ms`} sub={`${formatNumber(tick.count)} samples`} accent="#9CD67D" />
        <StatTile label="Tick p99" value={`${tick.p99Ms.toFixed(1)} ms`} sub={`max ${tick.maxMs.toFixed(1)} ms · budget 33 ms`} accent={tick.p99Ms <= 33 ? "#9CD67D" : "#FFB4AB"} />
        <StatTile label="Kills" value={formatNumber(totals.kills ?? 0)} sub="all-time total" />
        <StatTile label="Pickups" value={formatNumber(totals.pickups ?? 0)} sub="all-time total" />
        <StatTile label="Damage dealt" value={formatNumber(totals.damageDealt ?? 0)} sub="all-time total" />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
        {COUNTERS.map(({ key, label, color }) => (
          <div key={key} className="rounded-xl p-3" style={{ background: "var(--m3-surface-3)" }}>
            <p className="mb-2 text-sm font-medium">{label}</p>
            <Chart points={series(snapshot, key)} color={color} caption={`${snapshot.buckets} × ${snapshot.bucketSeconds} s buckets · newest at right`} />
          </div>
        ))}
      </div>
    </>
  );
}
