/** Browser-safe HTTP adapter for the Playtests panel (host side: playtest-host.ts). */
import type { PlaytestIssue, TracePoint, PlaytestRun, PlaytestScenario } from "./playtest-model.js";

export interface ScenarioEntry {
  name: string;
  content: PlaytestScenario | null;
  history: PlaytestRun[];
}

/** What a replay file holds, for the scrubber. */
export interface PlaytestReplay {
  scenario: PlaytestScenario;
  failure: { tick: number; reason: string };
  trace?: TracePoint[];
}

export class PlaytestSaveError extends Error {
  constructor(message: string, readonly issues: PlaytestIssue[]) {
    super(message);
    this.name = "PlaytestSaveError";
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { ok?: boolean; error?: string; issues?: PlaytestIssue[] } & T;
  if (!res.ok || json.ok === false) {
    throw new PlaytestSaveError(json.error ?? `HTTP ${res.status}`, Array.isArray(json.issues) ? json.issues : []);
  }
  return json;
}

export const listScenarios = async (): Promise<ScenarioEntry[]> => (await call<{ scenarios: ScenarioEntry[] }>("GET", "/api/editor/playtests")).scenarios;
export const saveScenario = async (name: string, content: PlaytestScenario): Promise<void> => void (await call("PUT", `/api/editor/playtests/${name}`, { content }));
export const deleteScenario = async (name: string): Promise<void> => void (await call("DELETE", `/api/editor/playtests/${name}`));
export const runScenario = async (name: string): Promise<PlaytestRun> => (await call<{ run: PlaytestRun }>("POST", `/api/editor/playtests/${name}/run`)).run;
export const loadReplay = async (id: string): Promise<PlaytestReplay> => (await call<{ replay: PlaytestReplay }>("GET", `/api/editor/playtest-replays/${id}`)).replay;
export const runReplay = async (id: string): Promise<PlaytestRun> => (await call<{ run: PlaytestRun }>("POST", `/api/editor/playtest-replays/${id}/run`)).run;
