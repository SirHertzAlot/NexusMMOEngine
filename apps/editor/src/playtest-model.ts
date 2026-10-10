/**
 * Playtests panel data (roadmap EA26): the run and replay records the dev
 * host keeps next to the scenario documents of packages/playtest
 * (`content/playtests/<name>.json`, the format scripts/playtest.mjs runs).
 * Pure; browser-safe.
 */

export const PLAYTEST_NAME = /^[a-z][a-z0-9-]{0,47}$/;
export const MAX_HISTORY = 50;

export interface PlaytestIssue {
  path: string;
  message: string;
}

/** A scenario as the panel edits it (the package's zod schema is the authority; the host validates). */
export interface PlaytestScenario {
  name: string;
  description?: string;
  seed: number;
  ticks: number;
  bots: { count: number; home: { x: number; z: number }; radius: number };
  assertions: Array<{ type: string; label?: string; [k: string]: unknown }>;
}

export interface TracePoint {
  tick: number;
  x: number;
  z: number;
}

export interface AssertionResult {
  label: string;
  ok: boolean;
  /** The failure message, or "ok". */
  actual: string;
}

export interface PlaytestRun {
  id: string;
  scenario: string;
  at: string;
  mode: "run" | "replay";
  ok: boolean;
  ticks: number;
  wallMs: number;
  results: AssertionResult[];
  error?: string;
  /** Id of the replay this run saved or replayed. */
  replay?: string;
  /** Replays only: the first tick the re-run left the original's trace, or null when it matched. */
  divergedAtTick?: number | null;
}

/** Assertion rows from the scenario's assertions and the failure messages (each starts with its label). */
export function assertionResults(assertions: PlaytestScenario["assertions"], failures: string[]): AssertionResult[] {
  const rows = assertions.map((a): AssertionResult => {
    const label = a.label ?? a.type;
    const f = failures.find((m) => m.startsWith(`${label}:`));
    return { label, ok: f === undefined, actual: f === undefined ? "ok" : f.slice(label.length + 1).trim() };
  });
  // Failures no assertion claimed (the runner's implicit noErrors) still show.
  for (const f of failures) if (!rows.some((r) => !r.ok && f.startsWith(`${r.label}:`))) rows.push({ label: f.split(":")[0] ?? "failure", ok: false, actual: f });
  return rows;
}

/** Newest first, capped. */
export function pushHistory(history: PlaytestRun[], run: PlaytestRun): PlaytestRun[] {
  return [run, ...history].slice(0, MAX_HISTORY);
}

/** Pass rate of the newest `n` runs, 0..100 (null with no runs). */
export function passRate(history: PlaytestRun[], n = 10): number | null {
  const h = history.slice(0, n);
  return h.length === 0 ? null : Math.round((100 * h.filter((r) => r.ok).length) / h.length);
}

export const BLANK_SCENARIO = (name: string): PlaytestScenario => ({
  name,
  description: "",
  seed: 1234,
  ticks: 300,
  bots: { count: 4, home: { x: 0, z: 0 }, radius: 8 },
  assertions: [
    { type: "botCount", equals: 4, label: "all bots spawned" },
    { type: "allBotsMoved", label: "every bot moved" },
    { type: "noErrors", label: "no tick errors" },
  ],
});
