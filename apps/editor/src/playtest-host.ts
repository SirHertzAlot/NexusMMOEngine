/**
 * Playtest storage and runs for the editor dev host (roadmap EA26), over
 * the scenario documents and headless runner of packages/playtest (the
 * same ones `scripts/playtest.mjs` runs). Loopback routes (host.ts):
 *
 *   GET    /api/editor/playtests                  → { scenarios: [{ name, content, history }] }
 *   PUT    /api/editor/playtests/<name>           → { content } → the package's validation, then write
 *   DELETE /api/editor/playtests/<name>           → scenario and its history
 *   POST   /api/editor/playtests/<name>/run       → run in-process → { run }; every run saves a replay
 *   GET    /api/editor/playtest-replays/<id>      → the (seal-checked) replay a run saved
 *   POST   /api/editor/playtest-replays/<id>/run  → re-run it → { run } with divergedAtTick
 *
 * Scenarios are `<repo>/content/playtests/<name>.json`, confined by the
 * name pattern; run history and replays are run output under
 * `<dataDir>/playtests` (git-ignored). A refused save writes nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertionResults, pushHistory, PLAYTEST_NAME, type PlaytestIssue, type PlaytestRun, type PlaytestScenario, type TracePoint } from "./playtest-model.js";

/** The slice of @mmo-engine/playtest this host uses (loaded from its build, so the editor needs no native deps). */
export interface PlaytestEngine {
  loadScenario(json: unknown): PlaytestScenario;
  runScenario(s: PlaytestScenario): Promise<{ passed: boolean; failures: string[]; ticks: number; trace: TracePoint[]; failTick: number }>;
  saveReplay(dir: string, s: PlaytestScenario, failure: { tick: number; reason: string }, trace?: TracePoint[]): string;
  loadReplay(file: string): { scenario: PlaytestScenario; failure: { tick: number; reason: string }; trace?: TracePoint[] };
  firstDivergence(a: TracePoint[], b: TracePoint[]): number | null;
}

export async function loadPlaytestEngine(repo: string): Promise<PlaytestEngine> {
  const entry = join(repo, "packages", "playtest", "dist", "src", "index.js");
  if (!existsSync(entry)) throw new Error("packages/playtest is not built (npm run build --workspace=@mmo-engine/playtest)");
  return (await import(pathToFileURL(entry).href)) as PlaytestEngine;
}

type Reply = { status: number; body: unknown };
const REPLAY_ID = /^replay-[a-z0-9-]+-\d+$/;

const scenarioDir = (repo: string): string => resolve(repo, "content", "playtests");
const scenarioFile = (repo: string, name: string): string => join(scenarioDir(repo), `${name}.json`);
const outDir = (dataDir: string): string => resolve(dataDir, "playtests");
const replayDir = (dataDir: string): string => join(outDir(dataDir), "replays");
export const historyFile = (dataDir: string, name: string): string => join(outDir(dataDir), `${name}.history.json`);
const replayFile = (dataDir: string, id: string): string => join(replayDir(dataDir), `${id}.json`);

function writeJson(file: string, value: unknown): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function listPlaytests(repo: string): string[] {
  const dir = scenarioDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((n) => PLAYTEST_NAME.test(n))
    .sort();
}

export const loadHistory = (dataDir: string, name: string): PlaytestRun[] => readJson<PlaytestRun[]>(historyFile(dataDir, name), []);

function record(dataDir: string, run: PlaytestRun): void {
  const before = loadHistory(dataDir, run.scenario);
  const next = pushHistory(before, run);
  for (const dropped of before.filter((r) => r.replay && !next.some((n) => n.replay === r.replay))) {
    rmSync(replayFile(dataDir, dropped.replay as string), { force: true });
  }
  writeJson(historyFile(dataDir, run.scenario), next);
}

/** The package's zod issues as { path, message } rows. */
function issuesOf(err: unknown): PlaytestIssue[] {
  const zod = (err as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues;
  if (Array.isArray(zod)) return zod.map((i) => ({ path: (i.path ?? []).join("."), message: i.message ?? "invalid" }));
  return [{ path: "", message: err instanceof Error ? err.message : String(err) }];
}

let busy = false;

export async function handlePlaytestRoute(
  repoRoot: string,
  dataDir: string,
  method: string,
  pathname: string,
  body: string | undefined,
  engineOf: () => Promise<PlaytestEngine> = () => loadPlaytestEngine(repoRoot),
): Promise<Reply | null> {
  const isReplay = pathname === "/api/editor/playtest-replays" || pathname.startsWith("/api/editor/playtest-replays/");
  if (pathname !== "/api/editor/playtests" && !pathname.startsWith("/api/editor/playtests/") && !isReplay) return null;
  const bad = (status: number, error: string, extra: object = {}): Reply => ({ status, body: { ok: false, error, ...extra } });

  /** One run (or replay re-run) with the one-at-a-time rule; a throwing run is a failed run worth keeping. */
  async function execute(scenario: PlaytestScenario, base: Pick<PlaytestRun, "id" | "mode">): Promise<{ run: PlaytestRun; trace: TracePoint[]; failTick: number }> {
    if (busy) throw Object.assign(new Error("a playtest is already running"), { status: 409 });
    busy = true;
    const at = new Date().toISOString();
    const t0 = Date.now();
    try {
      const engine = await engineOf();
      const r = await engine.runScenario(scenario);
      const run: PlaytestRun = { ...base, scenario: scenario.name, at, ok: r.passed, ticks: r.ticks, wallMs: Date.now() - t0, results: assertionResults(scenario.assertions, r.failures) };
      return { run, trace: r.trace, failTick: r.failTick };
    } catch (err) {
      const run: PlaytestRun = { ...base, scenario: scenario.name, at, ok: false, ticks: 0, wallMs: Date.now() - t0, results: [], error: err instanceof Error ? err.message : String(err) };
      return { run, trace: [], failTick: 0 };
    } finally {
      busy = false;
    }
  }

  try {
    if (isReplay) {
      const [, , , , id, verb] = pathname.split("/");
      if (!id || !REPLAY_ID.test(id)) return bad(400, "not a replay id");
      if (!existsSync(replayFile(dataDir, id))) return bad(404, `no replay ${id}`);
      const engine = await engineOf();
      const replay = engine.loadReplay(replayFile(dataDir, id));
      if (method === "GET" && verb === undefined) return { status: 200, body: { ok: true, replay } };
      if (method === "POST" && verb === "run") {
        const { run, trace } = await execute(replay.scenario, { id: `${id}-r${Date.now().toString(36)}`, mode: "replay" });
        const done: PlaytestRun = { ...run, replay: id, divergedAtTick: run.error || !replay.trace ? null : engine.firstDivergence(replay.trace, trace) };
        record(dataDir, done);
        return { status: 200, body: { ok: true, run: done } };
      }
      return bad(404, "not found");
    }

    if (pathname === "/api/editor/playtests") {
      if (method !== "GET") return bad(404, "not found");
      const scenarios = listPlaytests(repoRoot).map((name) => ({
        name,
        content: readJson<unknown>(scenarioFile(repoRoot, name), null),
        history: loadHistory(dataDir, name),
      }));
      return { status: 200, body: { ok: true, scenarios } };
    }

    const [, , , , name, verb] = pathname.split("/");
    if (!name || !PLAYTEST_NAME.test(name)) return bad(400, "not a scenario name");

    if (method === "PUT" && verb === undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? "") as unknown;
      } catch {
        return bad(400, "request body is not valid JSON");
      }
      if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) return bad(400, 'need a JSON body shaped like {"content": …}');
      const content = (parsed as { content: unknown }).content;
      const engine = await engineOf();
      try {
        const sc = engine.loadScenario(content);
        if (sc.name !== name) return bad(400, "invalid scenario: 1 problem", { issues: [{ path: "name", message: `name must match the file (${name})` }] });
      } catch (err) {
        const issues = issuesOf(err);
        return bad(400, `invalid scenario: ${issues.length} problem${issues.length === 1 ? "" : "s"}`, { issues });
      }
      writeJson(scenarioFile(repoRoot, name), content);
      return { status: 200, body: { ok: true } };
    }
    if (method === "DELETE" && verb === undefined) {
      if (!existsSync(scenarioFile(repoRoot, name))) return bad(404, `no scenario ${name}`);
      for (const r of loadHistory(dataDir, name)) if (r.replay) rmSync(replayFile(dataDir, r.replay), { force: true });
      rmSync(scenarioFile(repoRoot, name), { force: true });
      rmSync(historyFile(dataDir, name), { force: true });
      return { status: 200, body: { ok: true } };
    }
    if (method === "POST" && verb === "run") {
      const file = scenarioFile(repoRoot, name);
      if (!existsSync(file)) return bad(404, `no scenario ${name}`);
      const engine = await engineOf();
      let sc: PlaytestScenario;
      try {
        sc = engine.loadScenario(readJson<unknown>(file, null));
      } catch (err) {
        return bad(400, "the scenario on disk is invalid", { issues: issuesOf(err) });
      }
      const { run, trace, failTick } = await execute(sc, { id: `${name}-${Date.now().toString(36)}`, mode: "run" });
      let done: PlaytestRun = run;
      if (!run.error) {
        const saved = engine.saveReplay(replayDir(dataDir), sc, { tick: failTick, reason: run.ok ? "passed" : (run.results.find((r) => !r.ok)?.actual ?? "failed") }, trace);
        done = { ...run, replay: saved.replace(/\\/g, "/").split("/").pop()?.replace(/\.json$/, "") };
      }
      record(dataDir, done);
      return { status: 200, body: { ok: true, run: done } };
    }
    return bad(404, "not found");
  } catch (err) {
    const e = err as { status?: number };
    return bad(e.status ?? 500, err instanceof Error ? err.message : String(err));
  }
}
