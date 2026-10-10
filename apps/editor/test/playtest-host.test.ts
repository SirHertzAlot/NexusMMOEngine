/** Playtest host over the real packages/playtest build: confined scenario files, validated saves, runs with history and replays. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handlePlaytestRoute, loadPlaytestEngine, type PlaytestEngine } from "../src/playtest-host.js";
import { BLANK_SCENARIO, MAX_HISTORY, type PlaytestRun } from "../src/playtest-model.js";

const REAL_REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");

interface Dirs { repo: string; data: string }

function dirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), "mmo-playtest-host-"));
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "data"));
  return { repo: join(root, "repo"), data: join(root, "data") };
}

const real = loadPlaytestEngine(REAL_REPO);
/** The real engine; `shift` moves the re-run's trace from tick 3 on, standing in for a sim that changed. */
const engine = (shift = 0) => async (): Promise<PlaytestEngine> => {
  const e = await real;
  return shift === 0 ? e : { ...e, runScenario: async (s) => { const r = await e.runScenario(s); return { ...r, trace: r.trace.map((p) => (p.tick >= 3 ? { ...p, x: p.x + shift } : p)) }; } };
};

const call = (d: Dirs, method: string, path: string, body?: unknown, eng = engine()) =>
  handlePlaytestRoute(d.repo, d.data, method, path, body === undefined ? undefined : JSON.stringify(body), eng);
const save = (d: Dirs, name = "smoke", doc: object = BLANK_SCENARIO(name)) => call(d, "PUT", `/api/editor/playtests/${name}`, { content: doc });
const runBody = (r: Awaited<ReturnType<typeof call>>): PlaytestRun => (r?.body as { run: PlaytestRun }).run;

describe("playtest routes", () => {
  it("ignores other paths", async () => {
    assert.equal(await call({ repo: "x", data: "y" }, "GET", "/api/editor/flow"), null);
  });
  it("saves a valid scenario (keeping its description), lists it with an empty history", async () => {
    const d = dirs();
    assert.equal((await save(d, "smoke", { ...BLANK_SCENARIO("smoke"), description: "keeps me" }))?.status, 200);
    const list = (await call(d, "GET", "/api/editor/playtests"))?.body as { scenarios: Array<{ name: string; history: unknown[]; content: { description: string } }> };
    assert.deepEqual(list.scenarios.map((s) => [s.name, s.history.length, s.content.description]), [["smoke", 0, "keeps me"]]);
  });
  it("a refused save answers 400 with issues and writes nothing", async () => {
    const d = dirs();
    const r = await save(d, "smoke", { ...BLANK_SCENARIO("smoke"), assertions: [] });
    assert.equal(r?.status, 400);
    assert.ok((r?.body as { issues: unknown[] }).issues.length > 0);
    assert.equal(existsSync(join(d.repo, "content", "playtests")), false);
  });
  it("refuses names that could leave the folder and a name that disagrees with the file", async () => {
    const d = dirs();
    assert.equal((await save(d, "..%2Fx", BLANK_SCENARIO("x")))?.status, 400);
    assert.equal((await save(d, "Bad_Name", BLANK_SCENARIO("x")))?.status, 400);
    assert.equal((await save(d, "smoke", BLANK_SCENARIO("other")))?.status, 400);
    assert.equal((await call(d, "GET", "/api/editor/playtest-replays/..%2F..%2Fx"))?.status, 400);
    assert.equal(existsSync(join(d.repo, "content")), false);
  });
  it("a run records history and a sealed replay with the scenario's trace", async () => {
    const d = dirs();
    await save(d);
    const run = runBody(await call(d, "POST", "/api/editor/playtests/smoke/run"));
    assert.equal(run.ok, true);
    assert.deepEqual(run.results.map((r) => r.ok), [true, true, true]);
    const replay = ((await call(d, "GET", `/api/editor/playtest-replays/${run.replay}`))?.body as { replay: { scenario: { seed: number }; trace: unknown[] } }).replay;
    assert.equal(replay.scenario.seed, 1234);
    assert.equal(replay.trace.length, 300);
    const hist = ((await call(d, "GET", "/api/editor/playtests"))?.body as { scenarios: Array<{ history: PlaytestRun[] }> }).scenarios[0].history;
    assert.equal(hist.length, 1);
  });
  it("a failing run is kept as failed with its assertion; replaying reports where the trace diverged", async () => {
    const d = dirs();
    await save(d, "smoke", { ...BLANK_SCENARIO("smoke"), assertions: [{ type: "botCount", equals: 99, label: "ninety-nine bots" }] });
    const first = runBody(await call(d, "POST", "/api/editor/playtests/smoke/run"));
    assert.equal(first.ok, false);
    assert.match(first.results[0].actual, /expected 99 bots/);
    const same = runBody(await call(d, "POST", `/api/editor/playtest-replays/${first.replay}/run`));
    assert.equal(same.mode, "replay");
    assert.equal(same.divergedAtTick, null, "the sim is deterministic: a replay matches its original");
    const changed = runBody(await call(d, "POST", `/api/editor/playtest-replays/${first.replay}/run`, undefined, engine(5)));
    assert.equal(changed.divergedAtTick, 3);
  });
  it("a tampered replay is refused", async () => {
    const d = dirs();
    await save(d);
    const run = runBody(await call(d, "POST", "/api/editor/playtests/smoke/run"));
    const file = join(d.data, "playtests", "replays", `${run.replay}.json`);
    writeFileSync(file, readFileSync(file, "utf8").replace('"seed": 1234', '"seed": 1235'));
    assert.equal((await call(d, "GET", `/api/editor/playtest-replays/${run.replay}`))?.status, 500);
  });
  it("an engine that cannot load answers an error, not a crash", async () => {
    const d = dirs();
    await save(d);
    const r = await call(d, "POST", "/api/editor/playtests/smoke/run", undefined, () => Promise.reject(new Error("not built")));
    assert.equal(r?.status, 500);
  });
  it("answers 409 while another run is going", async () => {
    const d = dirs();
    await save(d);
    let release: () => void = () => {};
    const slow = async (): Promise<PlaytestEngine> => {
      const e = await real;
      return { ...e, runScenario: (s) => new Promise((res) => void (release = () => void e.runScenario(s).then(res))) };
    };
    const first = call(d, "POST", "/api/editor/playtests/smoke/run", undefined, slow);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call(d, "POST", "/api/editor/playtests/smoke/run"))?.status, 409);
    release();
    await first;
  });
  it("history is capped and replays of dropped runs are deleted", async () => {
    const d = dirs();
    await save(d);
    for (let i = 0; i < MAX_HISTORY + 2; i++) await call(d, "POST", "/api/editor/playtests/smoke/run");
    const hist = ((await call(d, "GET", "/api/editor/playtests"))?.body as { scenarios: Array<{ history: PlaytestRun[] }> }).scenarios[0].history;
    assert.equal(hist.length, MAX_HISTORY);
    assert.equal(readdirSync(join(d.data, "playtests", "replays")).length, MAX_HISTORY);
  });
  it("deleting a scenario removes its file, history and replays", async () => {
    const d = dirs();
    await save(d);
    await call(d, "POST", "/api/editor/playtests/smoke/run");
    assert.equal((await call(d, "DELETE", "/api/editor/playtests/smoke"))?.status, 200);
    assert.equal(existsSync(join(d.repo, "content", "playtests", "smoke.json")), false);
    assert.equal(readdirSync(join(d.data, "playtests", "replays")).length, 0);
    assert.equal((await call(d, "DELETE", "/api/editor/playtests/smoke"))?.status, 404);
    rmSync(d.repo, { recursive: true, force: true });
  });
});
