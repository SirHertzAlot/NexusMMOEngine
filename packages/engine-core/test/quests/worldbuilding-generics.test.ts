import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryQuestStore, QuestLog } from "../../src/quests/quest-log.js";
import {
  PactSchema,
  RiteSchema,
  advancePact,
  pactDueQuest,
  performRite,
  riteQuest,
  treatSickPlace,
  priceDueOptions,
  composeGiverProfile,
} from "../../src/quests/worldbuilding-generics.js";
import { StepsFileSchema } from "../../src/quests/content.js";
import { CostLedgerSchema } from "@mmo-engine/rules";

describe("KR House Quest Generics (Pacts, Devotion Circuit, Sick Places, Price Due, Giver Engine)", () => {
  it("runs a Pact Ledger lifecycle from offered -> due -> settled and generates a QuestLog-compatible QuestDef", () => {
    let pact = PactSchema.parse({
      id: "thorn-bargain",
      being: "hollow-stag",
      holder: "player-1",
      gift: "thorn-stride",
      price: "Tend three boundary stones",
      clauses: ["Clear the northern well", "Leave iron at the cairn"],
      hiddenClause: "The stag claims one memory per winter",
    });
    pact = advancePact(pact, { type: "accept" });
    pact = advancePact(pact, { type: "clause-due" });
    pact = advancePact(pact, { type: "reveal-hidden" });
    const q = pactDueQuest(pact, "elder-rowan", { name: "Northern Well", x: 40, z: -25 });
    const log = new QuestLog(7, new MemoryQuestStore());
    const accept = log.accept(q);
    assert.equal(accept.ok, true);
    assert.ok(q.summary.includes("revealed clause"));

    pact = advancePact(pact, { type: "fulfil-clause" });
    assert.equal(pact.state, "active");
    pact = advancePact(pact, { type: "fulfil-clause" });
    assert.equal(pact.state, "settled");
  });

  it("drives repeatable Devotion Circuit rites and Sick Places behavioural recovery", () => {
    const rite = RiteSchema.parse({
      id: "solstice-tending",
      shrineId: "moss-hearth",
      name: "Solstice Hearth Tending",
      calendarWindow: "midwinter-eve",
      offerings: ["herb-bundle", "tallow-candle"],
      roles: ["bearer", "keeper"],
      devotionDelta: 18,
    });
    const res = performRite({ shrineId: "moss-hearth", patronId: "hearth-mother", devotion: 30 }, rite);
    assert.equal(res.shrine.devotion, 48);
    assert.equal(res.answered, true);
    assert.equal(riteQuest(rite, "keeper-mira", { name: "Moss Hearth", x: 10, z: 12 }).repeatable, true);

    const wrongFix = treatSickPlace({ regionId: "eldwood", health: 32, cause: "pact-drain" }, "replant-grove", 25);
    assert.equal(wrongFix.effective, false);
    assert.equal(wrongFix.fabric.health, 32);

    const rightFix = treatSickPlace(wrongFix.fabric, "sever-siphon", 55);
    assert.equal(rightFix.effective, true);
    assert.equal(rightFix.fabric.health, 87);
    assert.equal(rightFix.fabric.cause, "healthy");
  });

  it("exposes price-due options, structure skins on quest templates, and giver composition", () => {
    const ledger = CostLedgerSchema.parse({
      holder: "npc-maren",
      costType: "life-debt",
      accrued: 100,
      threshold: 100,
      paymentOptions: [{ id: "graft-bough", label: "Surrender living bough", relief: 50, consequence: "scarred-arm" }],
    });
    assert.ok(priceDueOptions(ledger).includes("graft-bough"));

    const parsedSteps = StepsFileSchema.parse({
      version: 1,
      stages: ["hook", "twist"],
      steps: {
        find: {
          stage: "hook",
          text: "Inspect {place}",
          objective: { type: "reach", place: "$place" },
        },
        reframe: {
          stage: "twist",
          text: "Speak to {giver}",
          objective: { type: "talk", npc: "$giver" },
        },
      },
      templates: {
        mystery: {
          name: "Mystery at {place}",
          stages: ["hook", "twist"],
          structure: "kishotenketsu",
        },
      },
    });
    assert.equal(parsedSteps.templates.mystery.structure, "kishotenketsu");

    const sig = composeGiverProfile("outcast", "truth", "greed");
    assert.equal(sig.preferredSkin, "kishotenketsu");
    assert.ok(sig.questHook.includes("truth"));
    assert.ok(sig.flawTwist.includes("withholds"));
  });
});
