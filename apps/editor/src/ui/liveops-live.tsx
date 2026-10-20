/**
 * Live ops workspace (roadmap EA26): the running server's real state,
 * driven by the server's own admin commands. Every control sends a real
 * command over the shared admin link (server-link.ts) and shows the
 * server's answer; with no server the gate says so and offers Start.
 */
import * as React from "react";
import { ServerSettingsPanel } from "./server-settings-panel.js";
import { createHostServerControl } from "../server-control.js";
import { formatUptime, parseConsoleLine, parseHelp, parseTimeOfDay, parseWeather, timeArgs, WEATHERS, type Weather } from "../liveops-model.js";
import { Badge, Button, Input, KvTable, notify } from "./components.js";
import { StatTile } from "./charts.js";
import { LiveOpsTelemetry, TelemetryCharts } from "./liveops-telemetry.js";
import { ServerGate, serverLink, useServerLink } from "./server-gate.js";

// ------------------------------------------------------------ command log

interface LogLine {
  id: number;
  at: number;
  line: string;
  ok: boolean;
  message: string;
}

let logLines: LogLine[] = [];
let nextId = 1;
const logSubs = new Set<() => void>();

/** Run one admin command on the live server and keep the exchange in the log. */
export async function runAdmin(line: string, command: string, args?: Record<string, unknown>): Promise<LogLine> {
  const r = await serverLink.admin(command, args);
  const entry = { id: nextId++, at: Date.now(), line, ok: r.ok, message: r.message };
  logLines = [entry, ...logLines].slice(0, 100);
  logSubs.forEach((f) => f());
  return entry;
}

function useLog(): LogLine[] {
  return React.useSyncExternalStore(
    (fn) => {
      logSubs.add(fn);
      return () => logSubs.delete(fn);
    },
    () => logLines,
  );
}

function LogView({ lines, max = 12 }: { lines: LogLine[]; max?: number }): React.JSX.Element {
  if (lines.length === 0) return <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>No commands sent yet.</p>;
  return (
    <ol className="flex flex-col gap-1 font-mono text-xs" aria-label="Command log">
      {lines.slice(0, max).map((l) => (
        <li key={l.id} className="rounded-lg px-2 py-1" style={{ background: "var(--m3-surface-3)" }}>
          <span style={{ color: "var(--m3-on-surface-variant)" }}>&gt; {l.line}</span>
          <br />
          <span style={{ color: l.ok ? "var(--m3-on-surface)" : "#FFB4AB" }} className="whitespace-pre-wrap break-all">{l.message.length > 400 ? `${l.message.slice(0, 400)}…` : l.message}</span>
        </li>
      ))}
    </ol>
  );
}

const card = { background: "var(--m3-surface-2)" } as const;
const dim = { color: "var(--m3-on-surface-variant)" } as const;

function Card({ title, children, sub }: { title: string; sub?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-xl p-3" style={card}>
      <h3 className="text-sm font-medium">{title}</h3>
      {sub && <p className="mb-2 text-xs" style={dim}>{sub}</p>}
      <div className={sub ? "" : "mt-2"}>{children}</div>
    </section>
  );
}

// --------------------------------------------------------------- overview

function WorldControls(): React.JSX.Element {
  const [time, setTime] = React.useState<string>("…");
  const [hour, setHour] = React.useState("12");
  const [minute, setMinute] = React.useState("0");
  const [weather, setWeather] = React.useState<Weather | null>(null);
  const readTime = React.useCallback(async () => {
    const r = await serverLink.admin("time");
    setTime(r.ok ? (r.message.split(" (")[0] || r.message) : r.message);
    const t = r.ok ? parseTimeOfDay(r.message) : null;
    if (t) setHour(String(t.hour));
  }, []);
  const readWeather = React.useCallback(async () => {
    const r = await serverLink.admin("weather");
    setWeather(r.ok ? parseWeather(r.message) : null);
  }, []);
  React.useEffect(() => {
    void readTime();
    void readWeather();
  }, [readTime, readWeather]);

  async function setClock(): Promise<void> {
    const a = timeArgs(Number(hour), Number(minute));
    if ("error" in a) return void notify(a.error);
    await runAdmin(`time hour=${a.hour} minute=${a.minute}`, "time", a);
    await readTime();
  }
  return (
    <Card title="World" sub="Time of day and weather, for every player in the world.">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <p className="text-xs" style={dim}>Time of day</p>
          <p className="font-mono text-lg" data-testid="liveops-time">{time}</p>
        </div>
        <Input style={{ width: 64 }} value={hour} onChange={(e) => setHour(e.target.value)} aria-label="Hour" inputMode="numeric" />
        <span>:</span>
        <Input style={{ width: 64 }} value={minute} onChange={(e) => setMinute(e.target.value)} aria-label="Minute" inputMode="numeric" />
        <Button size="sm" onClick={() => void setClock()}>Set time</Button>
      </div>
      <p className="mb-1 mt-3 text-xs" style={dim}>Weather</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Weather">
        {WEATHERS.map((w) => (
          <Button
            key={w}
            size="sm"
            variant={weather === w ? "default" : "outline"}
            aria-pressed={weather === w}
            onClick={async () => {
              await runAdmin(`weather weather=${w}`, "weather", { weather: w });
              await readWeather();
            }}
          >
            {w}
          </Button>
        ))}
      </div>
    </Card>
  );
}

function AvatarControls(): React.JSX.Element {
  const [x, setX] = React.useState("0");
  const [z, setZ] = React.useState("0");
  const [asset, setAsset] = React.useState("");
  const [base, setBase] = React.useState("");
  const [rank, setRank] = React.useState("");
  const [count, setCount] = React.useState("5");
  const num = (s: string): number | null => (s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
  const row = "flex flex-wrap items-center gap-2";
  return (
    <Card title="Your avatar" sub="Acts on the editor's own player in the running world.">
      <div className="flex flex-col gap-2">
        <div className={row}>
          <Button size="sm" variant="outline" onClick={() => void runAdmin("heal", "heal")}>Heal</Button>
          <Button size="sm" variant="outline" onClick={() => void runAdmin("god on=true", "god", { on: true })}>God on</Button>
          <Button size="sm" variant="outline" onClick={() => void runAdmin("god on=false", "god", { on: false })}>God off</Button>
          <Button size="sm" variant="outline" onClick={() => void runAdmin("fly on=true", "fly", { on: true })}>Fly on</Button>
          <Button size="sm" variant="outline" onClick={() => void runAdmin("fly on=false", "fly", { on: false })}>Fly off</Button>
        </div>
        <div className={row}>
          <Input style={{ width: 80 }} value={x} onChange={(e) => setX(e.target.value)} aria-label="Teleport x" />
          <Input style={{ width: 80 }} value={z} onChange={(e) => setZ(e.target.value)} aria-label="Teleport z" />
          <Button size="sm" onClick={() => {
            const nx = num(x), nz = num(z);
            if (nx === null || nz === null) return void notify("x and z are numbers");
            void runAdmin(`teleport x=${nx} z=${nz}`, "teleport", { x: nx, z: nz });
          }}>Teleport</Button>
        </div>
        <div className={row}>
          <Input style={{ width: 160 }} value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="spawn asset id" aria-label="Spawn asset" />
          <Button size="sm" onClick={() => asset.trim() === "" ? notify("name an asset (List shows them)") : void runAdmin(`spawn asset=${asset.trim()}`, "spawn", { asset: asset.trim() })}>Spawn</Button>
          <Button size="sm" variant="outline" onClick={() => void runAdmin("spawnlist", "spawnlist")}>List</Button>
        </div>
        <div className={row}>
          <Input style={{ width: 112 }} value={base} onChange={(e) => setBase(e.target.value)} placeholder="item base" aria-label="Item base" />
          <Input style={{ width: 96 }} value={rank} onChange={(e) => setRank(e.target.value)} placeholder="rank" aria-label="Item rank" />
          <Button size="sm" onClick={() => void runAdmin("give", "give", { ...(base.trim() ? { base: base.trim() } : {}), ...(rank.trim() ? { rank: rank.trim() } : {}) })}>Give</Button>
          <Button size="sm" variant="outline" onClick={() => void runAdmin("items", "items", { ...(base.trim() ? { base: base.trim() } : {}), ...(rank.trim() ? { rank: rank.trim() } : {}) })}>Look up</Button>
        </div>
        <div className={row}>
          <Input style={{ width: 80 }} value={count} onChange={(e) => setCount(e.target.value)} aria-label="Loot count" />
          <Button size="sm" onClick={() => {
            const n = num(count);
            if (n === null || n < 1) return void notify("count is a number above 0");
            void runAdmin(`loot count=${n}`, "loot", { count: n });
          }}>Drop loot</Button>
        </div>
      </div>
    </Card>
  );
}

export function LiveOpsOverview(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <ServerBar />
      <ServerGate what="Live ops">
        {(s) => (
          <>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <StatTile label="Server tick" value={s.lastTick === null ? "—" : s.lastTick.toLocaleString()} sub={s.tickRate === null ? "measuring" : `${s.tickRate.toFixed(1)} ticks/s received`} />
              <StatTile label="Tick p99" value={s.telemetry ? `${s.telemetry.tick.p99Ms.toFixed(1)} ms` : "—"} sub={s.telemetry ? `p50 ${s.telemetry.tick.p50Ms.toFixed(1)} · max ${s.telemetry.tick.maxMs.toFixed(1)} ms` : "waiting"} accent={s.telemetry && s.telemetry.tick.p99Ms > 33 ? "#FFB4AB" : "#9CD67D"} />
              <StatTile label="Round trip" value={s.rttMs === null ? "—" : `${s.rttMs} ms`} sub="admin ping from this editor" />
              <StatTile label="Linked for" value={s.connectedAt === null ? "—" : formatUptime(Date.now() - s.connectedAt)} sub={`${s.reconnects} reconnect${s.reconnects === 1 ? "" : "s"}`} />
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <WorldControls />
              <AvatarControls />
            </div>
            <Card title="Recent commands" sub="Every control above sends one of the server's admin commands; its answer is here."><RecentLog /></Card>
          </>
        )}
      </ServerGate>
    </div>
  );
}

function RecentLog(): React.JSX.Element {
  return <LogView lines={useLog()} />;
}

/** Server state strip: always shown, so Start/Stop are one click away. */
function ServerBar(): React.JSX.Element {
  const s = useServerLink();
  const [busy, setBusy] = React.useState(false);
  const live = s.phase === "live";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl p-3" style={card}>
      <Badge tone={live ? "ok" : s.phase === "error" ? "bad" : "warn"}>{live ? "server running" : s.phase === "error" ? "error" : s.phase === "stopped" ? "server not running" : s.phase}</Badge>
      {live && s.url && <span className="font-mono text-xs" style={dim}>{s.url} · pid {s.pid}</span>}
      <span className="ml-auto flex gap-2">
        {live ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await createHostServerControl().stop();
              await serverLink.refresh();
            } catch (e) {
              notify(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}>Stop server</Button>
        ) : (
          <Button size="sm" disabled={busy || s.phase === "starting" || s.phase === "connecting"} onClick={() => void serverLink.start()}>Start server</Button>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- console

export function LiveOpsConsole(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <ServerBar />
      <ServerGate what="The admin console">{() => <ConsoleBody />}</ServerGate>
    </div>
  );
}

function ConsoleBody(): React.JSX.Element {
  const [text, setText] = React.useState("");
  const [commands, setCommands] = React.useState<string[]>([]);
  const [err, setErr] = React.useState("");
  const lines = useLog();
  React.useEffect(() => {
    void serverLink.admin("help").then((r) => setCommands(parseHelp(r.message)));
  }, []);
  async function send(): Promise<void> {
    const parsed = parseConsoleLine(text);
    if ("error" in parsed) return void setErr(parsed.error);
    setErr("");
    setText("");
    await runAdmin(text.trim(), parsed.command, parsed.args);
  }
  return (
    <>
      <Card title="Admin console" sub='A command, then key=value pairs or a JSON object: teleport x=10 z=-4, set {"entity":"me","component":"Health","field":"current","value":50}'>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="help" aria-label="Admin command" className="font-mono" />
          <Button type="submit" size="sm">Send</Button>
        </form>
        {err && <p className="mt-1 text-xs text-red-400">{err}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Server commands">
          {commands.map((c) => (
            <button key={c} className="m3-focus rounded-full px-2.5 py-0.5 font-mono text-[11px]" style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }} onClick={() => setText(c + " ")}>{c}</button>
          ))}
        </div>
      </Card>
      <Card title="Log"><LogView lines={lines} max={40} /></Card>
    </>
  );
}

// -------------------------------------------------------------- telemetry

export function LiveOpsTelemetryView(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <ServerBar />
      <ServerGate what="Telemetry">
        {(s) => (
          <section className="rounded-xl p-3" style={card}>
            <h3 className="text-sm font-medium">Server telemetry</h3>
            <p className="text-xs" style={dim}>The server's admin <span className="font-mono">stats</span>, refreshed every few seconds.</p>
            {s.telemetry ? <TelemetryCharts snapshot={s.telemetry} /> : <p className="mt-3 text-sm" style={dim}>Waiting for the first snapshot…</p>}
          </section>
        )}
      </ServerGate>
      <details className="rounded-xl p-3" style={card}>
        <summary className="cursor-pointer text-sm font-medium">Read a different server</summary>
        <div className="mt-3"><LiveOpsTelemetry /></div>
      </details>
    </div>
  );
}

// ----------------------------------------------------------- right dock

export function LiveOpsDetailsLive(): React.JSX.Element {
  const s = useServerLink();
  const lines = useLog();
  const rows = [
    { key: "state", value: s.phase },
    { key: "url", value: s.url ?? "—" },
    { key: "pid", value: s.pid === null ? "—" : String(s.pid) },
    { key: "tick", value: s.lastTick === null ? "—" : String(s.lastTick) },
    { key: "round trip", value: s.rttMs === null ? "—" : `${s.rttMs} ms` },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">Server</p>
      <KvTable rows={rows} />
      {s.phase !== "live" && <p className="text-xs" style={dim}>No server is running. Start one from the Live ops panel or press Play.</p>}
      <p className="text-[11px] font-semibold uppercase tracking-wider" style={dim}>Recent commands</p>
      <LogView lines={lines} max={6} />
    </div>
  );
}

export function LiveOpsViews(): Array<{ id: string; label: string; icon: string; kind: "panel"; panel: React.JSX.Element }> {
  return [
    { id: "overview", label: "Server & world", icon: "groups", kind: "panel", panel: <LiveOpsOverview /> },
    { id: "console", label: "Admin console", icon: "terminal", kind: "panel", panel: <LiveOpsConsole /> },
    { id: "telemetry", label: "Telemetry", icon: "monitoring", kind: "panel", panel: <LiveOpsTelemetryView /> },
    { id: "settings", label: "Server settings", icon: "settings", kind: "panel", panel: <ServerSettingsPanel /> },
  ];
}
