import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TelemetryPoller, type TelemetryPollTimers } from "../src/liveops-telemetry.js";
import type { TelemetrySnapshot } from "../src/backend-models.js";

const snapshot: TelemetrySnapshot = {
  bucketSeconds: 10,
  buckets: 3,
  series: { kills: [0, 1, 2] },
  totals: { kills: 3 },
  tick: { count: 10, p50Ms: 1, p99Ms: 2, maxMs: 3 },
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TelemetryPoller", () => {
  it("fetches immediately, then schedules on the server bucket cadence", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const timerApi: TelemetryPollTimers = {
      now: () => 123,
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    };
    let calls = 0;
    const poller = new TelemetryPoller({ statsSnapshot: async () => { calls += 1; return snapshot; } }, timerApi);

    poller.start();
    await settle();
    assert.equal(calls, 1);
    assert.equal(poller.get().snapshot, snapshot);
    assert.equal(poller.get().updatedAt, 123);
    assert.deepEqual(timers.map((timer) => timer.ms), [10_000]);

    timers[0].fn();
    await settle();
    assert.equal(calls, 2);
  });

  it("does not overlap stats admin requests", async () => {
    const request = deferred<TelemetrySnapshot>();
    let calls = 0;
    const poller = new TelemetryPoller({
      statsSnapshot: () => {
        calls += 1;
        return request.promise;
      },
    });

    poller.start();
    poller.refresh();
    assert.equal(calls, 1);

    request.resolve(snapshot);
    await settle();
    poller.stop();
  });
});
