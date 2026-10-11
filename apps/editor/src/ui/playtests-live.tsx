/**
 * Playtests (roadmap EA26): scenario documents in content/playtests, run
 * headless on a scratch server, with results history and replays you can
 * scrub and re-run. Everything here talks to the dev host; nothing is
 * sample data.
 */
import * as React from "react";
import {
  deleteScenario, listScenarios, loadReplay, runReplay, runScenario, saveScenario, PlaytestSaveError,
  type ScenarioEntry,
} from "../playtest-client.js";
import {
  BLANK_SCENARIO, PLAYTEST_NAME, passRate, validatePlaytest,
  type PlaytestIssue, type PlaytestReplay, type PlaytestRun, type PlaytestScenario,
} from "../playtest-model.js";
import { Badge, Button, Input, notify } from "./components.js";
import { Chart, StatTile } from "./charts.js";
import { createSlot } from "../store.js";
import { selectedScenario } from "./live-selection.js";

const dim = { color: "var(--m3-on-surface-variant)" } as const;
const card = { background: "var(--m3-surface-2)" } as const;
const pill = (ok: boolean): React.JSX.Element => <Badge tone={ok ? "ok" : "bad"}>{ok ? "passed" : "failed"}</Badge>;

/** The scenario the panel is showing, for the right-dock Details. */
const shownScenario = createSlot<ScenarioEntry>();

/** Right-dock Details for the Playtests view: the selected scenario's real numbers. */
export function PlaytestDetails(): React.JSX.Element {
  const e = shownScenario.use();
  if (!e?.content) return <p className="text-xs" style={dim}>Select a scenario.</p>;
  const { content: c, history } = e;
  const last = history[0];
  const rate = passRate(history);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="font-mono text-sm font-semibold">{e.name}</p>
      <p style={dim}>{c.description || "No description."}</p>
      <p style={dim}>{c.bots} bots · {c.durationTicks} ticks · seed {c.seed} · {c.assertions.length} assertions · {c.script.length} scripted inputs</p>
      <p>{rate === null ? "Never run." : `Pass rate ${rate}% over the last ${Math.min(10, history.length)} runs.`}</p>
      {last && (
        <p style={dim}>
          Last: {last.ok ? "passed" : "failed"} {new Date(last.at).toLocaleString()}
          {last.mode === "replay" ? (last.divergedAtTick == null ? " · replay matched" : ` · replay diverged at tick ${last.divergedAtTick}`) : ""}
        </p>
      )}
      <p style={dim}>CLI: node scripts/playtest.mjs content/playtests/{e.name}.playtest.json</p>
    </div>
  );
}

export function PlaytestsPanel(): React.JSX.Element {
  const [list, setList] = React.useState<ScenarioEntry[] | null>(null);
  const [error, setError] = React.useState("");
  const sel = selectedScenario.use();
  const setSel = selectedScenario.set;
  const [newName, setNewName] = React.useState("");

  const reload = React.useCallback(async (select?: string) => {
    try {
      const l = await listScenarios();
      setList(l);
      setError("");
      setSel((cur) => select ?? (cur && l.some((s) => s.name === cur) ? cur : (l[0]?.name ?? null)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  React.useEffect(() => void reload(), [reload]);
  React.useEffect(() => {
    const e = list?.find((x) => x.name === sel);
    return e ? shownScenario.claim(e) : undefined;
  }, [list, sel]);

  async function create(): Promise<void> {
    if (!PLAYTEST_NAME.test(newName)) return void notify("Name: lowercase letters, digits and dashes, starting with a letter.");
    if (list?.some((s) => s.name === newName)) return void notify(`${newName} already exists.`);
    try {
      await saveScenario(newName, BLANK_SCENARIO(newName));
      setNewName("");
      await reload(newName);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }

  if (error && !list) return <p className="p-3 text-sm text-red-400">Could not read content/playtests: {error}</p>;
  if (!list) return <p className="p-3 text-sm" style={dim}>Reading content/playtests…</p>;
  const entry = list.find((s) => s.name === sel) ?? null;
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[230px_1fr]">
      <div className="flex flex-col gap-2 rounded-xl p-2" style={card}>
        <ul className="flex flex-col gap-1" aria-label="Scenarios">
          {list.map((s) => {
            const last = s.history[0];
            return (
              <li key={s.name}>
                <button
                  onClick={() => setSel(s.name)}
                  aria-current={sel === s.name ? "true" : undefined}
                  className="m3-focus w-full rounded-xl px-3 py-2 text-left"
                  style={sel === s.name ? { background: "var(--m3-secondary-container)" } : undefined}
                >
                  <span className="flex items-center font-mono text-xs font-semibold">
                    {s.name}
                    <span className="ml-auto">{last ? pill(last.ok) : <Badge>not run</Badge>}</span>
                  </span>
                  <span className="font-mono text-[11px]" style={dim}>
                    {s.content ? `${s.content.bots} bots · ${s.content.durationTicks} ticks · seed ${s.content.seed}` : "unreadable"}
                  </span>
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="px-2 py-1 text-xs" style={dim}>No scenarios yet. Name one below.</li>}
        </ul>
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Input className="h-8 font-mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new-scenario" aria-label="New scenario name" />
          <Button size="sm" type="submit">New</Button>
        </form>
      </div>
      {entry?.content ? (
        <ScenarioView key={entry.name} entry={entry} onChanged={reload} />
      ) : (
        <p className="p-3 text-sm" style={dim}>{entry ? `${entry.name} is not readable JSON.` : "Select or create a scenario."}</p>
      )}
    </div>
  );
}

function ScenarioView({ entry, onChanged }: { entry: ScenarioEntry; onChanged: (select?: string) => Promise<void> }): React.JSX.Element {
  const saved = entry.content as PlaytestScenario;
  const [doc, setDoc] = React.useState(saved);
  const [scriptText, setScriptText] = React.useState(() => JSON.stringify(saved.script, null, 2));
  const [assertText, setAssertText] = React.useState(() => JSON.stringify(saved.assertions, null, 2));
  const [issues, setIssues] = React.useState<PlaytestIssue[]>([]);
  const [running, setRunning] = React.useState(false);
  const [lastRun, setLastRun] = React.useState<PlaytestRun | null>(entry.history[0] ?? null);
  const [replayOf, setReplayOf] = React.useState<string | null>(entry.history[0]?.replay ?? null);

  // The edited document: the fields plus the two JSON areas; null when a JSON area does not parse.
  const edited = React.useMemo((): { doc: PlaytestScenario | null; problems: PlaytestIssue[] } => {
    let script: unknown, assertions: unknown;
    const problems: PlaytestIssue[] = [];
    try { script = JSON.parse(scriptText); } catch { problems.push({ path: "script", message: "not valid JSON" }); }
    try { assertions = JSON.parse(assertText); } catch { problems.push({ path: "assertions", message: "not valid JSON" }); }
    if (problems.length > 0) return { doc: null, problems };
    const next = { ...doc, script, assertions } as PlaytestScenario;
    return { doc: next, problems: validatePlaytest(next, entry.name) };
  }, [doc, scriptText, assertText, entry.name]);

  const dirty = JSON.stringify(edited.doc) !== JSON.stringify(saved);
  const shown = issues.length > 0 ? issues : edited.problems;

  async function save(): Promise<boolean> {
    if (!edited.doc || edited.problems.length > 0) return false;
    try {
      await saveScenario(entry.name, edited.doc);
      setIssues([]);
      await onChanged(entry.name);
      return true;
    } catch (e) {
      if (e instanceof PlaytestSaveError) setIssues(e.issues);
      notify(e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  async function run(): Promise<void> {
    if (dirty && !(await save())) return;
    setRunning(true);
    try {
      const r = await runScenario(entry.name);
      setLastRun(r);
      setReplayOf(r.replay ?? null);
      await onChanged(entry.name);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }
  async function replay(): Promise<void> {
    if (!replayOf) return;
    setRunning(true);
    try {
      const r = await runReplay(replayOf);
      setLastRun(r);
      await onChanged(entry.name);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }
  const field = (label: string, key: "seed" | "bots" | "durationTicks"): React.JSX.Element => (
    <label className="flex flex-col gap-0.5 text-xs" style={dim}>
      {label}
      <Input className="h-8 font-mono" style={{ width: 112 }} value={String(doc[key])} inputMode="numeric" onChange={(e) => setDoc({ ...doc, [key]: e.target.value === "" ? Number.NaN : Number(e.target.value) })} />
    </label>
  );
  const hist = entry.history;
  const p99s = hist.filter((r) => r.tickP99Ms !== null).map((r) => r.tickP99Ms as number).reverse();
  const rate = passRate(hist);

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-xl p-3" style={card}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-sm font-semibold">{entry.name}</h3>
          <span className="text-xs" style={dim}>content/playtests/{entry.name}.playtest.json</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={async () => {
              try { await deleteScenario(entry.name); await onChanged(); } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
            }}>Delete</Button>
            <Button size="sm" variant="outline" disabled={!dirty || edited.problems.length > 0} onClick={() => void save()}>Save</Button>
            <Button size="sm" disabled={running || edited.problems.length > 0} onClick={() => void run()}>{running ? "Running…" : "Run"}</Button>
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {field("Seed", "seed")}
          {field("Bots", "bots")}
          {field("Duration (ticks, 30/s)", "durationTicks")}
          <label className="flex min-w-48 flex-1 flex-col gap-0.5 text-xs" style={dim}>
            Description
            <Input className="h-8" value={doc.description ?? ""} onChange={(e) => setDoc({ ...doc, description: e.target.value })} />
          </label>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label className="flex flex-col gap-0.5 text-xs" style={dim}>
            Bot script (inputs at ticks from the start: admin, move, stop, chat)
            <textarea className="m3-focus h-44 rounded-lg p-2 font-mono text-xs" style={{ background: "var(--m3-surface-3)", color: "var(--m3-on-surface)" }} value={scriptText} onChange={(e) => setScriptText(e.target.value)} spellCheck={false} aria-label="Bot script" />
          </label>
          <label className="flex flex-col gap-0.5 text-xs" style={dim}>
            Assertions (connected, no-errors, tick-p99-ms, moved, stays-within, admin-ok, admin-reply-contains)
            <textarea className="m3-focus h-44 rounded-lg p-2 font-mono text-xs" style={{ background: "var(--m3-surface-3)", color: "var(--m3-on-surface)" }} value={assertText} onChange={(e) => setAssertText(e.target.value)} spellCheck={false} aria-label="Assertions" />
          </label>
        </div>
        {shown.length > 0 && (
          <ul className="mt-2 text-xs text-red-400" aria-label="Scenario problems">
            {shown.map((i, k) => <li key={k} className="font-mono">{i.path || "scenario"}: {i.message}</li>)}
          </ul>
        )}
      </section>

      {running && <p className="rounded-xl p-3 text-sm" style={card} role="status">Running on a scratch server (its own port and data; yours is not touched). This takes a few seconds plus the scenario's length…</p>}
      {lastRun && !running && <RunResult run={lastRun} onReplay={replayOf ? () => void replay() : undefined} />}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_260px]">
        {replayOf ? <ReplayScrubber id={replayOf} /> : <section className="rounded-xl p-3 text-sm" style={{ ...card, ...dim }}>Run the scenario to record a replay.</section>}
        <section className="flex flex-col gap-2 rounded-xl p-3" style={card}>
          <p className="font-mono text-[11px]" style={dim}>HISTORY · {hist.length} RUN{hist.length === 1 ? "" : "S"}</p>
          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Pass rate" value={rate === null ? "—" : `${rate}%`} sub="last 10 runs" accent={rate === null ? undefined : rate === 100 ? "#9CD67D" : "#FFB4AB"} />
            <StatTile label="Tick p99" value={hist[0]?.tickP99Ms != null ? `${hist[0].tickP99Ms.toFixed(1)} ms` : "—"} sub="latest run" />
          </div>
          {p99s.length >= 2 && <Chart points={p99s} color="#B9C3FF" height={70} caption="tick p99 per run, oldest to newest" />}
          <ol className="flex max-h-56 flex-col gap-1 overflow-auto" aria-label="Run history">
            {hist.map((r) => (
              <li key={r.id}>
                <button className="m3-focus flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left font-mono text-xs" onClick={() => { setLastRun(r); if (r.replay) setReplayOf(r.replay); }}>
                  <span>{new Date(r.at).toLocaleTimeString()}</span>
                  <span style={dim}>{r.mode}</span>
                  <span className="ml-auto">{pill(r.ok)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function RunResult({ run, onReplay }: { run: PlaytestRun; onReplay?: () => void }): React.JSX.Element {
  return (
    <section className="rounded-xl p-3" style={card} aria-label="Run result">
      <div className="flex flex-wrap items-center gap-2">
        {pill(run.ok)}
        <span className="text-sm font-medium">{run.mode === "replay" ? "Replay" : "Run"} · {run.ticks} ticks · {(run.wallMs / 1000).toFixed(1)} s</span>
        <span className="font-mono text-xs" style={dim}>{run.id}</span>
        {run.mode === "replay" && (
          <Badge tone={run.divergedAtTick == null ? "ok" : "warn"}>
            {run.divergedAtTick == null ? "trace matched the original" : `trace diverged at tick ${run.divergedAtTick}`}
          </Badge>
        )}
        {onReplay && <Button size="sm" variant="outline" className="ml-auto" onClick={onReplay}>Replay these inputs</Button>}
      </div>
      {run.error && <p className="mt-2 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "#93000A", color: "#FFDAD6" }}>{run.error}</p>}
      {run.results.length > 0 && (
        <table className="mt-2 w-full border-collapse text-[12.5px]">
          <thead><tr>{["Assertion", "Actual", ""].map((h) => <th key={h} className="px-2 text-left font-medium" style={{ ...dim, height: 28 }}>{h}</th>)}</tr></thead>
          <tbody>
            {run.results.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #2a2b31" }}>
                <td className="px-2 py-1">{r.label}</td>
                <td className="px-2 font-mono">{r.actual}</td>
                <td className="px-2 text-right">{pill(r.ok)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The recorded position trace on a map, with a tick scrubber. */
function ReplayScrubber({ id }: { id: string }): React.JSX.Element {
  const [replay, setReplay] = React.useState<PlaytestReplay | null>(null);
  const [tick, setTick] = React.useState(0);
  const [err, setErr] = React.useState("");
  React.useEffect(() => {
    setReplay(null);
    setErr("");
    loadReplay(id).then((r) => { setReplay(r); setTick(r.trace.at(-1)?.tick ?? 0); }).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [id]);
  if (err) return <section className="rounded-xl p-3 text-sm text-red-400" style={card}>Replay {id}: {err}</section>;
  if (!replay) return <section className="rounded-xl p-3 text-sm" style={{ ...card, ...dim }}>Loading replay…</section>;
  const tr = replay.trace;
  if (tr.length === 0) return <section className="rounded-xl p-3 text-sm" style={{ ...card, ...dim }}>This run recorded no positions (it never got a world).</section>;
  const xs = tr.map((p) => p.x), zs = tr.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const span = Math.max(maxX - minX, maxZ - minZ, 4);
  const W = 700, H = 280, pad = 20;
  const sx = (x: number): number => pad + ((x - minX) / span) * (H - 2 * pad);
  const sy = (z: number): number => pad + ((z - minZ) / span) * (H - 2 * pad);
  const path = tr.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.z).toFixed(1)}`).join(" ");
  const at = [...tr].reverse().find((p) => p.tick <= tick) ?? tr[0];
  const maxTick = tr.at(-1)?.tick ?? 0;
  const events = replay.inputs.filter((i) => i.tick <= tick).length;
  return (
    <section className="rounded-xl p-3" style={card} aria-label="Replay">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl" style={{ background: "#14241a" }} role="img" aria-label="Replay trace map">
        <path d={path} fill="none" stroke="#7d8aa8" strokeWidth="1.5" />
        <circle cx={sx(tr[0].x)} cy={sy(tr[0].z)} r="4" fill="#9CD67D" />
        <circle cx={sx(at.x)} cy={sy(at.z)} r="5" fill="#FFB59A" data-testid="replay-marker" />
        <text x={pad} y={H - 6} fill="#9aa" fontSize="11" fontFamily="monospace">seed {replay.seed} · {replay.bots} bots · x {minX.toFixed(0)}..{maxX.toFixed(0)} z {minZ.toFixed(0)}..{maxZ.toFixed(0)}</text>
      </svg>
      <div className="mt-2 flex items-center gap-2 text-xs" style={dim}>
        <input type="range" min={0} max={maxTick} value={tick} onChange={(e) => setTick(Number(e.target.value))} className="flex-1" aria-label="Replay tick" />
        <span className="font-mono">tick {tick} / {maxTick} · {events} of {replay.inputs.length} inputs sent</span>
      </div>
    </section>
  );
}
