/**
 * The bottom dock's three tabs over real data: Output (the play server's
 * log), Problems (what the open document's validation reports) and Bakes
 * (bakes and regenerations run from the editor this session).
 */

import * as React from "react";
import {
  appendLines,
  fetchServerLog,
  getBakes,
  lineTone,
  subscribeBakes,
  type LogTone,
} from "../dock-feed.js";
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

export function ProblemsPane({ label, problems }: { label: string; problems: DocProblem[] }): React.JSX.Element {
  if (label === "") return <Empty>No document is open. Problems from the open scene or game flow show here.</Empty>;
  if (problems.length === 0) return <Empty>No problems in {label}.</Empty>;
  return (
    <ul className="font-mono text-xs leading-relaxed" aria-label={`Problems in ${label}`}>
      {problems.map((p, i) => (
        <li key={i}>
          <span style={{ color: p.severity === "error" ? "var(--m3-error)" : "var(--m3-tertiary)" }}>{p.severity}</span>{" "}
          <span style={{ color: "var(--m3-on-surface-variant)" }}>{p.where}</span> {p.message}
        </li>
      ))}
    </ul>
  );
}

export function BakesPane(): React.JSX.Element {
  const bakes = React.useSyncExternalStore(subscribeBakes, getBakes);
  if (bakes.length === 0) return <Empty>No bakes yet this session. Regenerating terrain or baking dungeons from the editor is listed here.</Empty>;
  return (
    <ul className="font-mono text-xs leading-relaxed" aria-label="Bakes this session">
      {bakes.slice().reverse().map((b, i) => (
        <li key={`${b.at}-${i}`} style={{ color: b.ok ? "var(--m3-on-surface-variant)" : "var(--m3-error)" }}>
          {new Date(b.at).toLocaleTimeString()} <span style={{ color: "var(--m3-primary)" }}>[{b.source}]</span> {b.text}
        </li>
      ))}
    </ul>
  );
}
