/**
 * CombatFeedback (U12a): hit flashes and the target rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HitMessage } from "@mmo-engine/protocol";
import { CombatFeedback, FLASH_SECONDS } from "../src/render/combat-feedback.js";

const PLAYER = 1n;

function hit(source: bigint, target: bigint, outcome: HitMessage["outcome"] = "hit"): HitMessage {
  return { kind: "hit", tick: 1, source: String(source), target: String(target), outcome, amount: 5, health: 10, max: 20 };
}

describe("CombatFeedback", () => {
  it("flashes hits and blocks, not dodges", () => {
    const c = new CombatFeedback();
    c.hit(hit(PLAYER, 2n), PLAYER, 10);
    c.hit(hit(PLAYER, 3n, "blocked"), PLAYER, 10);
    c.hit(hit(PLAYER, 4n, "dodged"), PLAYER, 10);
    assert.equal(c.flashUntil.get(2n), 10 + FLASH_SECONDS);
    assert.ok(c.flashUntil.has(3n));
    assert.ok(!c.flashUntil.has(4n));
  });

  it("targets what the player strikes", () => {
    const c = new CombatFeedback();
    c.hit(hit(PLAYER, 2n), PLAYER, 0);
    assert.equal(c.target, 2n);
    c.hit(hit(PLAYER, 3n), PLAYER, 0);
    assert.equal(c.target, 3n);
  });

  it("targets an attacker only when nothing is targeted", () => {
    const c = new CombatFeedback();
    c.hit(hit(5n, PLAYER), PLAYER, 0);
    assert.equal(c.target, 5n);
    c.hit(hit(6n, PLAYER), PLAYER, 0);
    assert.equal(c.target, 5n);
  });

  it("ignores blows between others for targeting", () => {
    const c = new CombatFeedback();
    c.hit(hit(7n, 8n), PLAYER, 0);
    assert.equal(c.target, null);
    assert.ok(c.flashUntil.has(8n));
  });

  it("prunes expired flashes and a vanished target", () => {
    const c = new CombatFeedback();
    c.hit(hit(PLAYER, 2n), PLAYER, 0);
    c.prune(() => true, FLASH_SECONDS / 2);
    assert.ok(c.flashUntil.has(2n));
    assert.equal(c.target, 2n);
    c.prune(() => false, FLASH_SECONDS);
    assert.equal(c.flashUntil.size, 0);
    assert.equal(c.target, null);
  });

  it("clears a flash on respawn and selects by hand", () => {
    const c = new CombatFeedback();
    c.hit(hit(PLAYER, 2n), PLAYER, 0);
    c.life({ kind: "life", tick: 2, target: "2", state: "alive" });
    assert.ok(!c.flashUntil.has(2n));
    c.select(9n);
    assert.equal(c.target, 9n);
    c.select(null);
    assert.equal(c.target, null);
  });
});
