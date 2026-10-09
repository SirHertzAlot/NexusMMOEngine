/**
 * The Release workspace (EA19, §7c.2): profiles on the left, the pipeline in
 * the middle (step cards with logs, cached by input hash, packages), the
 * local target and deploy in Details. Everything here talks to
 * `/api/editor/release/*` (release-host.ts); nothing is mocked.
 */
import * as React from "react";
import { releaseApi, type ProfileEntry } from "../release-client.js";
import { emptyProfile, type PackageManifest, type RunRecord, type StepRecord } from "../release-model.js";
import type { Health, TargetState } from "../release-targets.js";
import { MIcon, TreeItem, notify } from "./components.js";
import { Pill, createStore } from "./previews.js";

const ui = createStore<{ profile: string | null; runId: number | null; tick: number }>({ profile: null, runId: null, tick: 0 });
/** Anything that changes server-side state asks every release view to reload. */
const refresh = (): void => ui.set((p) => ({ ...p, tick: p.tick + 1 }));

const TONE: Record<StepRecord["status"], "ok" | "warn" | "err" | "info" | "plain"> = {
  passed: "ok",
  cached: "info",
  failed: "err",
  running: "warn",
  pending: "plain",
  skipped: "plain",
};
const dur = (ms?: number): string => (ms === undefined ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`);
const clock = (t: number): string => new Date(t).toLocaleTimeString();
const btn = "m3-focus h-9 rounded-full px-4 text-sm font-medium disabled:opacity-40";
const solid = { background: "var(--m3-primary)", color: "var(--m3-on-primary)" } as const;
const quiet = { border: "1px solid var(--m3-outline-variant)", color: "var(--m3-on-surface)" } as const;

function useProfiles(): { profiles: ProfileEntry[]; selected: ProfileEntry | null } {
  const { profile, tick } = ui.use();
  const [profiles, setProfiles] = React.useState<ProfileEntry[]>([]);
  React.useEffect(() => {
    releaseApi.profiles().then(setProfiles, () => undefined);
  }, [tick]);
  const selected = profiles.find((p) => p.name === profile) ?? profiles[0] ?? null;
  return { profiles, selected };
}

// ---------------------------------------------------------------- left tree

export function ReleaseTree(): React.JSX.Element {
  const { profiles, selected } = useProfiles();
  const [name, setName] = React.useState("");
  const create = (): void => {
    const n = name.trim();
    releaseApi.saveProfile(n, emptyProfile(n)).then(
      () => {
        setName("");
        ui.set((p) => ({ ...p, profile: n }));
        refresh();
      },
      (e: Error) => notify(`Profile not created: ${e.message}`),
    );
  };
  return (
    <div className="flex flex-col gap-0.5">
      {profiles.map((p) => (
        <TreeItem
          key={p.name}
          icon={p.issues.length ? "error" : "computer"}
          label={p.name}
          trailing={p.profile ? `${p.cached.length} cached` : "invalid"}
          mono
          selected={selected?.name === p.name}
          onPick={() => ui.set((s) => ({ ...s, profile: p.name, runId: null }))}
        />
      ))}
      <div className="flex items-center gap-1.5 px-2 pt-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="New profile…"
          aria-label="New profile name"
          className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none"
          style={{ borderColor: "var(--m3-outline)" }}
        />
        <button onClick={create} className={btn} style={quiet}>Add</button>
      </div>
      {selected?.profile && (
        <>
          <p className="px-3 pt-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
            {selected.name} · settings
          </p>
          <div className="px-3 font-mono text-[11px] leading-[1.9]" style={{ color: "var(--m3-on-surface-variant)" }}>
            {Object.entries(selected.profile.env).map(([k, v]) => (
              <p key={k} className="flex"><span>{k}</span><span className="ml-auto" style={{ color: "var(--m3-on-surface)" }}>{v}</span></p>
            ))}
            <p className="flex"><span>modules</span><span className="ml-auto" style={{ color: "var(--m3-on-surface)" }}>{selected.profile.modules.join(", ")}</span></p>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the pipeline

export function PipelinePanel(): React.JSX.Element {
  const { selected } = useProfiles();
  const { runId, tick } = ui.use();
  const [run, setRun] = React.useState<RunRecord | null>(null);
  const [active, setActive] = React.useState(false);
  const [runs, setRuns] = React.useState<RunRecord[]>([]);
  const [pkgs, setPkgs] = React.useState<PackageManifest[]>([]);
  const [open, setOpen] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);

  // The run on show: the chosen one, else the newest of this profile; polled while it goes.
  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const list = await releaseApi.runs();
        if (!alive) return;
        setRuns(list.runs);
        const id = runId ?? list.active ?? list.runs.find((r) => r.profile === selected?.name)?.id ?? null;
        if (id !== null) {
          const r = await releaseApi.getRun(id);
          if (!alive) return;
          setRun(r.run);
          setActive(r.active);
          if (r.active) timer = setTimeout(() => void load(), 1000);
        } else setRun(null);
        releaseApi.packages().then((p) => alive && setPkgs(p), () => undefined);
      } catch {
        /* host gone: the next action reports it */
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId, selected?.name, tick]);

  if (!selected) return <p className="text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>No build profiles yet: add one in the left panel.</p>;
  const start = (force: boolean): void => {
    releaseApi.run(selected.name, force).then(
      (id) => {
        setActive(true);
        ui.set((p) => ({ ...p, runId: id }));
        refresh();
      },
      (e: Error) => notify(`Run not started: ${e.message}`),
    );
  };
  const cachedCount = run?.steps.filter((s) => s.status === "cached").length ?? 0;
  const step = run?.steps.find((s) => s.id === open) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <strong className="text-base">{selected.name}</strong>
          <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{selected.profile?.description || "no description"}</p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {run && <span className="rounded-full border px-3 py-1 text-xs" style={{ borderColor: "var(--m3-outline-variant)" }}>⚡ {cachedCount} of {run.steps.length} steps cached</span>}
          <button className={btn} style={quiet} onClick={() => setEditing((v) => !v)}>{editing ? "Close profile" : "Edit profile"}</button>
          {active ? (
            <button className={btn} style={solid} onClick={() => void releaseApi.cancel().then(refresh)}>Cancel run</button>
          ) : (
            <>
              <button className={btn} style={quiet} disabled={!!selected.issues.length} onClick={() => start(true)} title="Ignore the cache: every step runs">Run all (no cache)</button>
              <button className={btn} style={solid} disabled={!!selected.issues.length} onClick={() => start(false)}>Run pipeline</button>
            </>
          )}
        </span>
      </div>

      {selected.issues.length > 0 && (
        <div className="rounded-xl p-3 text-xs" style={{ background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" }}>
          {selected.issues.map((i) => <p key={i}>{i}</p>)}
        </div>
      )}
      {editing && <ProfileEditor key={selected.name + tick} entry={selected} onSaved={refresh} />}

      {run ? (
        <>
          <p className="text-sm">
            <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
              run #{run.id} · commit {run.commit}{run.dirty ? " (+ uncommitted changes)" : ""} · started {clock(run.startedAt)}
            </span>{" "}
            <Pill tone={run.status === "passed" ? "ok" : run.status === "running" ? "warn" : run.status === "failed" ? "err" : "plain"}>{run.status}</Pill>
          </p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6" data-testid="pipeline-steps">
            {run.steps.map((s) => (
              <button
                key={s.id}
                onClick={() => setOpen(open === s.id ? null : s.id)}
                aria-pressed={open === s.id}
                className="m3-focus rounded-xl p-2.5 text-left"
                style={{ background: "var(--m3-surface-2)", border: open === s.id ? "1.5px solid var(--m3-primary)" : "1.5px solid transparent" }}
              >
                <p className="mb-1 text-sm font-medium">{s.label}</p>
                <Pill tone={TONE[s.status]}>{s.status}</Pill>
                <p className="mt-1.5 font-mono text-[11px] leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
                  {dur(s.durationMs)} {s.hash && `· ${s.hash.slice(0, 7)}`}
                </p>
                <p className="mt-1 line-clamp-3 text-[11px] leading-snug" style={{ color: "var(--m3-on-surface-variant)" }}>{s.summary}</p>
              </button>
            ))}
          </div>
          {step && (
            <div className="rounded-xl p-3 font-mono text-xs leading-[1.7]" style={{ background: "var(--m3-surface-0)", color: "var(--m3-on-surface-variant)" }} data-testid="step-log">
              <p className="mb-1 font-sans text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>{step.label} · {step.summary}</p>
              <div className="max-h-64 overflow-auto">
                {step.log.length === 0 && <p>no output ({step.status === "cached" ? "skipped: inputs unchanged" : step.status})</p>}
                {step.log.map((l, i) => (
                  <p key={i}><span style={{ color: "#7aa2ff" }}>{clock(l.at)}</span> {l.line}</p>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>This profile has not run yet. Run pipeline builds, bakes, tests and packages it; later runs skip the steps whose inputs did not change.</p>
      )}

      <div className="overflow-x-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <div className="p-3 pb-1 text-sm font-medium">Runs</div>
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="text-left" style={{ color: "var(--m3-on-surface-variant)" }}>
              {["Run", "Profile", "Commit", "Steps", "Time", "Result"].map((h) => <th key={h} className="px-3 py-1 font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 12).map((r) => (
              <tr key={r.id} className="cursor-pointer" onClick={() => ui.set((p) => ({ ...p, runId: r.id }))} style={r.id === run?.id ? { background: "var(--m3-secondary-container)" } : undefined}>
                <td className="px-3 py-1">#{r.id}</td>
                <td className="px-3 py-1">{r.profile}</td>
                <td className="px-3 py-1">{r.commit}</td>
                <td className="px-3 py-1">{r.steps.length} · {r.steps.filter((s) => s.status === "cached").length} cached</td>
                <td className="px-3 py-1">{dur(r.finishedAt ? r.finishedAt - r.startedAt : undefined)}</td>
                <td className="px-3 py-1"><Pill tone={r.status === "passed" ? "ok" : r.status === "failed" ? "err" : r.status === "running" ? "warn" : "plain"}>{r.status}</Pill></td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td className="px-3 py-2" colSpan={6}>no runs yet</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm font-medium">Packages</p>
        {pkgs.length === 0 && <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>none built yet</p>}
        {pkgs.map((m) => (
          <p key={m.name} className="flex flex-wrap items-center gap-x-3 font-mono text-xs leading-[2]" data-testid="package-row">
            <span>{m.name}</span>
            <span style={{ color: "var(--m3-on-surface-variant)" }}>commit {m.commit} · {m.files} files · {(m.bytes / 1e6).toFixed(1)} MB · {m.workspaces.length} workspaces · modules {m.modules.join(", ")}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function ProfileEditor({ entry, onSaved }: { entry: ProfileEntry; onSaved: () => void }): React.JSX.Element {
  const [text, setText] = React.useState(JSON.stringify(entry.profile ?? emptyProfile(entry.name), null, 2));
  const [problems, setProblems] = React.useState<string[]>([]);
  const save = (): void => {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      setProblems([`not valid JSON: ${(e as Error).message}`]);
      return;
    }
    releaseApi.saveProfile(entry.name, doc).then(
      () => {
        setProblems([]);
        notify(`Profile ${entry.name} saved`);
        onSaved();
      },
      (e: Error) => setProblems(e.message.split("; ")),
    );
  };
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Profile JSON"
        className="h-64 w-full resize-y rounded-md border bg-transparent p-2 font-mono text-xs outline-none"
        style={{ borderColor: "var(--m3-outline)" }}
      />
      {problems.map((p) => <p key={p} className="text-xs" style={{ color: "var(--m3-error)" }}>{p}</p>)}
      <div className="mt-2 flex gap-2">
        <button className={btn} style={solid} onClick={save}>Save profile</button>
        <button
          className={btn}
          style={quiet}
          onClick={() => void releaseApi.deleteProfile(entry.name).then(() => {
            ui.set((p) => ({ ...p, profile: null }));
            onSaved();
          })}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- details: the local target

export function ReleaseDetails(): React.JSX.Element {
  const { tick } = ui.use();
  const [target, setTarget] = React.useState<{ state: TargetState; health: Health | null; current: PackageManifest | null } | null>(null);
  const [pkgs, setPkgs] = React.useState<PackageManifest[]>([]);
  const [changes, setChanges] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  React.useEffect(() => {
    let alive = true;
    const load = (): void => {
      releaseApi.target().then((t) => alive && setTarget(t), () => undefined);
      releaseApi.packages().then((p) => alive && setPkgs(p), () => undefined);
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tick]);
  const newest = pkgs[0] ?? null;
  React.useEffect(() => {
    setChanges(null);
    if (newest) releaseApi.diff(newest.name).then(setChanges, () => undefined);
  }, [newest?.name, target?.state.current]);

  const act = async (what: () => Promise<{ ok: boolean; error?: string; live: string | null }>, done: string): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      const r = await what();
      setMessage(r.ok ? done : (r.error ?? "failed"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const live = target?.state.current ?? null;
  const h = target?.health ?? null;
  return (
    <div className="flex flex-col gap-2" data-testid="release-details">
      {newest && newest.name !== live && (
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="text-sm font-semibold">Deploy {newest.name} to local?</p>
          <ul className="mt-1 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
            {(changes ?? ["…"]).map((c) => <li key={c}>⇢ {c}</li>)}
          </ul>
          <button className={`${btn} mt-2`} style={solid} disabled={busy} onClick={() => void act(() => releaseApi.deploy(newest.name), `${newest.name} is live and healthy`)}>
            {busy ? "Deploying…" : "Deploy"}
          </button>
        </div>
      )}
      {message && <p className="rounded-xl p-2 text-xs" style={{ background: "var(--m3-surface-2)" }} role="status">{message}</p>}
      <p className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Target · local</p>
      <p className="flex items-center text-[13px]">
        <span>
          {live ?? "nothing deployed"}
          <br />
          <span className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            {target?.state.pid ? `pid ${target.state.pid}` : "stopped"}
            {h ? ` · ${h.server.detail}` : ""}
            {h?.edge ? ` · ${h.edge.detail}` : ""}
          </span>
        </span>
        <span className="ml-auto">{live && <Pill tone={h?.ok ? "ok" : target?.state.pid ? "err" : "plain"}>{h?.ok ? "healthy" : target?.state.pid ? "unhealthy" : "stopped"}</Pill>}</span>
      </p>
      {target?.state.pid ? (
        <button className={btn} style={quiet} disabled={busy} onClick={() => void releaseApi.stop().then(refresh)}>Stop local</button>
      ) : live ? (
        <button className={btn} style={quiet} disabled={busy} onClick={() => void act(() => releaseApi.deploy(live), `${live} is live and healthy`)}>Start {live}</button>
      ) : null}
      <p className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Releases · rollback</p>
      {(target?.state.releases ?? []).map((r) => (
        <p key={r.package + r.deployedAt} className="flex items-center gap-2 font-mono text-xs">
          <MIcon name={r.outcome === "live" ? "radio_button_checked" : r.outcome === "failed" ? "error" : "history"} size={15} />
          <span className="min-w-0 truncate">{r.package}</span>
          <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{r.rollback ? "rollback · " : ""}{r.outcome} · {clock(r.deployedAt)}</span>
          {r.outcome === "replaced" && (
            <button className="m3-focus rounded-full border px-2 py-0.5" style={quiet} disabled={busy} onClick={() => void act(() => releaseApi.rollback(r.package), `rolled back to ${r.package}`)}>
              Roll back
            </button>
          )}
        </p>
      ))}
      {(target?.state.releases.length ?? 0) === 0 && <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>No releases on this target yet.</p>}
    </div>
  );
}
