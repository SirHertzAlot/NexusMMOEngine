/**
 * Playtest storage and runs for the editor dev host (roadmap EA26).
 * Loopback routes (wired in host.ts):
 *
 *   GET    /api/editor/playtests                  → { scenarios: [{ name, content, history }] }
 *   PUT    /api/editor/playtests/<name>           → { content } → validate, then write
 *   DELETE /api/editor/playtests/<name>           → scenario and its history
 *   POST   /api/editor/playtests/<name>/run       → run on a scratch server → { run }
 *   GET    /api/editor/playtest-replays/<id>      → the replay a run saved
 *   POST   /api/editor/playtest-replays/<id>/run  → replay it → { run } (with divergedAtTick)
 *
 * Scenarios are `<repo>/content/playtests/<name>.playtest.json`, confined by
 * the name pattern; run history and replays are run output, kept under
 * `<dataDir>/playtests` (git-ignored). A refused save writes nothing. One
 * run at a time.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  expandScript,
  firstDivergence,
  pushHistory,
  validatePlaytest,
  PLAYTEST_NAME,
  type PlaytestReplay,
  type PlaytestRun,
  type PlaytestScenario,
} from "./playtest-model.js";
import type { ScratchRunner } from "./playtest-server.js";

type Reply = { status: number; body: unknown };
const REPLAY_ID = /^[a-z][a-z0-9-]{0,60}$/;

const scenarioDir = (repo: string): string => resolve(repo, "content", "playtests");
const scenarioFile = (repo: string, name: string): string => join(scenarioDir(repo), `${name}.playtest.json`);
const outDir = (dataDir: string): string => resolve(dataDir, "playtests");
const historyFile = (dataDir: string, name: string): string => join(outDir(dataDir), `${name}.history.json`);
const replayFile = (dataDir: string, id: string): string => join(outDir(dataDir), "replays", `${id}.replay.json`);

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
    .filter((f) => f.endsWith(".playtest.json"))
    .map((f) => f.slice(0, -".playtest.json".length))
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

let busy = false;

async function runOnce(runner: ScratchRunner, spec: Parameters<ScratchRunner>[0], base: Pick<PlaytestRun, "id" | "scenario" | "mode">) {
  if (busy) throw Object.assign(new Error("a playtest is already running"), { status: 409 });
  busy = true;
  const at = new Date().toISOString();
  try {
    const r = await runner(spec);
    const run: PlaytestRun = {
      ...base,
      at,
      ok: r.error === undefined && r.results.every((x) => x.ok),
      ticks: r.metrics.ticks,
      wallMs: r.wallMs,
      results: r.results,
      tickP99Ms: r.metrics.tickP99Ms,
      ...(r.error ? { error: r.error } : {}),
    };
    return { run, trace: r.metrics.trace };
  } catch (err) {
    // The scratch server could not run at all: that is a failed run worth keeping, not a crash.
    const run: PlaytestRun = { ...base, at, ok: false, ticks: 0, wallMs: 0, results: [], tickP99Ms: null, error: err instanceof Error ? err.message : String(err) };
    return { run, trace: [] };
  } finally {
    busy = false;
  }
}

export async function handlePlaytestRoute(
  repoRoot: string,
  dataDir: string,
  method: string,
  pathname: string,
  body: string | undefined,
  runner: ScratchRunner,
): Promise<Reply | null> {
  const isReplay = pathname === "/api/editor/playtest-replays" || pathname.startsWith("/api/editor/playtest-replays/");
  if (pathname !== "/api/editor/playtests" && !pathname.startsWith("/api/editor/playtests/") && !isReplay) return null;
  const bad = (status: number, error: string, extra: object = {}): Reply => ({ status, body: { ok: false, error, ...extra } });
  try {
    if (isReplay) {
      const [, , , , id, verb] = pathname.split("/");
      if (!id || !REPLAY_ID.test(id)) return bad(400, "not a replay id");
      const replay = readJson<PlaytestReplay | null>(replayFile(dataDir, id), null);
      if (!replay) return bad(404, `no replay ${id}`);
      if (method === "GET" && verb === undefined) return { status: 200, body: { ok: true, replay } };
      if (method === "POST" && verb === "run") {
        const { run, trace } = await runOnce(
          runner,
          { seed: replay.seed, bots: replay.bots, durationTicks: replay.durationTicks, inputs: replay.inputs, assertions: replay.assertions },
          { id: `${id}-r${Date.now().toString(36)}`, scenario: replay.scenario, mode: "replay" },
        );
        const done: PlaytestRun = { ...run, replay: id, divergedAtTick: trace.length === 0 ? null : firstDivergence(replay.trace, trace) };
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
      const issues = validatePlaytest(content, name);
      if (issues.length > 0) return bad(400, `invalid scenario: ${issues.length} problem${issues.length === 1 ? "" : "s"}`, { issues });
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
      const doc = readJson<unknown>(file, null);
      const issues = validatePlaytest(doc, name);
      if (issues.length > 0) return bad(400, "the scenario on disk is invalid", { issues });
      const sc = doc as PlaytestScenario;
      const inputs = expandScript(sc.script);
      const stamp = Date.now().toString(36);
      const { run, trace } = await runOnce(
        runner,
        { seed: sc.seed, bots: sc.bots, durationTicks: sc.durationTicks, inputs, assertions: sc.assertions },
        { id: `${name}-${stamp}`, scenario: name, mode: "run" },
      );
      const replay: PlaytestReplay = {
        version: 1, id: run.id, scenario: name, seed: sc.seed, bots: sc.bots, durationTicks: sc.durationTicks, inputs, assertions: sc.assertions, trace,
      };
      writeJson(replayFile(dataDir, run.id), replay);
      const done = { ...run, replay: run.id };
      record(dataDir, done);
      return { status: 200, body: { ok: true, run: done } };
    }
    return bad(404, "not found");
  } catch (err) {
    const e = err as { status?: number };
    return bad(e.status ?? 500, err instanceof Error ? err.message : String(err));
  }
}
