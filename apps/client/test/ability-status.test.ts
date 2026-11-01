/** The ability bar's and status frame's state (roadmap M5, protocol 0x1d and 0x1f). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AbilityMessage, StatusMessage } from "@mmo-engine/protocol";
import { NO_ABILITY_STATE, abilityEntries, nextAbilityState } from "../src/ui/ability-bar.js";
import { nextStatuses } from "../src/ui/status-frame.js";

const ab = (state: AbilityMessage["state"], id: string, entity = "me"): AbilityMessage => ({
  kind: "ability",
  tick: 1,
  entity,
  id,
  state,
});

const st = (state: StatusMessage["state"], id: string, extra: Partial<StatusMessage> = {}, entity = "me"): StatusMessage => ({
  kind: "status",
  tick: 1,
  entity,
  id,
  state,
  ...extra,
});

describe("nextAbilityState", () => {
  it("shows the player's cast and clears it when it fires", () => {
    let s = nextAbilityState(NO_ABILITY_STATE, ab("casting", "heal"), "me");
    assert.equal(s.casting, "heal");
    s = nextAbilityState(s, ab("fired", "heal"), "me");
    assert.equal(s.casting, null);
  });

  it("holds one press behind the cast and promotes it when it fires", () => {
    let s = nextAbilityState(NO_ABILITY_STATE, ab("casting", "heal"), "me");
    s = nextAbilityState(s, ab("queued", "strike"), "me");
    assert.equal(s.queued, "strike");
    s = nextAbilityState(s, ab("fired", "strike"), "me");
    assert.equal(s.queued, null);
  });

  it("clears the cast when interrupted", () => {
    let s = nextAbilityState(NO_ABILITY_STATE, ab("casting", "heal"), "me");
    s = nextAbilityState(s, ab("interrupted", "heal"), "me");
    assert.equal(s.casting, null);
  });

  it("ignores other players and rejections", () => {
    const s = nextAbilityState(NO_ABILITY_STATE, ab("casting", "heal", "other"), "me");
    assert.equal(s, NO_ABILITY_STATE);
    const r = nextAbilityState(NO_ABILITY_STATE, ab("rejected", "heal"), "me");
    assert.equal(r, NO_ABILITY_STATE);
  });
});

describe("abilityEntries", () => {
  it("reads the content file's abilities in order, keeping names", () => {
    const list = abilityEntries({ abilities: [{ id: "strike", name: "Strike", gcdMs: 1000 }, { id: "heal" }] });
    assert.deepEqual(list, [{ id: "strike", name: "Strike" }, { id: "heal" }]);
  });

  it("drops entries without an id and gives an empty bar for another shape", () => {
    assert.deepEqual(abilityEntries({ abilities: [{ name: "x" }, { id: "" }, { id: "guard" }] }), [{ id: "guard" }]);
    assert.deepEqual(abilityEntries({ nope: true }), []);
    assert.deepEqual(abilityEntries(null), []);
  });
});

describe("nextStatuses", () => {
  it("adds, restacks and removes the player's statuses", () => {
    let list = nextStatuses([], st("applied", "bleed"), "me");
    assert.deepEqual(list, [{ id: "bleed", stacks: 1 }]);
    list = nextStatuses(list, st("applied", "bleed", { stacks: 3 }), "me");
    assert.deepEqual(list, [{ id: "bleed", stacks: 3 }]);
    list = nextStatuses(list, st("removed", "bleed"), "me");
    assert.deepEqual(list, []);
  });

  it("leaves statuses on other entities out of the frame", () => {
    const list = nextStatuses([{ id: "haste", stacks: 1 }], st("applied", "bleed", {}, "other"), "me");
    assert.deepEqual(list, [{ id: "haste", stacks: 1 }]);
  });
});
