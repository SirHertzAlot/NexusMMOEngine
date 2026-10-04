/** Spell notices (0x1c): what the caster and the target read. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SpellMessage } from "@mmo-engine/protocol";
import { spellNotice } from "../src/ui/spell-notice.js";

const msg = (over: Partial<SpellMessage>): SpellMessage => ({ kind: "spell", caster: "1", target: "1", spell: "mend", state: "started", ...over });

describe("spellNotice", () => {
  it("speaks to a caster", () => {
    assert.equal(spellNotice(msg({ seconds: 2 }), "1"), "Casting Mend (2 s)");
    assert.equal(spellNotice(msg({ state: "done", amount: 14.6 }), "1"), "Mend healed you for 15");
    assert.equal(spellNotice(msg({ state: "done", amount: 15, target: "2" }), "1"), "Mend healed them for 15");
    assert.equal(spellNotice(msg({ state: "stopped" }), "1"), "Cast stopped");
  });

  it("speaks to the target, and to no one else", () => {
    assert.equal(spellNotice(msg({ caster: "2" }), "1"), "Someone is casting Mend on you");
    assert.equal(spellNotice(msg({ caster: "2", state: "done", amount: 15 }), "1"), "Mend healed you for 15");
    assert.equal(spellNotice(msg({ caster: "2", state: "stopped" }), "1"), null);
    assert.equal(spellNotice(msg({ caster: "2", target: "3" }), "1"), null);
  });
});
