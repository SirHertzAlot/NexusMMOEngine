/**
 * The editor's console (docs/EDITOR-UI-2026.md §2.6, slice EU8).
 *
 * Both mockups carry a Console tab, and the styling reference makes it
 * one of the four the dock folds down to. We had the streams and no
 * console: the play server's log is polled into the Server tab
 * (`dock-feed.ts`), bakes and pipeline runs go to the Bakes tab, and
 * the editor's own notifications flash in a snackbar for 3.6 seconds
 * and are then gone for good — which is the worst of the three, because
 * a message you cannot scroll back to may as well not have been shown.
 *
 * This is the merge. It owns one bounded ring of entries, every source
 * writes to it, and the panel reads it. Nothing here polls: the server
 * log is pushed in by whoever is already polling it, so the console
 * adds no traffic of its own.
 */

import { createStore } from "../store.js";
import { getBakes, lineTone, subscribeBakes, type LogTone } from "../dock-feed.js";

export type ConsoleSource = "server" | "bake" | "editor";

export interface ConsoleEntry {
  /** Monotonic within a session: the order entries were recorded. */
  seq: number;
  at: number;
  source: ConsoleSource;
  level: LogTone;
  text: string;
}

/** Scrollback. Bounded, because a long play session writes a lot of lines. */
export const MAX_ENTRIES = 1000;

const entries = createStore<readonly ConsoleEntry[]>([]);
let seq = 0;

export const getConsole = entries.get;
export const subscribeConsole = entries.subscribe;
export const useConsole = entries.useValue;

/** Append one entry. Returns it, so a caller can report what it recorded. */
export function pushConsole(
  source: ConsoleSource,
  text: string,
  level: LogTone = "info",
  at = Date.now(),
): ConsoleEntry {
  const entry: ConsoleEntry = { seq: (seq += 1), at, source, level, text };
  entries.set((all) => (all.length >= MAX_ENTRIES ? [...all.slice(1), entry] : [...all, entry]));
  return entry;
}

/**
 * Push a page of server log lines, taking each line's level from the
 * same `lineTone` the Server tab colours by — one rule, not two.
 * Blank lines are dropped: they are padding in the log, not events.
 */
export function pushServerLines(lines: readonly string[], at = Date.now()): number {
  let n = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    pushConsole("server", line, lineTone(line), at);
    n += 1;
  }
  return n;
}

/** Clear the scrollback. The sources keep their own history; this is the view's. */
export function clearConsole(): void {
  entries.set([]);
}

export interface ConsoleFilter {
  sources: ReadonlySet<ConsoleSource>;
  levels: ReadonlySet<LogTone>;
  /** Case-insensitive substring. Empty matches everything. */
  text: string;
}

export const ALL_SOURCES: readonly ConsoleSource[] = ["server", "bake", "editor"];
export const ALL_LEVELS: readonly LogTone[] = ["error", "warn", "info"];

/** A filter that hides nothing — the state the console opens in. */
export function everything(): ConsoleFilter {
  return { sources: new Set(ALL_SOURCES), levels: new Set(ALL_LEVELS), text: "" };
}

export function filterEntries(
  all: readonly ConsoleEntry[],
  filter: ConsoleFilter,
): ConsoleEntry[] {
  const needle = filter.text.trim().toLowerCase();
  return all.filter(
    (e) =>
      filter.sources.has(e.source) &&
      filter.levels.has(e.level) &&
      (needle === "" || e.text.toLowerCase().includes(needle)),
  );
}

/** How many of each level are in a set of entries, for the filter chips. */
export function countLevels(all: readonly ConsoleEntry[]): Record<LogTone, number> {
  const counts: Record<LogTone, number> = { error: 0, warn: 0, info: 0 };
  for (const e of all) counts[e.level] += 1;
  return counts;
}

/** `14:03:07` — a wall clock, because that is what you compare a log to. */
export function stamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Mirror the bakes store into the console. Bakes are already kept in
 * their own store for the Bakes tab, so rather than make `pushBake` know
 * about the console — which would make dock-feed.ts import this file and
 * this file import dock-feed.ts — the bridge sits here and subscribes.
 *
 * Installed once from main.tsx. Calling it again is a no-op, so a hot
 * reload cannot double every bake line.
 */
let bakeBridge: (() => void) | null = null;

export function startBakeBridge(): () => void {
  if (bakeBridge) return bakeBridge;
  let seen = getBakes().length;
  const stop = subscribeBakes(() => {
    const all = getBakes();
    // The store is capped and drops from the front, so a shrunken list
    // means entries were evicted: take only what is genuinely new.
    if (all.length < seen) seen = Math.max(0, all.length - 1);
    for (const b of all.slice(seen)) {
      pushConsole("bake", `${b.source}: ${b.text}`, b.ok ? "info" : "error", b.at);
    }
    seen = all.length;
  });
  bakeBridge = () => {
    stop();
    bakeBridge = null;
  };
  return bakeBridge;
}
