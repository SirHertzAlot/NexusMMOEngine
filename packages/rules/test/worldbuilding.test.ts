import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MagicSourceSchema,
  PowerDeclarationSchema,
  CostLedgerSchema,
  deriveSourceConsequences,
  accrueCost,
  applyWard,
  repayCost,
  computeBleedIntensity,
  evaluateFabricHealth,
  stepShrineDevotion,
} from "../src/worldbuilding.js";

describe("KR House worldbuilding metaphysics (Systems 1 & 5 + particle bridge)", () => {
  it("parses magicSource models and derives social/VFX consequences", () => {
    const life = MagicSourceSchema.parse({
      id: "greenhollow-weave",
      model: "life",
      sourceDetail: "Deep root-fabric binding soil and sap",
      access: "Unwarded instinct or grove-wright training",
      price: "life-debt",
      giftedRole: "worker",
    });
    const out = deriveSourceConsequences(life);
    assert.equal(out.primaryGeneric, "sick-places");
    assert.equal(out.ambientEffectId, "life-motes");

    const blended = MagicSourceSchema.parse({
      id: "eshira-windcall",
      model: "blend",
      blendModels: ["beings", "worship"],
      sourceDetail: "Storm spirits mediated by the State Goddess's ward monopoly",
      access: "Licensed priests and unwarded outcasts",
      price: "corruption",
      giftedRole: "outcast",
    });
    assert.equal(deriveSourceConsequences(blended).primaryGeneric, "pact-ledger");

    assert.throws(() =>
      MagicSourceSchema.parse({
        id: "broken-blend",
        model: "blend",
        sourceDetail: "Missing blend array",
        access: "Anyone",
        price: "corruption",
      }),
    );
  });

  it("validates power declarations with explicit limits, verbs, and cost type", () => {
    const plantCalling = PowerDeclarationSchema.parse({
      id: "briar-shape",
      name: "Briar Shaping",
      costType: "life-debt",
      costPerUse: 12,
      limits: ["Must plant a seed first", "Only living flora within 15 m"],
      verbs: ["bind", "bridge", "thorn-wall", "canopy-shield"],
    });
    assert.equal(plantCalling.verbs.length, 4);
    assert.throws(() =>
      PowerDeclarationSchema.parse({
        id: "unbounded",
        name: "Omnipotence",
        costType: "corruption",
        costPerUse: 0,
        limits: [],
        verbs: ["win"],
      }),
    );
  });

  it("tracks cost ledger accrual, ward protection/expiry, bleed suppression, and repayment", () => {
    let ledger = CostLedgerSchema.parse({
      holder: "caller-kaelen",
      costType: "corruption",
      accrued: 20,
      threshold: 100,
    });
    const now = 1_000_000;
    assert.equal(computeBleedIntensity(ledger, now), 0.2);

    // Ward absorbs 90% of accrued cost & suppresses external bleed
    ledger = applyWard(
      ledger,
      {
        id: "ash-rune",
        name: "Ash Ward Rune",
        absorbs: "corruption",
        attenuation: 0.9,
        capacity: 50,
        expiresAt: now + 60_000,
      },
      now,
    );
    const warded = accrueCost(ledger, 30, now + 1_000);
    assert.equal(warded.wardProtected, true);
    assert.equal(warded.appliedCost, 3);
    assert.equal(warded.absorbedCost, 27);
    assert.equal(warded.ledger.accrued, 23);
    assert.ok(warded.bleedIntensity < 0.05);
    assert.equal(warded.matured, false);

    // After ward expiry, full accrual lands and crosses threshold -> Price Comes Due
    const unwarded = accrueCost(warded.ledger, 80, now + 120_000);
    assert.equal(unwarded.wardProtected, false);
    assert.equal(unwarded.ledger.accrued, 103);
    assert.equal(unwarded.bleedIntensity, 1);
    assert.equal(unwarded.matured, true);

    const repaid = repayCost(unwarded.ledger, 40);
    assert.equal(repaid.accrued, 63);
  });

  it("drives life-motes signal from regional fabricHealth and tracks shrine devotion states", () => {
    assert.deepEqual(evaluateFabricHealth({ regionId: "eldwood", health: 90, cause: "healthy" }), {
      tier: "thriving",
      lifeMotesIntensity: 1,
      sickPlaceTriggered: false,
    });
    assert.deepEqual(evaluateFabricHealth({ regionId: "eldwood", health: 30, cause: "pact-drain" }), {
      tier: "sick",
      lifeMotesIntensity: 0.4,
      sickPlaceTriggered: true,
    });
    assert.deepEqual(evaluateFabricHealth({ regionId: "blight", health: 0, cause: "dead-grove-heart" }), {
      tier: "dead",
      lifeMotesIntensity: 0,
      sickPlaceTriggered: true,
    });

    const kept = stepShrineDevotion({ shrineId: "sun-hearth", patronId: "sol", devotion: 35 }, 10);
    assert.equal(kept.state, "kept");
    const neglected = stepShrineDevotion({ shrineId: "sun-hearth", patronId: "sol", devotion: 35 }, -15);
    assert.equal(neglected.state, "neglected");
    const contested = stepShrineDevotion(
      { shrineId: "sun-hearth", patronId: "sol", devotion: 70, contestedBy: "veil" },
      0,
    );
    assert.equal(contested.state, "contested");
  });
});
