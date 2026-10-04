import { test } from "node:test";
import assert from "node:assert/strict";
import { LIFECYCLE_EVENTS, netLogger } from "../src/log.js";

test("every lifecycle event logs one JSON line with the required fields and no secrets", () => {
  const lines: string[] = [];
  const log = netLogger("edge", (l) => lines.push(l), () => new Date("2026-10-03T12:00:00Z"));
  for (const e of LIFECYCLE_EVENTS) {
    log.log("info", e, { code: 1000, attempt: 2, bytes: 9, token: "s3cret", payload: "{...}", password: "pw", username: "alice", sessionToken: "x" });
  }
  assert.equal(lines.length, LIFECYCLE_EVENTS.length);
  lines.forEach((line, i) => {
    assert.ok(!line.includes("\n"));
    const o = JSON.parse(line) as Record<string, unknown>;
    assert.equal(o.ts, "2026-10-03T12:00:00.000Z");
    assert.equal(o.level, "info");
    assert.equal(o.component, "edge");
    assert.equal(o.event, LIFECYCLE_EVENTS[i]);
    for (const k of Object.keys(o)) assert.ok(!/token|payload|password|username/i.test(k), `leaked ${k}`);
    assert.ok(!line.includes("s3cret") && !line.includes("alice"));
  });
});
