/**
 * DuelSystem: challenges, accept/decline/expiry, the hostility query,
 * yield, first blood, and ad-hoc hostility.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DuelSystem } from "../src/duel.js";

const HZ = 30;
const ticks = (ms: number): number => Math.round((ms / 1000) * HZ);

describe("DuelSystem", () => {
  it("challenge -> accept lets the pair hit each other and no one else", () => {
    const d = new DuelSystem(HZ);
    assert.equal(d.challenge(1, 2, 10), true);
    assert.equal(d.canHit(1, 2), false, "not hostile until accepted");
    assert.equal(d.accept(2, 11), true);
    assert.equal(d.canHit(1, 2), true);
    assert.equal(d.canHit(2, 1), true);
    assert.equal(d.canHit(1, 3), false, "a bystander is safe");
    assert.equal(d.canHit(1, 1), false, "never yourself");
    assert.equal(d.opponent(1), 2);
    assert.equal(d.inDuel(2), true);
    const ev = d.drainEvents();
    assert.deepEqual(
      ev.map((e) => e.state),
      ["challenged", "accepted", "started"],
    );
  });

  it("declining ends the challenge with no hostility", () => {
    const d = new DuelSystem(HZ);
    d.challenge(1, 2, 10);
    assert.equal(d.decline(2, 11), true);
    assert.equal(d.canHit(1, 2), false);
    const ev = d.drainEvents();
    assert.equal(ev[ev.length - 1].state, "declined");
  });

  it("unanswered challenges expire", () => {
    const d = new DuelSystem(HZ);
    d.challenge(1, 2, 10);
    d.step(10 + ticks(30000) + 1);
    assert.equal(d.accept(2, 10 + ticks(30000) + 2), false, "too late");
    const ev = d.drainEvents();
    assert.equal(ev[ev.length - 1].state, "expired");
  });

  it("yield ends the duel with the other as winner", () => {
    const d = new DuelSystem(HZ);
    d.challenge(1, 2, 10);
    d.accept(2, 11);
    assert.equal(d.yield(1, 20), true);
    assert.equal(d.canHit(1, 2), false, "hostility ends with the duel");
    assert.equal(d.inDuel(1), false);
    const ev = d.drainEvents();
    const ended = ev[ev.length - 1];
    assert.equal(ended.state, "ended");
    assert.equal(ended.reason, "yield");
    assert.equal(ended.winner, 2);
  });

  it("first blood ends the duel and names the winner", () => {
    const d = new DuelSystem(HZ);
    d.challenge(1, 2, 10);
    d.accept(2, 11);
    assert.equal(d.checkBlood(1, 0.5, 20), undefined, "still standing");
    assert.equal(d.checkBlood(2, 0, 21), 1, "entity 1 wins");
    assert.equal(d.inDuel(1), false);
    const ev = d.drainEvents();
    assert.equal(ev[ev.length - 1].reason, "blood");
  });

  it("a busy duelist cannot be challenged", () => {
    const d = new DuelSystem(HZ);
    d.challenge(1, 2, 10);
    d.accept(2, 11);
    assert.equal(d.challenge(3, 1, 12), false, "1 is dueling");
    assert.equal(d.challenge(1, 3, 12), false, "1 is dueling");
  });

  it("setHostile marks ad-hoc hostility outside duels", () => {
    const d = new DuelSystem(HZ);
    d.setHostile(5, 6, true);
    assert.equal(d.canHit(5, 6), true);
    assert.equal(d.canHit(6, 5), true);
    d.setHostile(5, 6, false);
    assert.equal(d.canHit(5, 6), false);
  });

  it("duels time out as a draw", () => {
    const d = new DuelSystem(HZ, HZ, 60000);
    d.challenge(1, 2, 10);
    d.accept(2, 11);
    d.step(11 + ticks(60000) + 1);
    assert.equal(d.inDuel(1), false);
    const ev = d.drainEvents();
    const ended = ev[ev.length - 1];
    assert.equal(ended.state, "ended");
    assert.equal(ended.reason, "timeout");
    assert.equal(ended.winner, undefined, "a draw has no winner");
  });
});
