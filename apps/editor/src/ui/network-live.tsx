/**
 * Network workspace (roadmap EA26): the edge routes file the edge loads
 * (editable, validated with the edge's own rules), the edge's live scrape
 * when it is running, and the running game server's connection and tick
 * figures. Anything that needs a process says so when it is not there.
 */
import * as React from "react";
import { validateRoutes, type RouteIssue, type RouteRow } from "../network-model.js";
import { Badge, Button, Input, KvTable, notify } from "./components.js";
import { StatTile } from "./charts.js";
import { formatUptime } from "../liveops-model.js";
import { ServerGate, useServerLink } from "./server-gate.js";

interface Loaded {
  rows: RouteRow[];
  edge: { running: boolean; port: number; metrics?: Record<string, number> };
  issues: RouteIssue[];
}

const dim = { color: "var(--m3-on-surface-variant)" } as const;
const card = { background: "var(--m3-surface-2)" } as const;

async function load(): Promise<Loaded> {
  const res = await fetch("/api/editor/network");
  const body = (await res.json()) as { ok: boolean; error?: string; content?: { routes?: RouteRow[] }; issues?: RouteIssue[]; edge?: Loaded["edge"] };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { rows: body.content?.routes ?? [], edge: body.edge ?? { running: false, port: 3000 }, issues: body.issues ?? [] };
}

export function EdgeRoutesPanel(): React.JSX.Element {
  const [data, setData] = React.useState<Loaded | null>(null);
  const [rows, setRows] = React.useState<RouteRow[]>([]);
  const [saved, setSaved] = React.useState("");
  const [error, setError] = React.useState("");
  const [issues, setIssues] = React.useState<RouteIssue[]>([]);

  const refresh = React.useCallback(async () => {
    try {
      const d = await load();
      setData(d);
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);
  React.useEffect(() => {
    void refresh().then((d) => {
      if (d) {
        setRows(d.rows);
        setSaved(JSON.stringify(d.rows));
      }
    });
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const dirty = JSON.stringify(rows) !== saved;
  const doc = { routes: rows };
  const live = validateRoutes(doc);

  async function save(): Promise<void> {
    const res = await fetch("/api/editor/network", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: doc }) });
    const body = (await res.json()) as { ok: boolean; error?: string; issues?: RouteIssue[] };
    if (!res.ok || !body.ok) {
      setIssues(body.issues ?? []);
      return void notify(body.error ?? `save failed: HTTP ${res.status}`);
    }
    setIssues([]);
    setSaved(JSON.stringify(rows));
    notify("Routes saved. The edge reads them the next time it starts.");
  }
  const patch = (i: number, p: Partial<RouteRow>): void => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));

  if (error && !data) return <p className="p-3 text-sm text-red-400">Could not read content/edge/routes.json: {error}</p>;
  const edge = data?.edge;
  const m = edge?.metrics ?? {};
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl p-3" style={card}>
        <Badge tone={edge?.running ? "ok" : "warn"}>{edge?.running ? "edge running" : "edge not running"}</Badge>
        <span className="text-xs" style={dim}>
          {edge?.running ? `scraping http://127.0.0.1:${edge.port}/metrics` : `nothing answers on http://127.0.0.1:${edge?.port ?? 3000}/metrics; start it with npm run edge`}
        </span>
      </div>
      {edge?.running && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatTile label="WS connections" value={String(m.mmo_edge_ws_connections ?? 0)} sub={`${m.mmo_edge_ws_connects_total ?? 0} connects · ${m.mmo_edge_ws_disconnects_total ?? 0} disconnects`} />
          <StatTile label="Routed packets" value={String(m.mmo_edge_router_requests_total ?? 0)} sub="since the edge started" />
          <StatTile label="Router errors" value={String(m.mmo_edge_router_errors_total ?? 0)} sub="unknown, bad, core down" accent={(m.mmo_edge_router_errors_total ?? 0) > 0 ? "#FFB4AB" : "#9CD67D"} />
          <StatTile label="Core metrics" value={m.mmo_edge_core_metrics_stale ? "stale" : "fresh"} sub="fetched every 15 s" accent={m.mmo_edge_core_metrics_stale ? "#FFB4AB" : "#9CD67D"} />
        </div>
      )}
      <section className="rounded-xl p-3" style={card}>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Routes</h3>
          <span className="font-mono text-xs" style={dim}>content/edge/routes.json · {rows.length} routes</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setRows((r) => [...r, { packetType: "", destination: "core" }])}>Add route</Button>
            <Button size="sm" disabled={!dirty || live.length > 0} onClick={() => void save()}>Save</Button>
          </span>
        </div>
        <p className="mb-2 text-xs" style={dim}>Each packet type goes to the core (<span className="font-mono">core</span>) or to a module on the edge (<span className="font-mono">local:name</span>).</p>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>{["Packet type", "Destination", "Where"].map((h) => <th key={h} className="px-2 text-left font-medium" style={{ ...dim, height: 30 }}>{h}</th>)}<th className="w-10"><span className="sr-only">Remove</span></th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #2a2b31" }}>
                <td className="px-1"><Input className="h-8 font-mono" value={r.packetType} aria-label={`Packet type ${i + 1}`} onChange={(e) => patch(i, { packetType: e.target.value })} /></td>
                <td className="px-1"><Input className="h-8 font-mono" value={r.destination} aria-label={`Destination ${i + 1}`} onChange={(e) => patch(i, { destination: e.target.value })} /></td>
                <td className="px-2"><Badge tone={r.destination === "core" ? "info" : "default"}>{r.destination === "core" ? "core" : "edge module"}</Badge></td>
                <td><Button size="sm" variant="ghost" aria-label={`Remove route ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>✕</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {(live.length > 0 ? live : issues).length > 0 && (
          <ul className="mt-2 text-xs text-red-400" aria-label="Route problems">
            {(live.length > 0 ? live : issues).map((i, k) => <li key={k} className="font-mono">{i.path}: {i.message}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ConnectionsPanel(): React.JSX.Element {
  return (
    <ServerGate what="Connection stats">
      {(s) => (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatTile label="Tick rate" value={s.tickRate === null ? "—" : `${s.tickRate.toFixed(1)}/s`} sub="ticks received by this editor" />
            <StatTile label="Round trip" value={s.rttMs === null ? "—" : `${s.rttMs} ms`} sub="admin ping" />
            <StatTile label="Tick p99" value={s.telemetry ? `${s.telemetry.tick.p99Ms.toFixed(1)} ms` : "—"} sub={s.telemetry ? `${s.telemetry.tick.count.toLocaleString()} ticks sampled` : "waiting"} accent={s.telemetry && s.telemetry.tick.p99Ms > 33 ? "#FFB4AB" : "#9CD67D"} />
            <StatTile label="Reconnects" value={String(s.reconnects)} sub="since this link opened" accent={s.reconnects > 0 ? "#FFB4AB" : undefined} />
          </div>
          <section className="rounded-xl p-3" style={card}>
            <h3 className="mb-2 text-sm font-medium">Game server connection</h3>
            <KvTable rows={[
              { key: "url", value: s.url ?? "—" },
              { key: "pid", value: s.pid === null ? "—" : String(s.pid) },
              { key: "state", value: s.phase },
              { key: "last tick", value: s.lastTick === null ? "—" : s.lastTick.toLocaleString() },
              { key: "linked for", value: s.connectedAt === null ? "—" : formatUptime(Date.now() - s.connectedAt) },
              { key: "tick p50 / p99 / max", value: s.telemetry ? `${s.telemetry.tick.p50Ms.toFixed(1)} / ${s.telemetry.tick.p99Ms.toFixed(1)} / ${s.telemetry.tick.maxMs.toFixed(1)} ms` : "—" },
            ]} />
          </section>
        </div>
      )}
    </ServerGate>
  );
}

export function NetworkDetailsLive(): React.JSX.Element {
  const s = useServerLink();
  return (
    <div className="flex flex-col gap-2 text-xs" style={dim}>
      <p className="text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>Network</p>
      <p>The game server {s.phase === "live" ? <>is running at <span className="font-mono">{s.url}</span>.</> : "is not running."}</p>
      <p>Routes live in <span className="font-mono">content/edge/routes.json</span>; the edge loads them at boot and refuses a bad file, so the editor refuses it too.</p>
    </div>
  );
}
