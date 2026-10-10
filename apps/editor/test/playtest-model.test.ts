/** Playtest scenarios: validation, expansion to inputs, assertions, history, and the executor over a fake bot. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  BLANK_SCENARIO,
  evaluateAssertions,
  expandScript,
  firstDivergence,
  passRate,
  pushHistory,
  validatePlaytest,
  MAX_HISTORY,
  type PlaytestRun,
  type ReplayInput,
} from "../src/playtest-model.js";
import { execInputs, tickP99FromStats, type BotSession } from "../src/playtest-exec.js";

const ok = (): ReturnType<typeof BLANK_SCENARIO> => BLANK_SCENARIO("smoke");

describe("validatePlaytest", () => {
  it("accepts the blank scenario", () => {
    assert.deepEqual(validatePlaytest(ok(), "smoke"), []);
  });
  it("names every problem, not only the first", () => {
    const bad = { ...ok(), seed: -1, bots: 9999, durationTicks: 0, assertions: [] };
    const paths = validatePlaytest(bad).map((i) => i.path);
    assert.ok(paths.includes("seed") && paths.includes("bots") && paths.includes("durationTicks") && paths.includes("assertions"));
  });
  it("refuses a name that is not the file's, unknown fields, unknown step kinds and steps past the end", () => {
    const doc = { ...ok(), name: "other", extra: 1, script: [{ at: 0, do: "dance" }, { at: 99999, do: "stop" }, { at: 500, do: "stop" }] };
    const msgs = validatePlaytest(doc, "smoke").map((i) => `${i.path}: ${i.message}`);
    assert.ok(msgs.some((m) => m.startsWith("name:")));
    assert.ok(msgs.some((m) => m.startsWith(".extra")));
    assert.ok(msgs.some((m) => m.startsWith("script[0].do")));
    assert.ok(msgs.some((m) => m.startsWith("script[1].at")));
    assert.ok(msgs.some((m) => m.startsWith("script[2].at") && m.includes("never run")));
  });
  it("an admin-reply-contains assertion must point at an admin step", () => {
    const doc = { ...ok(), assertions: [{ kind: "admin-reply-contains", step: 1, text: "x" }] };
    assert.equal(validatePlaytest(doc).length, 1);
    assert.deepEqual(validatePlaytest({ ...doc, assertions: [{ kind: "admin-reply-contains", step: 0, text: "admin" }] }), []);
  });
  it("rejects a non-object", () => {
    assert.equal(validatePlaytest([]).length, 1);
    assert.equal(validatePlaytest(null).length, 1);
  });
});

describe("shipped scenarios", () => {
  it("every file in content/playtests is valid and named after its file", () => {
    const dir = new URL("../../../../content/playtests/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".playtest.json"));
    assert.ok(files.length >= 2);
    for (const f of files) {
      const doc = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as unknown;
      assert.deepEqual(validatePlaytest(doc, f.replace(".playtest.json", "")), [], f);
    }
  });
});

describe("expandScript", () => {
  it("turns a move into a start and a stop input and sorts by tick", () => {
    const inputs = expandScript([
      { at: 10, do: "move", mx: 0, mz: 1, ticks: 5 },
      { at: 2, do: "admin", command: "heal" },
      { at: 3, do: "chat", text: "hi" },
    ]);
    assert.deepEqual(inputs.map((i) => [i.tick, i.kind, i.step]), [[2, "admin", 1], [3, "chat", 2], [10, "intent", 0], [15, "intent", 0]]);
    const last = inputs[3] as Extract<ReplayInput, { kind: "intent" }>;
    assert.equal(last.intent.mz, 0);
  });
});

const metrics = (over: Partial<Parameters<typeof evaluateAssertions>[1]> = {}): Parameters<typeof evaluateAssertions>[1] => ({
  ticks: 100,
  connected: true,
  errors: [],
  adminReplies: [],
  trace: [{ tick: 0, x: 0, z: 0 }, { tick: 50, x: 3, z: 4 }],
  tickP99Ms: 8,
  ...over,
});

describe("evaluateAssertions", () => {
  it("passes and fails each kind with a readable actual", () => {
    const r = evaluateAssertions(
      [
        { kind: "connected" },
        { kind: "no-errors" },
        { kind: "tick-p99-ms", max: 5 },
        { kind: "moved", min: 5 },
        { kind: "stays-within", max: 4 },
      ],
      metrics(),
    );
    assert.deepEqual(r.map((x) => x.ok), [true, true, false, true, false]);
    assert.equal(r[2].actual, "8 ms");
    assert.equal(r[3].actual, "5");
  });
  it("admin assertions follow expectOk and the reply text", () => {
    const m = metrics({ adminReplies: [{ step: 0, ok: true, expectOk: true, message: "admin bot" }, { step: 1, ok: false, expectOk: false, message: "usage" }] });
    const r = evaluateAssertions([{ kind: "admin-ok" }, { kind: "admin-reply-contains", step: 0, text: "bot" }, { kind: "admin-reply-contains", step: 5, text: "x" }], m);
    assert.deepEqual(r.map((x) => x.ok), [true, true, false]);
    assert.equal(r[2].actual, "step never ran");
  });
  it("a missing tick figure fails the tick assertion instead of passing it", () => {
    assert.equal(evaluateAssertions([{ kind: "tick-p99-ms", max: 50 }], metrics({ tickP99Ms: null }))[0].ok, false);
  });
});

describe("history and replays", () => {
  const run = (id: string, okay: boolean): PlaytestRun => ({ id, scenario: "s", at: "t", mode: "run", ok: okay, ticks: 1, wallMs: 1, results: [], tickP99Ms: null });
  it("keeps the newest first and caps the list", () => {
    let h: PlaytestRun[] = [];
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = pushHistory(h, run(String(i), true));
    assert.equal(h.length, MAX_HISTORY);
    assert.equal(h[0].id, String(MAX_HISTORY + 4));
  });
  it("pass rate counts the newest runs", () => {
    assert.equal(passRate([]), null);
    assert.equal(passRate([run("a", true), run("b", false), run("c", true), run("d", true)]), 75);
  });
  it("finds the first tick two traces part", () => {
    const a = [{ tick: 0, x: 0, z: 0 }, { tick: 1, x: 1, z: 0 }, { tick: 2, x: 2, z: 0 }];
    assert.equal(firstDivergence(a, a), null);
    assert.equal(firstDivergence(a, [a[0], a[1], { tick: 2, x: 9, z: 0 }]), 2);
  });
});

function fakeBot(): BotSession & { tick(t: number): void; sent: string[]; close(): void; failAdmin: boolean } {
  let onTick: (t: number) => void = () => {};
  let onClose: () => void = () => {};
  let x = 0;
  const sent: string[] = [];
  const bot = {
    sent,
    failAdmin: false,
    onTick: (cb: (t: number) => void) => void (onTick = cb),
    onError: () => {},
    onClose: (cb: () => void) => void (onClose = cb),
    sendIntent: (i: { mz: number }) => void (sent.push(`intent ${i.mz}`), (x += i.mz)),
    chat: (_c: string, text: string) => void sent.push(`chat ${text}`),
    admin: (cmd: string) => {
      sent.push(`admin ${cmd}`);
      if (cmd === "stats") return Promise.resolve({ ok: true, message: JSON.stringify({ tick: { p99Ms: 3 } }) });
      return bot.failAdmin ? Promise.reject(new Error("admin only")) : Promise.resolve({ ok: true, message: `ran ${cmd}` });
    },
    position: () => ({ x, z: 0 }),
    tick: (t: number) => onTick(t),
    close: () => onClose(),
  };
  return bot;
}

describe("execInputs", () => {
  it("sends each input once, at its tick counted from the first tick seen, and evaluates", async () => {
    const bot = fakeBot();
    const inputs = expandScript([{ at: 0, do: "admin", command: "whoami" }, { at: 2, do: "move", mx: 0, mz: 1, ticks: 2 }, { at: 3, do: "chat", text: "yo" }]);
    const p = execInputs(bot, { durationTicks: 5, inputs, assertions: [{ kind: "admin-ok" }, { kind: "moved", min: 1 }, { kind: "tick-p99-ms", max: 10 }], timeoutMs: 1000 });
    for (let t = 100; t <= 106; t++) bot.tick(t);
    const r = await p;
    assert.equal(r.error, undefined);
    assert.deepEqual(bot.sent, ["intent 1", "chat yo", "intent 0", "admin whoami", "admin stats"]);
    assert.deepEqual(r.results.map((x) => x.ok), [true, true, true]);
    assert.equal(r.metrics.ticks, 5);
    assert.equal(r.metrics.trace[0].tick, 0);
  });
  it("a refused admin command counts as expected when expectOk is false", async () => {
    const bot = fakeBot();
    bot.failAdmin = true;
    const inputs = expandScript([{ at: 0, do: "admin", command: "god", expectOk: false }]);
    const p = execInputs(bot, { durationTicks: 1, inputs, assertions: [{ kind: "admin-ok" }], timeoutMs: 1000 });
    bot.tick(1);
    bot.tick(2);
    assert.equal((await p).results[0].ok, true);
  });
  it("a dropped connection ends the run with an error and a failing connected assertion", async () => {
    const bot = fakeBot();
    const p = execInputs(bot, { durationTicks: 50, inputs: [], assertions: [{ kind: "connected" }], timeoutMs: 1000 });
    bot.tick(1);
    bot.close();
    const r = await p;
    assert.match(r.error ?? "", /dropped/);
    assert.equal(r.results[0].ok, false);
  });
  it("a stalled server times out", async () => {
    const bot = fakeBot();
    const r = await execInputs(bot, { durationTicks: 50, inputs: [], assertions: [{ kind: "connected" }], timeoutMs: 20 });
    assert.match(r.error ?? "", /timed out/);
  });
  it("reads the tick p99 from the stats JSON", () => {
    assert.equal(tickP99FromStats('{"tick":{"p99Ms":2.5}}'), 2.5);
    assert.equal(tickP99FromStats("nope"), null);
  });
});
