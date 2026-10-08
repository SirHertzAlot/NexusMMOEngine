/**
 * server-control: the browser adapter POSTs the honored start options
 * (bots) to the dev host and tracks the owned server.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHostServerControl } from "../src/server-control.js";

interface Seen {
  url: string;
  init: { method?: string; body?: string };
}

let seen: Seen[] = [];
let nextBody: unknown = null;
let nextStatus = 200;
const realFetch = globalThis.fetch;

function fakeFetch(url: unknown, init: unknown): Promise<unknown> {
  seen.push({ url: String(url), init: (init ?? {}) as Seen["init"] });
  return Promise.resolve({
    ok: nextStatus >= 200 && nextStatus < 300,
    status: nextStatus,
    json: () => Promise.resolve(nextBody),
  });
}

beforeEach(() => {
  seen = [];
  nextBody = null;
  nextStatus = 200;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createHostServerControl", () => {
  it("start posts the bots option and tracks the owned server", async () => {
    nextBody = { ok: true, pid: 7, port: 7777, url: "ws://127.0.0.1:7777", username: "u", password: "p" };
    const c = createHostServerControl();
    const s = await c.start({ bots: 50 });
    assert.equal(s.pid, 7);
    assert.equal(c.isRunning(), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/editor/server/start");
    assert.equal(seen[0].init.method, "POST");
    assert.deepEqual(JSON.parse(seen[0].init.body ?? ""), { bots: 50 });
  });

  it("start without options posts an empty body", async () => {
    nextBody = { ok: true, pid: 7, port: 7777, url: "ws://127.0.0.1:7777", username: "u", password: "p" };
    const c = createHostServerControl();
    await c.start();
    assert.deepEqual(JSON.parse(seen[0].init.body ?? ""), {});
  });

  it("start throws when the host refuses", async () => {
    nextStatus = 409;
    nextBody = { ok: false, error: "a play-mode server is already running" };
    const c = createHostServerControl();
    await assert.rejects(c.start({ bots: 10 }), /already running/);
    assert.equal(c.isRunning(), false);
  });

  it("stop posts and clears the owned flag", async () => {
    nextBody = { ok: true, pid: 7, port: 7777, url: "ws://127.0.0.1:7777", username: "u", password: "p" };
    const c = createHostServerControl();
    await c.start({ bots: 0 });
    nextBody = { ok: true, stopped: true };
    await c.stop();
    assert.equal(c.isRunning(), false);
    assert.equal(seen[1].url, "/api/editor/server/stop");
  });
});
