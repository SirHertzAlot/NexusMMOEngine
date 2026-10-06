/**
 * LiveOps scope drill-down: membership maps, visibility filter, and
 * scope helpers. The players table filters by scope; telemetry/chat/
 * ledger scopes swap in their section instead.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIVEOPS_ACCOUNTS,
  LIVEOPS_GUILDS,
  LIVEOPS_PARTIES,
  liveOpsScopeLabel,
  playerVisibleInScope,
} from "../src/ui/previews.js";

describe("playerVisibleInScope", () => {
  it("shows everyone without a membership scope", () => {
    for (const scope of [{ kind: "all" }, { kind: "telemetry" }, { kind: "chat" }, { kind: "ledger" }] as const) {
      assert.equal(playerVisibleInScope("Aria", scope), true);
      assert.equal(playerVisibleInScope("Nobody", scope), true);
    }
  });

  it("filters by account membership", () => {
    assert.equal(playerVisibleInScope("Cass", { kind: "account", name: "shell" }), true);
    assert.equal(playerVisibleInScope("Fenn", { kind: "account", name: "shell" }), true);
    assert.equal(playerVisibleInScope("Aria", { kind: "account", name: "shell" }), false);
    assert.equal(playerVisibleInScope("Aria", { kind: "account", name: "nope" }), false);
  });

  it("filters by guild and party membership", () => {
    assert.equal(playerVisibleInScope("Dov", { kind: "guild", name: "Coast Wardens" }), true);
    assert.equal(playerVisibleInScope("Cass", { kind: "guild", name: "Coast Wardens" }), false);
    assert.equal(playerVisibleInScope("Hale", { kind: "party", name: "party-1" }), true);
    assert.equal(playerVisibleInScope("Bram", { kind: "party", name: "party-1" }), false);
  });

  it("every map member names a real player row", () => {
    const players = ["Aria", "Bram", "Cass", "Dov", "Elin", "Fenn", "Gale", "Hale"];
    const all: string[][] = [
      ...Object.values(LIVEOPS_ACCOUNTS),
      ...Object.values(LIVEOPS_GUILDS),
      ...Object.values(LIVEOPS_PARTIES),
    ];
    for (const members of all) {
      for (const m of members) assert.ok(players.includes(m), `${m} is not a player row`);
    }
  });
});

describe("liveOpsScopeLabel", () => {
  it("labels every scope kind", () => {
    assert.equal(liveOpsScopeLabel({ kind: "all" }), "All players");
    assert.equal(liveOpsScopeLabel({ kind: "account", name: "shell" }), "Account shell");
    assert.equal(liveOpsScopeLabel({ kind: "guild", name: "Coast Wardens" }), "Guild Coast Wardens");
    assert.equal(liveOpsScopeLabel({ kind: "party", name: "party-1" }), "Party party-1");
    assert.equal(liveOpsScopeLabel({ kind: "telemetry" }), "Telemetry");
    assert.equal(liveOpsScopeLabel({ kind: "chat" }), "Chat & events");
    assert.equal(liveOpsScopeLabel({ kind: "ledger" }), "Item ledger");
  });
});
