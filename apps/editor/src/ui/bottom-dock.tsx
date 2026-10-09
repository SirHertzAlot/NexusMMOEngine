/**
 * The bottom dock's three tabs, all real: Output is the owned server's log
 * (GET /api/editor/play/status), Problems is every validator over what is on
 * disk (GET /api/editor/problems, each row links to the workspace that owns
 * it), Bakes is the release pipeline's bake steps (GET /api/editor/release/runs).
 */
import * as React from "react";
import { loadProblems, problemLink, type ProblemList } from "../problems-client.js";
import { releaseApi } from "../release-client.js";
import type { RunRecord } from "../release-model.js";

const dim = { color: "var(--m3-on-surface-variant)" } as const;

/** Poll `load` every `ms` while `on`; the latest result, the last error, and a manual refresh. */
function usePoll<T>(load: () => Promise<T>, ms: number, on: boolean): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!on) return;
    let live = true;
    const run = (): void => {
      load().then(
        (d) => live && (setData(d), setError(null)),
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    };
    run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, ms, tick]);
  return { data, error, refresh: () => setTick((n) => n + 1) };
}

/** The Problems list; App reads its counts for the tab label and the status bar. */
export function useProblems(): { list: ProblemList | null; error: string | null; refresh: () => void } {
  const p = usePoll(loadProblems, 15_000, true);
  return { list: p.data, error: p.error, refresh: p.refresh };
}

interface PlayStatus {
  running: boolean;
  log?: string[];
}
const loadStatus = (): Promise<PlayStatus> => fetch("/api/editor/play/status").then((r) => r.json() as Promise<PlayStatus>);

export const problemsLabel = (list: ProblemList | null): string => `Problems${list ? ` · ${list.errors + list.warnings}` : ""}`;

export function BottomPane({
  tab,
  visible,
  problems,
}: {
  tab: string;
  visible: boolean;
  problems: ReturnType<typeof useProblems>;
}): React.JSX.Element {
  if (tab === "problems") return <ProblemsTab {...problems} />;
  if (tab === "bakes") return <BakesTab on={visible} />;
  return <OutputTab on={visible} />;
}

function OutputTab({ on }: { on: boolean }): React.JSX.Element {
  const { data, error } = usePoll(loadStatus, 2000, on);
  const endRef = React.useRef<HTMLLIElement>(null);
  React.useEffect(() => endRef.current?.scrollIntoView({ block: "nearest" }), [data?.log?.length]);
  if (error) return <p className="text-xs" style={{ color: "var(--m3-error)" }}>Could not read the server: {error}</p>;
  if (!data) return <p className="text-xs" style={dim}>Reading the server…</p>;
  if (!data.running) return <p className="text-xs" style={dim}>Server not running. Press Play to start the owned server; its log shows here.</p>;
  return (
    <ul className="font-mono text-xs leading-relaxed" style={dim}>
      {(data.log ?? []).filter((l) => l !== "").map((l, i) => (
        <li key={i} className="whitespace-pre-wrap break-all">{l}</li>
      ))}
      <li ref={endRef} />
    </ul>
  );
}

function ProblemsTab({ list, error, refresh }: ReturnType<typeof useProblems>): React.JSX.Element {
  if (error) return <p className="text-xs" style={{ color: "var(--m3-error)" }}>Could not check the content: {error}</p>;
  if (!list) return <p className="text-xs" style={dim}>Checking the content…</p>;
  if (list.problems.length === 0) {
    return (
      <p className="text-xs" style={dim}>
        No problems. Every validator passed over the content on disk.{" "}
        <button className="underline" onClick={refresh}>Check again</button>
      </p>
    );
  }
  return (
    <ul className="font-mono text-xs leading-relaxed">
      {list.problems.map((p, i) => (
        <li key={i}>
          <a href={problemLink(p)} className="block hover:underline" title={`Open ${p.source}`}>
            <span style={{ color: p.severity === "error" ? "var(--m3-error)" : "var(--m3-tertiary)" }}>{p.severity === "error" ? "error" : "warn"}</span>{" "}
            <span style={dim}>{p.source} · {p.file}</span> {p.message}
          </a>
        </li>
      ))}
    </ul>
  );
}

const secs = (ms: number | undefined): string => (ms === undefined ? "" : ` · ${(ms / 1000).toFixed(1)} s`);

/** One line per bake step of every run, newest first. */
export function bakeLines(runs: RunRecord[]): Array<{ key: string; text: string; failed: boolean }> {
  return runs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .flatMap((r) =>
      r.steps
        .filter((s) => s.id.startsWith("bake:") && s.status !== "pending" && s.status !== "skipped")
        .map((s) => ({
          key: `${r.id}-${s.id}`,
          text: `#${r.id} ${r.profile} · ${s.label} · ${s.status}${secs(s.durationMs)}${s.summary ? ` · ${s.summary}` : ""}`,
          failed: s.status === "failed",
        })),
    );
}

function BakesTab({ on }: { on: boolean }): React.JSX.Element {
  const { data, error } = usePoll(() => releaseApi.runs(), 5000, on);
  if (error) return <p className="text-xs" style={{ color: "var(--m3-error)" }}>Could not read the pipeline: {error}</p>;
  if (!data) return <p className="text-xs" style={dim}>Reading the pipeline…</p>;
  const lines = bakeLines(data.runs);
  if (lines.length === 0) {
    return (
      <p className="text-xs" style={dim}>
        No bakes yet. Run a build profile with bakes in <a className="underline" href="#/release/pipeline">Release › Pipeline</a>.
      </p>
    );
  }
  return (
    <ul className="font-mono text-xs leading-relaxed">
      {lines.map((l) => (
        <li key={l.key} style={l.failed ? { color: "var(--m3-error)" } : dim}>{l.text}</li>
      ))}
    </ul>
  );
}
