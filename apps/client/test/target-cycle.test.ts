/** Tab targeting (roadmap M5): which nearby body Tab selects next. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TARGET_CYCLE_RANGE_M, nextTarget, type TargetCandidate } from "../src/render/target-cycle.js";

const c = (wid: bigint, x: number, z: number): TargetCandidate => ({ wid, x, z });
const me = { x: 0, z: 0 };

describe("Tab targeting", () => {
  it("with no target, Tab picks the nearest body in reach", () => {
    const list = [c(1n, 10, 0), c(2n, 3, 4), c(3n, 0, -20)];
    assert.equal(nextTarget(list, me, null), 2n);
  });

  it("each Tab moves to the next nearest and wraps to the nearest again", () => {
    const list = [c(1n, 10, 0), c(2n, 3, 4), c(3n, 0, -20)];
    assert.equal(nextTarget(list, me, 2n), 1n);
    assert.equal(nextTarget(list, me, 1n), 3n);
    assert.equal(nextTarget(list, me, 3n), 2n);
  });

  it("bodies beyond the range are skipped", () => {
    const far = TARGET_CYCLE_RANGE_M + 1;
    const list = [c(1n, far, 0), c(2n, 0, 5)];
    assert.equal(nextTarget(list, me, null), 2n);
    assert.equal(nextTarget([c(1n, far, 0)], me, null), null);
  });

  it("a current target out of range restarts from the nearest in reach", () => {
    const list = [c(1n, 50, 0), c(2n, 4, 0)];
    assert.equal(nextTarget(list, me, 1n), 2n);
  });

  it("no player position or no candidates gives nothing", () => {
    assert.equal(nextTarget([c(1n, 1, 1)], null, null), null);
    assert.equal(nextTarget([], me, null), null);
  });

  it("ties break by wire id, so the order is stable", () => {
    const list = [c(9n, 2, 0), c(4n, 0, 2)];
    assert.equal(nextTarget(list, me, null), 4n);
    assert.equal(nextTarget(list, me, 4n), 9n);
  });
});
