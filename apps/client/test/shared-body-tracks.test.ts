/** Shared bodies from snapshots: only wanted entities are buffered, drawn behind the clock, forgotten on despawn. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TransformRow } from "@mmo-engine/protocol";
import { Interpolator } from "@mmo-engine/mirror";
import { PlayoutClock, SharedBodyTracks } from "../src/render/shared-body-tracks.js";

const A = 0x2001n;
const B = 0x2002n;
const row = (wireId: bigint, px: number): TransformRow => ({
  wireId, px, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 2, sy: 3, sz: 4,
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe("SharedBodyTracks", () => {
  it("draws nothing until an entity is wanted and a tick arrives", () => {
    const s = new SharedBodyTracks({ delaySeconds: 0.1 });
    s.setTickHz(10);
    s.feed(1, [row(A, 1)]);
    assert.equal(s.sample(A, 1), undefined);
    s.want(A);
    s.feed(2, [row(A, 2)]);
    near(s.sample(A, 0.3)!.px, 2); // one snapshot: held
  });

  it("lerps between ticks, drawn delaySeconds behind the clock, keeping the scale", () => {
    const s = new SharedBodyTracks({ delaySeconds: 0.1 });
    s.setTickHz(10); // 0.1 s per tick
    s.want(A);
    s.feed(0, [row(A, 0)]);
    s.feed(1, [row(A, 1)]);
    near(s.sample(A, 0.15)!.px, 0.5); // target 0.05 s: halfway between tick 0 and tick 1
    const p = s.sample(A, 0.2)!; // target 0.1 s: tick 1
    near(p.px, 1);
    near(p.sx, 2);
    near(p.sy, 3);
  });

  it("forget drops the entity and stops buffering it", () => {
    const s = new SharedBodyTracks({ delaySeconds: 0 });
    s.setTickHz(10);
    s.want(A);
    s.feed(1, [row(A, 1)]);
    s.forget(A);
    assert.equal(s.sample(A, 1), undefined);
    s.feed(2, [row(A, 2)]);
    assert.equal(s.sample(A, 1), undefined);
  });

  it("a rate change rebuilds the buffers, so old snapshots are not mixed with new timing", () => {
    const s = new SharedBodyTracks({ delaySeconds: 0 });
    s.setTickHz(10);
    s.want(A);
    s.feed(1, [row(A, 1)]);
    s.setTickHz(30);
    assert.equal(s.sample(A, 1), undefined);
  });

  it("attaches to a mirror Interpolator and buffers its pushes", () => {
    const interp = new Interpolator();
    const s = new SharedBodyTracks({ delaySeconds: 0 });
    s.setTickHz(10);
    s.want(B);
    const off = s.attach(interp);
    interp.push(3, [row(B, 3), row(A, 9)]); // A is not wanted
    near(s.sample(B, 0.3)!.px, 3);
    assert.equal(s.sample(A, 0.3), undefined);
    off();
    interp.push(4, [row(B, 4)]);
    near(s.sample(B, 0.4)!.px, 3); // unsubscribed: tick 4 never arrived
  });
});

describe("PlayoutClock", () => {
  it("has no clock before the first arrival, and maps local time to server time after it", () => {
    const c = new PlayoutClock();
    c.setTickHz(10);
    assert.equal(c.serverSeconds(5), undefined);
    c.observe(10, 6.05); // tick 10 is at 1.0 s of server time; it arrived 50 ms late
    near(c.serverSeconds(6.05)!, 1.0);
  });

  it("moves the offset by the smoothing weight, so one late packet cannot stop or snap the clock", () => {
    const c = new PlayoutClock(0.05);
    c.setTickHz(10);
    c.observe(0, 0.05); // offset 0.05
    c.observe(1, 0.1 + 0.15); // this one is 0.1 s late: offset target 0.15
    near(c.serverSeconds(1)!, 1 - 0.055); // 0.05 + 0.05 * (0.15 - 0.05) = 0.055
  });

  it("resets when the tick rate changes", () => {
    const c = new PlayoutClock();
    c.setTickHz(10);
    c.observe(0, 0.05);
    c.setTickHz(30);
    assert.equal(c.serverSeconds(1), undefined);
  });
});

describe("SharedBodyTracks.sampleAt", () => {
  it("draws the body at the playout clock's server time, behind by the delay", () => {
    const s = new SharedBodyTracks({ delaySeconds: 0.1 });
    s.setTickHz(10);
    s.want(A);
    let t = 0;
    let fake: (tick: number, rows: readonly TransformRow[]) => void = () => {};
    const interp = { onPush: (l: (tick: number, rows: readonly TransformRow[]) => void) => { fake = l; return () => {}; } };
    s.attach(interp, () => t);
    t = 0.05; fake(0, [row(A, 0)]); // tick 0 at server 0, arrived at 0.05 s: offset 0.05
    t = 0.15; fake(1, [row(A, 1)]); // tick 1 at server 0.1 s, arrived at 0.15 s: offset 0.05
    // local 0.2 s -> server 0.15 s -> drawn at 0.05 s, halfway between tick 0 and tick 1
    near(s.sampleAt(A, 0.2)!.px, 0.5);
  });

  it("is undefined before any tick has arrived", () => {
    const s = new SharedBodyTracks({ delaySeconds: 0 });
    s.setTickHz(10);
    s.want(A);
    assert.equal(s.sampleAt(A, 1), undefined);
  });
});
