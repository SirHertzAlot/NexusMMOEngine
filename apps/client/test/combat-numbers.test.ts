/**
 * CombatNumbers (CF2): classify, arbitrate, accumulate, budgets, animate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HitMessage } from "@mmo-engine/protocol";
import { CombatNumbers, DEFAULT_NUMBERS, laneOffset, magnitudeScale } from "../src/render/combat-numbers.js";

const PLAYER = 1n;

function hit(source: bigint, target: bigint, amount: number, outcome: HitMessage["outcome"] = "hit", max = 100): HitMessage {
  return { kind: "hit", tick: 1, source: String(source), target: String(target), outcome, amount, health: 50, max };
}
const live = (n: CombatNumbers) => n.pool.filter((f) => f.live);

describe("classify", () => {
  it("types by outcome and size, and grows with damage up to a cap", () => {
    const n = new CombatNumbers();
    n.hit(hit(PLAYER, 2n, 5), PLAYER, 0);
    n.hit(hit(PLAYER, 3n, 40), PLAYER, 0);
    n.hit(hit(PLAYER, 4n, 0, "dodged"), PLAYER, 0);
    n.hit(hit(PLAYER, 5n, 3, "blocked"), PLAYER, 0);
    n.hit(hit(PLAYER, 6n, 0), PLAYER, 0);
    const by = (t: bigint) => live(n).find((f) => f.target === t)!;
    assert.equal(by(2n).kind, "damage");
    assert.equal(by(3n).kind, "heavy");
    assert.equal(by(4n).text, "Miss");
    assert.equal(by(5n).kind, "block");
    assert.equal(live(n).some((f) => f.target === 6n), false, "zero damage shows nothing");
    const m = DEFAULT_NUMBERS.magnitude;
    assert.ok(magnitudeScale(1, m) < magnitudeScale(50, m));
    assert.equal(magnitudeScale(1e9, m), m.maxScale);
  });
});

describe("arbitration", () => {
  it("fast hits on one target merge into one floater and sum", () => {
    const n = new CombatNumbers();
    n.hit(hit(PLAYER, 2n, 5), PLAYER, 0);
    n.hit(hit(PLAYER, 2n, 7), PLAYER, 100);
    assert.equal(live(n).length, 1);
    assert.equal(live(n)[0]!.text, "12");
  });

  it("hits past the window take the next lane, alternating sides", () => {
    const n = new CombatNumbers();
    n.hit(hit(PLAYER, 2n, 5), PLAYER, 0);
    n.hit(hit(PLAYER, 2n, 5), PLAYER, 1000);
    n.hit(hit(PLAYER, 2n, 5), PLAYER, 2000);
    assert.deepEqual(live(n).map((f) => f.lane), [0, 1, 2]);
    assert.equal(laneOffset(0, 26), 0);
    assert.equal(laneOffset(1, 26), -26);
    assert.equal(laneOffset(2, 26), 26);
  });

  it("past maxPerTarget the damage folds into the newest floater instead of vanishing", () => {
    const n = new CombatNumbers();
    const per = DEFAULT_NUMBERS.budgets.maxPerTarget;
    for (let i = 0; i < per + 3; i++) n.hit(hit(PLAYER, 2n, 1), PLAYER, i * 1000);
    assert.equal(live(n).length, per);
    assert.equal(live(n).reduce((a, f) => a + f.value, 0), per + 3);
  });

  it("a full pool drops others' numbers but the player's own evicts the oldest", () => {
    const n = new CombatNumbers();
    const cap = DEFAULT_NUMBERS.budgets.maxGlobal;
    for (let i = 0; i < cap; i++) n.hit(hit(9n, BigInt(100 + i), 5), PLAYER, 0);
    assert.equal(n.count, cap);
    n.hit(hit(9n, 999n, 5), PLAYER, 0);
    assert.equal(n.count, cap);
    assert.equal(live(n).some((f) => f.target === 999n), false);
    n.hit(hit(PLAYER, 999n, 5), PLAYER, 0);
    assert.equal(n.count, cap);
    assert.ok(live(n).some((f) => f.target === 999n));
  });
});

describe("animate", () => {
  it("pops in, rises, fades and retires back to the pool", () => {
    const n = new CombatNumbers();
    n.hit(hit(PLAYER, 2n, 5), PLAYER, 0);
    const f = live(n)[0]!;
    n.update(0.016);
    const y1 = f.y;
    assert.ok(f.s < f.scale * 1.5 && f.s > 0);
    n.update(0.2);
    assert.ok(f.y < y1, "rises (screen y goes up)");
    n.update(0.6);
    assert.ok(f.alpha < 1);
    n.update(0.5);
    assert.equal(n.count, 0);
    assert.equal(n.motion.activeCount, 0);
  });
});
