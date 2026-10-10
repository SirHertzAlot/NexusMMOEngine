/** Mastery notices (M4): disciplines earned and disarms. */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HitMessage, SkillsMessage } from "@mmo-engine/protocol";
import { disarmNotice, disciplineNotices } from "../src/ui/mastery-notice.js";

const skills = (ids: string[]): SkillsMessage => ({
  kind: "skills",
  max: 100,
  skills: [],
  familiarity: [],
  disciplines: ids.map((id) => ({ id, name: id === "bladeMaster" ? "Blade Master" : "Spearman", active: true, unlocks: id === "bladeMaster" ? ["disarm"] : [] })),
});

describe("mastery notices", () => {
  it("names a discipline when it is earned, not on joining", () => {
    assert.deepEqual(disciplineNotices(null, skills(["bladeMaster"])), []);
    assert.deepEqual(disciplineNotices(skills([]), skills(["bladeMaster"])), ["Discipline earned: Blade Master (unlocks disarm)"]);
    assert.deepEqual(disciplineNotices(skills(["bladeMaster"]), skills(["bladeMaster", "spearman"])), ["Discipline earned: Spearman"]);
    assert.deepEqual(disciplineNotices(skills(["bladeMaster"]), skills(["bladeMaster"])), []);
  });

  it("tells the disarmed and the one who disarmed", () => {
    const hit: HitMessage = { kind: "hit", tick: 1, source: "1", target: "2", outcome: "blocked", amount: 0, health: 100, max: 100, disarmed: true };
    assert.equal(disarmNotice(hit, "1"), "You were disarmed!");
    assert.equal(disarmNotice(hit, "2"), "You disarmed them");
    assert.equal(disarmNotice(hit, "3"), null);
    assert.equal(disarmNotice({ ...hit, disarmed: undefined }, "1"), null);
  });
});
