/**
 * EA19 pipeline view (live): build profiles, stage-by-stage run status,
 * run history, and local deploy. Replaces the PipelinePreview mockup in
 * the Release workspace.
 */
import * as React from "react";
import { Pill, MiniTable } from "./previews.js";
import type { BuildProfile } from "@mmo-engine/build";
import type { DeployState, RunRecord, StageState } from "../build-host.js";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

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
        getJson<{ profiles: BuildProfile[] }>("/api/editor/build/profiles"),
        getJson<{ runs: RunRecord[] }>("/api/editor/build/runs"),
        getJson<{ deploy: DeployState }>("/api/editor/build/deploy/status"),
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
          const { run: rec } = await getJson<{ run: RunRecord }>(`/api/editor/build/runs/${id}`);
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

  const startRun = async (): Promise<void> => {
    setError(null);
    try {
      const { run: rec } = await getJson<{ run: RunRecord }>("/api/editor/build/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      setRun(rec);
      pollRun(rec.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startDeploy = async (): Promise<void> => {
    setError(null);
    try {
      const { deploy: d } = await getJson<{ deploy: DeployState }>("/api/editor/build/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: Number(port) }),
      });
      setDeploy(d);
      const t = window.setInterval(async () => {
        try {
          const { deploy: cur } = await getJson<{ deploy: DeployState }>("/api/editor/build/deploy/status");
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
        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          disabled={running}
          className="rounded-lg border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-2)" }}
        >
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
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
        <MiniTable
          mono
          crud="EA · release"
          head={["Profile", "Started", "Steps", "Time", "Result"]}
          rows={runs.map((r) => [
            r.profile,
            new Date(r.startedAt).toLocaleTimeString(),
            `${r.stages.length} · ${r.stages.filter((s) => s.status === "skipped").length} skipped`,
            r.finishedAt ? fmtMs(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) : "—",
            <Pill tone={r.status === "passed" ? "ok" : r.status === "failed" ? "err" : "info"}>{r.status}</Pill>,
          ])}
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
