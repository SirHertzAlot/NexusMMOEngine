/** Playtest host: confined scenario files, validated saves, runs recorded with history and replays (fake scratch runner). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePlaytestRoute } from "../src/playtest-host.js";
import { BLANK_SCENARIO, MAX_HISTORY, type PlaytestReplay, type PlaytestRun } from "../src/playtest-model.js";
import type { ScratchRunner } from "../src/playtest-server.js";

interface Dirs { repo: string; data: string }

function dirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), "mmo-playtest-host-"));
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "data"));
  return { repo: join(root, "repo"), data: join(root, "data") };
}

const fake = (opts: { ok?: boolean; shift?: number; throws?: string } = {}): ScratchRunner => (spec) => {
  if (opts.throws) return Promise.reject(new Error(opts.throws));
  const trace = Array.from({ length: 5 }, (_, i) => ({ tick: i, x: i + (i >= 3 ? (opts.shift ?? 0) : 0), z: 0 }));
  return Promise.resolve({
    wallMs: 12,
    metrics: { ticks: spec.durationTicks, connected: true, errors: [], adminReplies: [], trace, tickP99Ms: 4 },
    results: spec.assertions.map((a) => ({ assertion: a, label: a.kind, ok: opts.ok ?? true, actual: "x" })),
  });
};

const call = (d: Dirs, method: string, path: string, body?: unknown, runner = fake()) =>
  handlePlaytestRoute(d.repo, d.data, method, path, body === undefined ? undefined : JSON.stringify(body), runner);
const save = (d: Dirs, name = "smoke") => call(d, "PUT", `/api/editor/playtests/${name}`, { content: BLANK_SCENARIO(name) });
const runBody = (r: Awaited<ReturnType<typeof call>>): PlaytestRun => (r?.body as { run: PlaytestRun }).run;

describe("playtest routes", () => {
  it("ignores other paths", async () => {
    assert.equal(await call({ repo: "x", data: "y" }, "GET", "/api/editor/flow"), null);
  });
  it("saves a valid scenario, lists it with an empty history", async () => {
    const d = dirs();
    assert.equal((await save(d))?.status, 200);
    assert.ok(existsSync(join(d.repo, "content", "playtests", "smoke.playtest.json")));
    const list = (await call(d, "GET", "/api/editor/playtests"))?.body as { scenarios: Array<{ name: string; history: unknown[] }> };
    assert.deepEqual(list.scenarios.map((s) => [s.name, s.history.length]), [["smoke", 0]]);
  });
  it("a refused save answers 400 with issues and writes nothing", async () => {
    const d = dirs();
    const r = await call(d, "PUT", "/api/editor/playtests/smoke", { content: { ...BLANK_SCENARIO("smoke"), seed: -5 } });
    assert.equal(r?.status, 400);
    assert.ok((r?.body as { issues: unknown[] }).issues.length > 0);
    assert.equal(existsSync(join(d.repo, "content", "playtests")), false);
  });
  it("refuses names that could leave the folder and a name that disagrees with the file", async () => {
    const d = dirs();
    assert.equal((await call(d, "PUT", "/api/editor/playtests/..%2Fx", { content: BLANK_SCENARIO("x") }))?.status, 400);
    assert.equal((await call(d, "PUT", "/api/editor/playtests/Bad_Name", { content: BLANK_SCENARIO("x") }))?.status, 400);
    assert.equal((await call(d, "PUT", "/api/editor/playtests/smoke", { content: BLANK_SCENARIO("other") }))?.status, 400);
    assert.equal((await call(d, "GET", "/api/editor/playtest-replays/..%2F..%2Fx"))?.status, 400);
    assert.equal(existsSync(join(d.repo, "content")), false);
  });
  it("a run records history and a replay that holds the inputs and seed", async () => {
    const d = dirs();
    await save(d);
    const run = runBody(await call(d, "POST", "/api/editor/playtests/smoke/run"));
    assert.equal(run.ok, true);
    assert.equal(run.mode, "run");
    const replay = ((await call(d, "GET", `/api/editor/playtest-replays/${run.replay}`))?.body as { replay: PlaytestReplay }).replay;
    assert.equal(replay.seed, 1234);
    assert.ok(replay.inputs.length >= 3);
    const hist = ((await call(d, "GET", "/api/editor/playtests"))?.body as { scenarios: Array<{ history: PlaytestRun[] }> }).scenarios[0].history;
    assert.equal(hist.length, 1);
  });
  it("a failing run is kept as failed; replaying it reports where the trace diverged", async () => {
    const d = dirs();
    await save(d);
    const first = runBody(await call(d, "POST", "/api/editor/playtests/smoke/run", undefined, fake({ ok: false })));
    assert.equal(first.ok, false);
    const again = runBody(await call(d, "POST", `/api/editor/playtest-replays/${first.replay}/run`, undefined, fake({ shift: 10 })));
    assert.equal(again.mode, "replay");
    assert.equal(again.divergedAtTick, 3);
    const same = runBody(await call(d, "POST", `/api/editor/playtest-replays/${first.replay}/run`));
    assert.equal(same.divergedAtTick, null);
  });
  it("a scratch server that cannot start is a failed run, not a crash", async () => {
    const d = dirs();
    await save(d);
    const run = runBody(await call(d, "POST", "/api/editor/playtests/smoke/run", undefined, fake({ throws: "not built" })));
    assert.equal(run.ok, false);
    assert.equal(run.error, "not built");
  });
  it("answers 409 while another run is going", async () => {
    const d = dirs();
    await save(d);
    let release: () => void = () => {};
    const slow: ScratchRunner = (spec) => new Promise((res) => void (release = () => void fake()(spec).then(res)));
    const first = call(d, "POST", "/api/editor/playtests/smoke/run", undefined, slow);
    await new Promise((r) => setTimeout(r, 10));
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
    assert.equal(existsSync(join(d.repo, "content", "playtests", "smoke.playtest.json")), false);
    assert.equal(readdirSync(join(d.data, "playtests", "replays")).length, 0);
    assert.equal((await call(d, "DELETE", "/api/editor/playtests/smoke"))?.status, 404);
    rmSync(d.repo, { recursive: true, force: true });
  });
});
