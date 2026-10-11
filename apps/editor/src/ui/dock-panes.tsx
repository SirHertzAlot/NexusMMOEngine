/**
 * The bottom dock's three tabs over real data: Output (the play server's
 * log), Problems (every validator over the content on disk, plus what the
 * open document reports before it is saved; each row links to the view that
 * owns it) and Bakes (bakes and regenerations run from the editor this
 * session, and the pipeline's bake stages).
 */

import * as React from "react";
import {
  appendLines,
  fetchRuns,
  fetchServerLog,
  getBakes,
  lineTone,
  pipelineBakeLines,
  subscribeBakes,
  type BakeEntry,
  type LogTone,
} from "../dock-feed.js";
import { loadProblems, problemLink, type ProblemList } from "../problems-client.js";
import { getDocActions, subscribeDocActions, type DocProblem } from "./doc-actions.js";

const TONE_COLOR: Record<LogTone, string> = {
  error: "var(--m3-error)",
  warn: "var(--m3-tertiary)",
  info: "var(--m3-on-surface-variant)",
};

export interface ServerOutput {
  lines: string[];
  running: boolean;
  clear: () => void;
}

/** Poll the host for the play server's log; lines keep arriving while the dock tab is not shown. */
export function useServerOutput(everyMs = 2000): ServerOutput {
  const [lines, setLines] = React.useState<string[]>([]);
  const [running, setRunning] = React.useState(false);
  const next = React.useRef(0);
  React.useEffect(() => {
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        const page = await fetchServerLog(next.current);
        if (!live) return;
        next.current = page.next;
        setRunning(page.running);
        if (page.lines.length > 0) setLines((l) => appendLines(l, page.lines));
      } catch {
        if (live) setRunning(false);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), everyMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return { lines, running, clear: () => setLines([]) };
}

/** The open document's validation problems, empty when none is open or it does not validate. */
export function useDocProblems(): { label: string; problems: DocProblem[] } {
  const doc = React.useSyncExternalStore(subscribeDocActions, getDocActions);
  return { label: doc?.label ?? "", problems: doc?.problems ?? [] };
}

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

export interface DiskProblems {
  list: ProblemList | null;
  error: string | null;
  refresh: () => void;
}

/** Every validator over what is on disk (GET /api/editor/problems); App reads the count for the tab and status bar. */
export function useDiskProblems(): DiskProblems {
  const p = usePoll(loadProblems, 15_000, true);
  return { list: p.data, error: p.error, refresh: p.refresh };
}

/** Problems shown on the tab and the status bar: the saved content's plus the open document's unsaved ones. */
export const problemCount = (disk: DiskProblems, doc: { problems: DocProblem[] }): number =>
  (disk.list ? disk.list.errors + disk.list.warnings : 0) + doc.problems.length;

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{children}</p>;
}

export function OutputPane({ output }: { output: ServerOutput }): React.JSX.Element {
  const box = React.useRef<HTMLUListElement | null>(null);
  const stick = React.useRef(true);
  React.useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [output.lines]);
  if (output.lines.length === 0) {
    return <Empty>{output.running ? "The play server has printed nothing yet." : "No server output. Press Play to start the server and its log streams here."}</Empty>;
  }
  return (
    <ul
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="h-full overflow-auto font-mono text-xs leading-relaxed"
      aria-label="Play server output"
    >
      {output.lines.map((l, i) => (
        <li key={i} className="whitespace-pre-wrap break-words" style={{ color: l.startsWith("[editor]") ? "var(--m3-primary)" : TONE_COLOR[lineTone(l)] }}>{l}</li>
      ))}
    </ul>
  );
}

const sevColor = (severity: string): string => (severity === "error" ? "var(--m3-error)" : "var(--m3-tertiary)");
const dim = { color: "var(--m3-on-surface-variant)" } as const;

export function ProblemsPane({ doc, disk }: { doc: { label: string; problems: DocProblem[] }; disk: DiskProblems }): React.JSX.Element {
  const rows = disk.list?.problems ?? [];
  return (
    <div className="flex flex-col gap-2">
      {doc.problems.length > 0 && (
        <ul className="font-mono text-xs leading-relaxed" aria-label={`Unsaved problems in ${doc.label}`}>
          {doc.problems.map((p, i) => (
            <li key={i}>
              <span style={{ color: sevColor(p.severity) }}>{p.severity}</span> <span style={dim}>{doc.label} · {p.where}</span> {p.message}
            </li>
          ))}
        </ul>
      )}
      {disk.error ? (
        <p className="text-xs" style={{ color: "var(--m3-error)" }}>Could not check the content: {disk.error}</p>
      ) : !disk.list ? (
        <p className="text-xs" style={dim}>Checking the content…</p>
      ) : rows.length === 0 ? (
        doc.problems.length === 0 && (
          <p className="text-xs" style={dim}>
            No problems. Every validator passed over the content on disk.{" "}
            <button className="underline" onClick={disk.refresh}>Check again</button>
          </p>
        )
      ) : (
        <ul className="font-mono text-xs leading-relaxed" aria-label="Problems in the content on disk">
          {rows.map((p, i) => (
            <li key={i}>
              <a href={problemLink(p)} className="block hover:underline" title={`Open ${p.source}`}>
                <span style={{ color: sevColor(p.severity) }}>{p.severity === "error" ? "error" : "warn"}</span>{" "}
                <span style={dim}>{p.source} · {p.file}</span> {p.message}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BakesPane({ visible }: { visible: boolean }): React.JSX.Element {
  const session = React.useSyncExternalStore(subscribeBakes, getBakes);
  const runs = usePoll(fetchRuns, 5000, visible);
  const all: BakeEntry[] = [...session, ...pipelineBakeLines(runs.data ?? [])].sort((a, b) => b.at - a.at);
  if (all.length === 0) {
    return (
      <p className="text-xs" style={dim}>
        No bakes yet. Regenerate terrain or bake dungeons from the editor, or run a profile with bake stages in <a className="underline" href="#/release/pipeline">Release › Pipeline</a>.
      </p>
    );
  }
  return (
    <ul className="font-mono text-xs leading-relaxed" aria-label="Bakes">
      {all.map((b, i) => (
        <li key={`${b.at}-${i}`} style={{ color: b.ok ? "var(--m3-on-surface-variant)" : "var(--m3-error)" }}>
          {new Date(b.at).toLocaleTimeString()} <span style={{ color: "var(--m3-primary)" }}>[{b.source}]</span> {b.text}
        </li>
      ))}
    </ul>
  );
}
