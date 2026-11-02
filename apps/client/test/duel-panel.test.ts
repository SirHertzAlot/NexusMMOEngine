/** The duel window's state (roadmap M5, protocol 0x20): what the server's duel messages mean for this player. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DuelMessage } from "@mmo-engine/protocol";
import { duelOpponent, nextDuel } from "../src/ui/duel-panel.js";

const msg = (state: DuelMessage["state"], a: string, b: string, extra: Partial<DuelMessage> = {}): DuelMessage => ({
  kind: "duel",
  tick: 1,
  state,
  a,
  b,
  ...extra,
});

describe("duel window state", () => {
  it("a challenge to me is incoming; a challenge I sent is outgoing", () => {
    assert.deepEqual(nextDuel(null, msg("challenged", "7", "me"), "me"), { phase: "incoming", a: "7", b: "me" });
    assert.deepEqual(nextDuel(null, msg("challenged", "me", "7"), "me"), { phase: "outgoing", a: "me", b: "7" });
  });

  it("accepted and started put the pair in an active duel", () => {
    assert.equal(nextDuel({ phase: "incoming", a: "7", b: "me" }, msg("accepted", "7", "me"), "me")?.phase, "active");
    assert.equal(nextDuel(null, msg("started", "7", "me"), "me")?.phase, "active");
  });

  it("declined, expired and ended clear the window", () => {
    const open = { phase: "active" as const, a: "7", b: "me" };
    assert.equal(nextDuel(open, msg("ended", "7", "me", { reason: "blood", winner: "me" }), "me"), null);
    assert.equal(nextDuel({ phase: "outgoing", a: "me", b: "7" }, msg("declined", "me", "7", { reason: "declined" }), "me"), null);
    assert.equal(nextDuel({ phase: "outgoing", a: "me", b: "7" }, msg("expired", "me", "7", { reason: "expired" }), "me"), null);
  });

  it("a duel between two other players leaves my window as it was", () => {
    const mine = { phase: "incoming" as const, a: "9", b: "me" };
    assert.equal(nextDuel(mine, msg("started", "3", "4"), "me"), mine);
    assert.equal(nextDuel(null, msg("challenged", "3", "4"), "me"), null);
  });

  it("the opponent is the other player in the pair", () => {
    assert.equal(duelOpponent({ phase: "active", a: "7", b: "me" }, "me"), "7");
    assert.equal(duelOpponent({ phase: "active", a: "me", b: "7" }, "me"), "7");
  });
});
