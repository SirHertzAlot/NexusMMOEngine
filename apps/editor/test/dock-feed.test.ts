import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ServerLog } from "../src/host.js";
import { appendLines, getBakes, lineTone, pushBake, subscribeBakes } from "../src/dock-feed.js";

describe("ServerLog", () => {
  it("numbers lines and returns only what is after the cursor", () => {
    const log = new ServerLog();
    log.append("one\ntwo\n");
    assert.deepEqual(log.since(0), { lines: ["one", "two"], from: 0, next: 2 });
    log.append("three\n");
    assert.deepEqual(log.since(2), { lines: ["three"], from: 2, next: 3 });
    assert.deepEqual(log.since(3), { lines: [], from: 3, next: 3 });
  });
  it("holds a partial line until its newline arrives", () => {
    const log = new ServerLog();
    log.append("lis");
    assert.deepEqual(log.since(0).lines, []);
    log.append("tening\r\n");
    assert.deepEqual(log.since(0).lines, ["listening"]);
  });
  it("drops the oldest lines past its cap and says where the kept ones start", () => {
    const log = new ServerLog(3);
    log.append("a\nb\nc\nd\ne\n");
    assert.deepEqual(log.since(0), { lines: ["c", "d", "e"], from: 2, next: 5 });
  });
  it("keeps numbering across a restart", () => {
    const log = new ServerLog();
    log.append("a\nb\n");
    log.reset();
    log.append("c\n");
    assert.deepEqual(log.since(0), { lines: ["c"], from: 2, next: 3 });
  });
  it("keeps stdout and stderr partial lines apart", () => {
    const log = new ServerLog();
    log.append("tick 4", "stdout");
    log.append("Error: boom\n", "stderr");
    log.append("2 ms\n", "stdout");
    assert.deepEqual(log.since(0).lines, ["Error: boom", "tick 42 ms"]);
  });
  it("flush keeps an unfinished last line instead of gluing the next one to it", () => {
    const log = new ServerLog();
    log.append("fatal: no newline", "stderr");
    log.flush();
    log.append("[editor] the play server exited (code 1)\n", "editor");
    assert.deepEqual(log.since(0).lines, ["fatal: no newline", "[editor] the play server exited (code 1)"]);
  });
  it("a reset makes the previous run's epoch stale", () => {
    const log = new ServerLog();
    const first = log.reset();
    assert.equal(log.current(first), true);
    const second = log.reset();
    assert.equal(log.current(first), false);
    assert.equal(log.current(second), true);
  });
  it("caps a line that never ends", () => {
    const log = new ServerLog();
    log.append("x".repeat(5000));
    log.flush();
    assert.equal(log.since(0).lines[0].length, 2000);
  });
});

describe("dock feed helpers", () => {
  it("keeps the newest lines", () => {
    assert.deepEqual(appendLines(["a", "b"], ["c", "d"], 3), ["b", "c", "d"]);
  });
  it("tones errors and warnings by their words", () => {
    assert.equal(lineTone("Error: boom"), "error");
    assert.equal(lineTone("uncaught exception in tick"), "error");
    assert.equal(lineTone("WARN slow tick"), "warn");
    assert.equal(lineTone("listening on 7777"), "info");
  });
  it("records bakes and tells subscribers", () => {
    let calls = 0;
    const off = subscribeBakes(() => calls++);
    const before = getBakes().length;
    pushBake("terrain", "region 0,0 regenerated");
    off();
    assert.equal(calls, 1);
    assert.equal(getBakes().length, before + 1);
    assert.equal(getBakes().at(-1)?.source, "terrain");
    assert.equal(getBakes().at(-1)?.ok, true);
  });
});
