/** LS1: the world reveals after the first snapshot and a settled model queue, or at the timeout. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoadGate } from "../src/render/load-gate.js";

const opts = { settleMs: 1000, timeoutMs: 10_000 };

describe("LoadGate", () => {
  it("waits for the first snapshot, then for models to settle", () => {
    const g = new LoadGate(opts);
    assert.deepEqual(g.sample({ now: 0, stateSeen: false, ready: 0, pending: 0 }), { done: false, stage: "state", ready: 0, pending: 0 });
    let p = g.sample({ now: 100, stateSeen: true, ready: 0, pending: 3 });
    assert.equal(p.done, false);
    assert.equal(p.stage, "models");
    assert.equal(p.pending, 3);
    p = g.sample({ now: 200, stateSeen: true, ready: 3, pending: 0 });
    assert.equal(p.done, false, "a settle window has to pass with nothing pending");
    p = g.sample({ now: 1199, stateSeen: true, ready: 3, pending: 0 });
    assert.equal(p.done, false);
    p = g.sample({ now: 1200, stateSeen: true, ready: 3, pending: 0 });
    assert.equal(p.done, true);
    assert.equal(g.done, true);
  });

  it("restarts the settle window when a new model is requested", () => {
    const g = new LoadGate(opts);
    g.sample({ now: 0, stateSeen: true, ready: 1, pending: 0 });
    g.sample({ now: 900, stateSeen: true, ready: 1, pending: 2 });
    assert.equal(g.sample({ now: 1500, stateSeen: true, ready: 1, pending: 0 }).done, false);
    assert.equal(g.sample({ now: 2499, stateSeen: true, ready: 3, pending: 0 }).done, false);
    assert.equal(g.sample({ now: 2500, stateSeen: true, ready: 3, pending: 0 }).done, true);
  });

  it("reveals at the timeout even when models never arrive", () => {
    const g = new LoadGate(opts);
    assert.equal(g.sample({ now: 5, stateSeen: true, ready: 0, pending: 9 }).done, false);
    assert.equal(g.sample({ now: 10_005, stateSeen: true, ready: 0, pending: 9 }).done, true);
  });

  it("reveals at the timeout even before a snapshot arrives", () => {
    const g = new LoadGate(opts);
    g.sample({ now: 0, stateSeen: false, ready: 0, pending: 0 });
    assert.equal(g.sample({ now: 10_000, stateSeen: false, ready: 0, pending: 0 }).done, true);
  });

  it("stays done once done", () => {
    const g = new LoadGate(opts);
    g.sample({ now: 0, stateSeen: true, ready: 0, pending: 0 });
    g.sample({ now: 1000, stateSeen: true, ready: 0, pending: 0 });
    assert.equal(g.sample({ now: 1001, stateSeen: true, ready: 0, pending: 5 }).done, true);
  });
});
