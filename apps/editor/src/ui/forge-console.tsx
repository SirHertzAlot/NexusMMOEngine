/**
 * Forge console (docs/EDITOR-UI-2026.md §2.6, slice EU8) — the one tab
 * both mockups carry and we did not have.
 *
 * It is a view over `ui/console-log.ts` and nothing else: the merge,
 * the ring and the filtering live there, so this file holds no state
 * the console's behaviour depends on except which filters are on and
 * whether the view is following the tail.
 *
 * Every stream it shows was already being produced. The server log was
 * polled into the Server tab, bakes went to the Bakes tab, and the
 * editor's own notifications flashed for 3.6 seconds and were gone.
 * The console does not poll anything itself.
 */

import * as React from "react";
import {
  ALL_LEVELS,
  ALL_SOURCES,
  clearConsole,
  countLevels,
  everything,
  filterEntries,
  stamp,
  useConsole,
  type ConsoleEntry,
  type ConsoleFilter,
  type ConsoleSource,
} from "./console-log.js";
import type { LogTone } from "../dock-feed.js";

const LEVEL_TONE: Readonly<Record<LogTone, string>> = {
  error: "var(--fg-bad)",
  warn: "var(--fg-warn)",
  info: "var(--fg-text-dim)",
};

const SOURCE_LABEL: Readonly<Record<ConsoleSource, string>> = {
  server: "server",
  bake: "bake",
  editor: "editor",
};

/** Toggle one member of a set without mutating the original. */
export function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * What to tell someone looking at an empty console. "Nothing yet" and
 * "your filter hides everything" are different problems with different
 * fixes, so they get different words.
 */
export function emptyReason(total: number, shown: number): string | null {
  if (total === 0) return "Nothing logged yet. Start play mode, or run a bake.";
  if (shown === 0) return "Every line is filtered out.";
  return null;
}

export function ForgeConsoleView({
  entries,
  filter,
  onFilter,
  onClear,
}: {
  entries: readonly ConsoleEntry[];
  filter: ConsoleFilter;
  onFilter: (next: ConsoleFilter) => void;
  onClear: () => void;
}): React.JSX.Element {
  const shown = filterEntries(entries, filter);
  const counts = countLevels(entries);
  const empty = emptyReason(entries.length, shown.length);

  return (
    <section className="fg-panel flex min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-1.5 p-2.5">
        <span className="fg-label">Console</span>

        {ALL_SOURCES.map((s) => (
          <button
            key={s}
            type="button"
            className="m3-focus fg-chip fg-label"
            aria-pressed={filter.sources.has(s)}
            style={{ opacity: filter.sources.has(s) ? 1 : 0.45 }}
            onClick={() => onFilter({ ...filter, sources: toggle(filter.sources, s) })}
            title={`Show lines from ${SOURCE_LABEL[s]}`}
          >
            {SOURCE_LABEL[s]}
          </button>
        ))}

        <span className="fg-data fg-dim" aria-hidden>
          |
        </span>

        {ALL_LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className="m3-focus fg-chip fg-label"
            aria-pressed={filter.levels.has(l)}
            style={{ color: LEVEL_TONE[l], opacity: filter.levels.has(l) ? 1 : 0.45 }}
            onClick={() => onFilter({ ...filter, levels: toggle(filter.levels, l) })}
            title={`Show ${l} lines`}
          >
            {l} {counts[l]}
          </button>
        ))}

        <input
          className="fg-find fg-data m3-focus ml-auto"
          placeholder="find"
          aria-label="Filter console lines"
          value={filter.text}
          onChange={(e) => onFilter({ ...filter, text: e.target.value })}
        />
        <button type="button" className="m3-focus fg-chip fg-label" onClick={onClear} title="Clear the scrollback (the sources keep their own history)">
          clear
        </button>
      </header>

      <div className="m3-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5" role="log">
        {empty !== null && <p className="fg-data fg-dim p-2">{empty}</p>}
        {shown.map((e) => (
          <div key={e.seq} className="fg-logline">
            <span className="fg-data fg-dim">{stamp(e.at)}</span>
            <span className="fg-label" style={{ color: LEVEL_TONE[e.level] }}>
              {SOURCE_LABEL[e.source]}
            </span>
            <span className="fg-data" style={{ color: e.level === "info" ? "var(--fg-text)" : LEVEL_TONE[e.level] }}>
              {e.text}
            </span>
          </div>
        ))}
      </div>

      <footer className="px-2.5 pb-2.5">
        <span className="fg-data fg-dim">
          {shown.length === entries.length
            ? `${entries.length} lines`
            : `${shown.length} of ${entries.length} lines`}
        </span>
      </footer>
    </section>
  );
}

export function ForgeConsolePanel(): React.JSX.Element {
  const entries = useConsole();
  const [filter, setFilter] = React.useState<ConsoleFilter>(everything);
  return (
    <ForgeConsoleView
      entries={entries}
      filter={filter}
      onFilter={setFilter}
      onClear={clearConsole}
    />
  );
}
