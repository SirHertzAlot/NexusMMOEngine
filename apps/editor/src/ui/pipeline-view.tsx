/**
 * EA19 pipeline view (live): build profiles, stage-by-stage run status,
 * run history, and local deploy. Replaces the PipelinePreview mockup in
 * the Release workspace.
 */
import * as React from "react";
import { callEnvelope } from "../api.js";
import { Select } from "./components.js";
import { Pill } from "./widgets.js";
import { DataTable } from "./data-table.js";
import type { BuildProfile } from "@mmo-engine/build";
import type { DeployState, RunRecord, StageState } from "../build-host.js";

function stageTone(s: StageState["status"]): "ok" | "warn" | "err" | "info" | "plain" {
  switch (s) {
    case "passed": return "ok";
    case "failed": return "err";
    case "skipped": return "plain";
    case "running": return "info";
    default: return "warn";
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function PipelineView(): React.JSX.Element {
  const [profiles, setProfiles] = React.useState<BuildProfile[]>([]);
  const [profile, setProfile] = React.useState("");
  const [run, setRun] = React.useState<RunRecord | null>(null);
  const [runs, setRuns] = React.useState<RunRecord[]>([]);
  const [deploy, setDeploy] = React.useState<DeployState | null>(null);
  const [port, setPort] = React.useState("7777");
  const [error, setError] = React.useState<string | null>(null);
  const pollRef = React.useRef<number | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [p, r, d] = await Promise.all([
        callEnvelope<{ profiles: BuildProfile[] }>("/api/editor/build/profiles", "GET"),
        callEnvelope<{ runs: RunRecord[] }>("/api/editor/build/runs", "GET"),
        callEnvelope<{ deploy: DeployState }>("/api/editor/build/deploy/status", "GET"),
      ]);
      setProfiles(p.profiles);
      setProfile((cur) => cur || p.profiles[0]?.name || "");
      setRuns(r.runs);
      setDeploy(d.deploy);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const pollRun = React.useCallback(
    (id: string) => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const { run: rec } = await callEnvelope<{ run: RunRecord }>(`/api/editor/build/runs/${id}`, "GET");
          setRun(rec);
          if (rec.status !== "running") {
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            pollRef.current = null;
            void refresh();
          }
        } catch {
          /* the host went away; polling stops on unmount */
        }
      }, 1500);
    },
    [refresh],
  );

  // Profile editor: the selected profile as JSON; Save validates on the host and writes content/build/profiles/<name>.json.
  const [draft, setDraft] = React.useState<string | null>(null);
  const [draftIssues, setDraftIssues] = React.useState<string[]>([]);
  const selected = profiles.find((p) => p.name === profile);
  const builtin = profile === "default";
  const saveDraft = async (): Promise<void> => {
    setDraftIssues([]);
    try {
      const parsed = JSON.parse(draft ?? "null") as unknown;
      const { profile: saved } = await callEnvelope<{ profile: BuildProfile }>("/api/editor/build/profiles", "PUT", { profile: parsed });
      setDraft(null);
      setProfile(saved.name);
      await refresh();
    } catch (err) {
      const b = (err as { body?: { issues?: string[] } }).body;
      setDraftIssues(b?.issues ?? [err instanceof Error ? err.message : String(err)]);
    }
  };
  const deleteProfile = async (): Promise<void> => {
    setError(null);
    try {
      const res = await fetch(`/api/editor/build/profiles/${profile}`, { method: "DELETE" });
      const b = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || b.ok === false) throw new Error(b.error ?? `HTTP ${res.status}`);
      setProfile("default");
      setDraft(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startRun = async (fresh = false): Promise<void> => {
    setError(null);
    try {
      const { run: rec } = await callEnvelope<{ run: RunRecord }>("/api/editor/build/run", "POST", { profile, fresh });
      setRun(rec);
      pollRun(rec.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startDeploy = async (): Promise<void> => {
    setError(null);
    try {
      const { deploy: d } = await callEnvelope<{ deploy: DeployState }>("/api/editor/build/deploy", "POST", { port: Number(port),
      });
      setDeploy(d);
      const t = window.setInterval(async () => {
        try {
          const { deploy: cur } = await callEnvelope<{ deploy: DeployState }>("/api/editor/build/deploy/status", "GET");
          setDeploy(cur);
          if (cur.status !== "running") window.clearInterval(t);
        } catch {
          window.clearInterval(t);
        }
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const running = run?.status === "running";
  const deployRunning = deploy?.status === "running";

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="rounded-xl p-3 text-sm" style={{ background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Select size="md"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          disabled={running}
         
        >
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </Select>
        <button
          onClick={() => void startRun()}
          disabled={running || !profile}
          className="rounded-full px-4 py-1.5 text-sm font-semibold"
          style={{ background: running ? "var(--m3-surface-2)" : "var(--m3-primary)", color: running ? "var(--m3-on-surface-variant)" : "var(--m3-on-primary)" }}
        >
          {running ? "Running…" : "▶ Run pipeline"}
        </button>
        <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          {profiles.find((p) => p.name === profile)?.description ?? ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button onClick={() => void startRun(true)} disabled={running || !profile} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: "var(--m3-surface-2)" }} title="Ignore the stage cache: every stage runs">Run all (no cache)</button>
        <button
          onClick={() => { setDraftIssues([]); setDraft(JSON.stringify(builtin ? { ...selected, name: "my-pipeline" } : selected, null, 2)); }}
          disabled={!selected}
          className="rounded-full px-3 py-1 text-xs font-semibold"
          style={{ background: "var(--m3-surface-2)" }}
          title={builtin ? "The built-in pipeline is code: edit a copy" : "Edit this profile"}
        >{builtin ? "Copy to new profile" : "Edit profile"}</button>
        <button onClick={() => void deleteProfile()} disabled={builtin || !selected || running} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: "var(--m3-surface-2)" }}>Delete profile</button>
      </div>
      {draft !== null && (
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <textarea
            aria-label="Profile JSON"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={14}
            className="w-full rounded-lg border p-2 font-mono text-xs"
            style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-0)" }}
          />
          {draftIssues.length > 0 && (
            <ul className="mt-1 font-mono text-xs" style={{ color: "var(--m3-error)" }} role="alert">
              {draftIssues.map((i) => <li key={i}>{i}</li>)}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => void saveDraft()} className="rounded-full px-4 py-1 text-sm font-semibold" style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}>Save profile</button>
            <button onClick={() => { setDraft(null); setDraftIssues([]); }} className="rounded-full px-4 py-1 text-sm" style={{ background: "var(--m3-surface-0)" }}>Cancel</button>
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
            Stages run in order from the repo root; a stage whose inputs (files or folders) are unchanged is skipped. Saved to content/build/profiles/&lt;name&gt;.json.
          </p>
        </div>
      )}

      {run && (
        <div>
          <p className="mb-2 text-sm">
            <strong>{run.profile}</strong>{" "}
            <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
              {run.id} · started {new Date(run.startedAt).toLocaleTimeString()}
            </span>{" "}
            <Pill tone={run.status === "passed" ? "ok" : run.status === "failed" ? "err" : "info"}>{run.status}</Pill>
          </p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
            {run.stages.map((s) => (
              <div key={s.id} className="rounded-xl p-2.5" style={{ background: "var(--m3-surface-2)" }}>
                <p className="mb-1 text-sm font-medium">{s.id}</p>
                <Pill tone={stageTone(s.status)}>{s.status}</Pill>
                <p className="mt-1.5 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
                  {s.status === "pending" ? "—" : fmtMs(s.ms)}
                </p>
              </div>
            ))}
          </div>
          {run.error && (
            <p className="mt-2 font-mono text-xs" style={{ color: "var(--m3-error)" }}>{run.error}</p>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <div className="p-3 pb-0 text-sm font-medium">Runs</div>
        <DataTable
          mono
          rows={runs}
          rowKey={(r) => r.id}
          columns={[
            { id: "profile", header: "Profile", nowrap: true, cell: (r) => r.profile },
            { id: "started", header: "Started", nowrap: true, cell: (r) => new Date(r.startedAt).toLocaleTimeString() },
            { id: "steps", header: "Steps", nowrap: true, cell: (r) => `${r.stages.length} · ${r.stages.filter((s) => s.status === "skipped").length} skipped` },
            { id: "time", header: "Time", nowrap: true, cell: (r) => (r.finishedAt ? fmtMs(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) : "—") },
            { id: "result", header: "Result", nowrap: true, cell: (r) => <Pill tone={r.status === "passed" ? "ok" : r.status === "failed" ? "err" : "info"}>{r.status}</Pill> },
          ]}
        />
      </div>

      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm font-medium">Deploy to local target</p>
        <div className="flex items-center gap-2">
          <label className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
            Port{" "}
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={deployRunning}
              className="w-20 rounded-lg border px-2 py-1 font-mono text-sm"
              style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-0)" }}
            />
          </label>
          <button
            onClick={() => void startDeploy()}
            disabled={deployRunning}
            className="rounded-full px-4 py-1.5 text-sm font-semibold"
            style={{ background: deployRunning ? "var(--m3-surface-0)" : "var(--m3-primary)", color: deployRunning ? "var(--m3-on-surface-variant)" : "var(--m3-on-primary)" }}
          >
            {deployRunning ? "Deploying…" : "🚀 Deploy"}
          </button>
          {deploy && deploy.status !== "idle" && (
            <span className="text-xs">
              <Pill tone={deploy.status === "ok" ? "ok" : deploy.status === "failed" ? "err" : "info"}>
                {deploy.status}{deploy.rolledBack ? " · rolled back" : ""}
              </Pill>
            </span>
          )}
        </div>
        {deploy?.error && (
          <p className="mt-2 font-mono text-xs" style={{ color: "var(--m3-error)" }}>{deploy.error}</p>
        )}
        <p className="mt-2 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          Assembles the package, verifies its manifest, swaps it in, and polls /health. A failed
          deploy restores the previous package automatically.
        </p>
      </div>
    </div>
  );
}
