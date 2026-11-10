import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlayTelemetry, telemetryFromAdmin } from "../src/telemetry.js";

const snapshot = {
  bucketSeconds: 10,
  buckets: 2,
  series: {
    kills: [0, 2],
    deaths: [1, 0],
    pickups: [3, 4],
    drops: [0, 1],
    damageDealt: [2.5, 8],
    damageTaken: [1, 0],
  },
  totals: {
    kills: 2,
    deaths: 1,
    pickups: 7,
    drops: 1,
    damageDealt: 10.5,
    damageTaken: 1,
  },
  tick: { count: 30, p50Ms: 1.5, p99Ms: 3, maxMs: 5 },
};

test("parses the gateway's complete telemetry snapshot", () => {
  assert.deepEqual(parsePlayTelemetry(JSON.stringify(snapshot)), snapshot);
  assert.deepEqual(telemetryFromAdmin({ kind: "admin", command: "stats", ok: true, message: JSON.stringify(snapshot) }), snapshot);
});

test("rejects malformed or partial telemetry responses", () => {
  assert.throws(() => parsePlayTelemetry("not-json"), /not JSON/);
  assert.throws(() => parsePlayTelemetry(JSON.stringify({ ...snapshot, buckets: 3 })), /invalid kills data/);
  assert.throws(() => telemetryFromAdmin({ kind: "admin", command: "stats", ok: false, message: "admin only" }), /admin only/);
});
