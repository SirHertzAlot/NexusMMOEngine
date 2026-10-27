/**
 * Character Foundation tests (spec phases 0, 1, 2, 3 and data invariants).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCharacterCatalogs,
  defaultCharacterCatalogs,
  loadCharacterCatalogs,
  generateCharacter,
  resolveProfile,
  quantize3,
  clamp,
  professionScore,
  assembleBackstory,
  alignmentBand,
  barkFor,
  generateSettlement,
  type CharacterCatalogs,
  type CharacterGenerationContext,
  type Npc,
} from "../src/index.js";

describe("Phase 0 — Catalogs as data", () => {
  const catalogs = defaultCharacterCatalogs();

  it("validates the builtin character catalogs without issues", () => {
    const issues = checkCharacterCatalogs(catalogs);
    assert.deepEqual(issues, [], "Builtin catalogs must pass all schema and cross-reference checks");
    assert.ok(Object.keys(catalogs.archetypes).length >= 10);
    assert.ok(Object.keys(catalogs.temperaments).length >= 8);
    assert.ok(Object.keys(catalogs.interests).length >= 8);
    assert.ok(Object.keys(catalogs.descriptors).length >= 16);
    assert.ok(catalogs.rules.length >= 20);
    assert.ok(Object.keys(catalogs.fragments).length >= 12);
  });

  it("fails loudly when an archetype references an unknown temperament", () => {
    const broken: CharacterCatalogs = {
      ...catalogs,
      archetypes: {
        ...catalogs.archetypes,
        broken_arch: {
          ...catalogs.archetypes[Object.keys(catalogs.archetypes)[0]!]!,
          id: "broken_arch",
          temperamentPool: { unknown_temperament_xyz: 10 },
        },
      },
    };
    const issues = checkCharacterCatalogs(broken);
    assert.ok(issues.some((i) => i.path.includes("unknown_temperament_xyz")), "Should report unknown temperament");
  });

  it("fails loudly when a rule gives an unknown descriptor", () => {
    const broken: CharacterCatalogs = {
      ...catalogs,
      rules: [
        ...catalogs.rules,
        {
          when: {},
          gives: "nonexistent_descriptor",
        },
      ],
    };
    const issues = checkCharacterCatalogs(broken);
    assert.ok(issues.some((i) => i.path.includes("rules") && i.message.includes("nonexistent_descriptor")), "Should report unknown descriptor in rule");
  });

  it("fails loudly when a descriptor references an unknown conflict", () => {
    const broken: CharacterCatalogs = {
      ...catalogs,
      descriptors: {
        ...catalogs.descriptors,
        mean: {
          ...catalogs.descriptors.mean!,
          conflicts: ["phantom_conflict_descriptor"],
        },
      },
    };
    const issues = checkCharacterCatalogs(broken);
    assert.ok(issues.some((i) => i.path.includes("conflicts") && i.message.includes("phantom_conflict_descriptor")), "Should report unknown conflict descriptor");
  });
});

describe("Phase 1 — Resolver & Generator (pure goldens)", () => {
  const catalogs = defaultCharacterCatalogs();

  it("Fixture A: resolves the veteran gate guard trace (§14)", () => {
    // Draws: archetype veteran (aggression x1.3, composure x1.2),
    // temperament hot-headed (composure x0.6, aggression x1.2, fleeMod -0.05),
    // alignment benevolence -28 (mean-leaning), order +41 (orderly),
    // interests [combat, leadership, hearth].
    // Rules fire: benevolence leaning-negative -> mean; dutiful (order +41 + guard role).
    // Base aggression: 1.0 * 1.3 * 1.2 = 1.56. Composure: 1.0 * 1.2 * 0.6 = 0.72. Flee bias negative.
    const char = generateCharacter(
      {
        characterId: "guard_fixture_a",
        cohort: "adult",
        role: "guard",
        profession: "guard",
        pins: {
          archetypeId: "veteran",
          temperamentId: "hot-headed",
          alignment: { benevolence: -28, order: 41 },
          interests: [
            { id: "combat", score: 3 },
            { id: "leadership", score: 2 },
            { id: "hearth", score: 1 },
          ],
        },
      },
      catalogs,
    );

    assert.equal(char.archetypeId, "veteran");
    assert.equal(char.temperamentId, "hot-headed");
    assert.equal(char.alignment.benevolence, -28);
    assert.equal(char.alignment.order, 41);

    // Descriptors: mean (demeanor) and dutiful (moral)
    assert.ok(char.descriptorIds.includes("mean"), `Expected 'mean' in ${JSON.stringify(char.descriptorIds)}`);
    assert.ok(char.descriptorIds.includes("dutiful"), `Expected 'dutiful' in ${JSON.stringify(char.descriptorIds)}`);

    // Pure profile resolution without jitter for exact trace check
    const exactProfile = resolveProfile(
      {
        archetypeId: "veteran",
        temperamentId: "hot-headed",
        alignment: { benevolence: -28, order: 41 },
        descriptorIds: char.descriptorIds,
      },
      catalogs,
      catalogs.defaults,
      0, // zero jitter
    );

    // Aggression: base(1.0) * veteran(1.3) * hot-headed(1.2) = 1.56
    assert.equal(exactProfile.weights.aggression, 1.56);
    // Composure: base(1.0) * veteran(1.2) * hot-headed(0.6) * dutiful(1.1) * brave(1.2) = 0.95
    assert.equal(exactProfile.weights.composure, 0.95);
    // Negative flee bias
    assert.ok(exactProfile.fleeBias < 0, `Flee bias ${exactProfile.fleeBias} should be negative`);
    // Tone
    assert.equal(exactProfile.barkTone, "mean");
  });

  it("Fixture B: resolves the devout chapel guard trace (§14)", () => {
    // Draws: archetype devout, temperament bold, alignment benevolence +64 (good),
    // order -58 (near-chaotic), interests [combat, faith, wandering].
    // Rules fire: kind-hearted (demeanor), loves-a-fight (drive).
    const char = generateCharacter(
      {
        characterId: "guard_fixture_b",
        cohort: "adult",
        role: "guard",
        profession: "guard",
        pins: {
          archetypeId: "devout",
          temperamentId: "bold",
          alignment: { benevolence: 64, order: -58 },
          interests: [
            { id: "combat", score: 3 },
            { id: "faith", score: 2 },
            { id: "wandering", score: 1 },
          ],
        },
      },
      catalogs,
    );

    assert.equal(char.archetypeId, "devout");
    assert.equal(char.temperamentId, "bold");
    assert.equal(char.alignment.benevolence, 64);
    assert.equal(char.alignment.order, -58);

    assert.ok(char.descriptorIds.includes("kind-hearted"), `Expected 'kind-hearted' in ${JSON.stringify(char.descriptorIds)}`);
    assert.ok(char.descriptorIds.includes("loves-a-fight"), `Expected 'loves-a-fight' in ${JSON.stringify(char.descriptorIds)}`);

    const exactProfile = resolveProfile(
      {
        archetypeId: "devout",
        temperamentId: "bold",
        alignment: { benevolence: 64, order: -58 },
        descriptorIds: char.descriptorIds,
      },
      catalogs,
      catalogs.defaults,
      0,
    );

    assert.ok(exactProfile.fleeBias < -0.05, `Flee bias ${exactProfile.fleeBias} strongly negative`);
    assert.equal(exactProfile.barkTone, "kind-hearted");
  });
});

describe("Invariants (§16)", () => {
  const catalogs = defaultCharacterCatalogs();

  it("Invariant 2: Determinism — same seed yields identical character instance", () => {
    const make = () =>
      generateCharacter(
        {
          characterId: "fixed_test_npc",
          seedStream: {
            // stable sequence
            next: (() => {
              let s = 42;
              return () => {
                s = (s * 16807) % 2147483647;
                return (s - 1) / 2147483646;
              };
            })(),
          },
          cohort: "adult",
          classId: "artisan",
          role: "baker",
          townId: "town_det",
        },
        catalogs,
      );

    const c1 = make();
    const c2 = make();
    assert.deepEqual(c1, c2, "Same seed sequence must produce byte-for-byte identical CharacterInstance");
  });

  it("Invariant 3: Profile bounds — all resolved weights in [0.25, 2.5] quantized to 3 decimals, biases in [-0.5, 0.5]", () => {
    // Generate 50 characters with random seeds and verify bounds on all
    for (let i = 0; i < 50; i++) {
      let s = 1000 + i;
      const rng = {
        next: () => {
          s = (s * 16807) % 2147483647;
          return (s - 1) / 2147483646;
        },
      };
      const char = generateCharacter(
        {
          characterId: `fuzz_${i}`,
          seedStream: rng,
          cohort: i % 5 === 0 ? "child" : "adult",
          classId: "peasant",
        },
        catalogs,
      );

      for (const [axis, w] of Object.entries(char.profile.weights)) {
        assert.ok(w >= 0.25 && w <= 2.5, `Axis ${axis} weight ${w} out of bounds [0.25, 2.5]`);
        assert.equal(w, quantize3(w), `Axis ${axis} weight ${w} not quantized to 3 decimals`);
      }
      for (const [biasName, b] of [
        ["fleeBias", char.profile.fleeBias],
        ["trustBias", char.profile.trustBias],
        ["gossipBias", char.profile.gossipBias],
      ] as const) {
        assert.ok(b >= -0.5 && b <= 0.5, `Bias ${biasName} ${b} out of bounds [-0.5, 0.5]`);
      }
    }
  });

  it("Invariant 4: Descriptor discipline — <= 4 descriptors, <= 1 per slot, no conflicts", () => {
    for (let i = 0; i < 50; i++) {
      const char = generateCharacter(
        {
          characterId: `desc_check_${i}`,
          cohort: "adult",
          classId: "merchant",
        },
        catalogs,
      );

      assert.ok(char.descriptorIds.length <= 4, "Must have <= 4 descriptors");
      const slotsSeen = new Set<string>();
      for (const dId of char.descriptorIds) {
        const d = catalogs.descriptors[dId]!;
        assert.ok(d, `Unknown descriptor ${dId}`);
        assert.ok(!slotsSeen.has(d.slot), `Multiple descriptors for slot ${d.slot}`);
        slotsSeen.add(d.slot);
        for (const conflict of d.conflicts) {
          assert.ok(!char.descriptorIds.includes(conflict), `Conflict detected between ${dId} and ${conflict}`);
        }
      }
    }
  });

  it("Invariant 6: Pins are absolute — authored pins never overwritten", () => {
    const char = generateCharacter(
      {
        characterId: "pinned_major",
        cohort: "adult",
        pins: {
          archetypeId: "scholar",
          temperamentId: "brooding",
          alignment: { benevolence: -75, order: 80 },
          interests: [{ id: "scholarly", score: 3 }],
          descriptorIds: ["cynical", "dutiful"],
        },
      },
      catalogs,
    );

    assert.equal(char.archetypeId, "scholar");
    assert.equal(char.temperamentId, "brooding");
    assert.equal(char.alignment.benevolence, -75);
    assert.equal(char.alignment.order, 80);
    assert.deepEqual(char.descriptorIds, ["cynical", "dutiful"]);
    assert.equal(char.origin, "authored");
  });

  it("Child latency: child cohort leaves archetype and interests latent", () => {
    const child = generateCharacter(
      {
        characterId: "village_child",
        cohort: "child",
        classId: "peasant",
      },
      catalogs,
    );

    assert.equal(child.archetypeId, "latent");
    assert.deepEqual(child.interests, []);
  });
});

describe("Profession Scoring (§11)", () => {
  const catalogs = defaultCharacterCatalogs();

  it("scores candidates with demand gate, interest links, and archetype affinity", () => {
    const fighter = generateCharacter(
      {
        characterId: "fighter_1",
        cohort: "adult",
        pins: {
          archetypeId: "veteran",
          interests: [
            { id: "combat", score: 3 },
            { id: "leadership", score: 2 },
            { id: "hearth", score: 1 },
          ],
        },
      },
      catalogs,
    );

    const scholar = generateCharacter(
      {
        characterId: "scholar_1",
        cohort: "adult",
        pins: {
          archetypeId: "scholar",
          interests: [
            { id: "scholarly", score: 3 },
            { id: "arcana", score: 2 },
            { id: "politics", score: 1 },
          ],
        },
      },
      catalogs,
    );

    const guardScoreFighter = professionScore(fighter, "guard", catalogs);
    const guardScoreScholar = professionScore(scholar, "guard", catalogs);
    assert.ok(guardScoreFighter > guardScoreScholar, `Fighter score (${guardScoreFighter}) should exceed scholar (${guardScoreScholar}) for guard`);

    // Demand gate zero check
    const gated = professionScore(fighter, "guard", catalogs, { demandGated: false });
    assert.equal(gated, 0, "Demand gated false must return 0");

    // Mastery bonus
    const masterScore = professionScore(fighter, "guard", catalogs, { masteryBonus: 2 });
    assert.ok(masterScore > guardScoreFighter, "Mastery bonus should increase score");
  });
});

describe("Phase 3 — Barks Reader Integration (§12)", () => {
  const catalogs = defaultCharacterCatalogs();

  it("two same-role residents with different profiles produce observably different barks over a game week", () => {
    // Mean guard (Fixture A) vs Kind guard (Fixture B)
    const meanGuard: Npc = {
      id: "guard_mean",
      household: "h1",
      home: "home_1",
      cohort: "adult",
      class: "guard",
      role: "guard",
      workplace: "guardhouse",
      character: generateCharacter(
        {
          characterId: "guard_mean",
          cohort: "adult",
          role: "guard",
          pins: {
            archetypeId: "veteran",
            temperamentId: "hot-headed",
            alignment: { benevolence: -28, order: 41 },
            descriptorIds: ["mean", "dutiful"],
          },
        },
        catalogs,
      ),
    };

    const kindGuard: Npc = {
      id: "guard_kind",
      household: "h1",
      home: "home_1",
      cohort: "adult",
      class: "guard",
      role: "guard",
      workplace: "guardhouse",
      character: generateCharacter(
        {
          characterId: "guard_kind",
          cohort: "adult",
          role: "guard",
          pins: {
            archetypeId: "devout",
            temperamentId: "bold",
            alignment: { benevolence: 64, order: -58 },
            descriptorIds: ["kind-hearted", "loves-a-fight"],
          },
        },
        catalogs,
      ),
    };

    const meanBarks = Array.from({ length: 7 }, (_, day) =>
      barkFor(meanGuard, { timeOfDay: 0.5, day, workplace: "guardhouse" }),
    );
    const kindBarks = Array.from({ length: 7 }, (_, day) =>
      barkFor(kindGuard, { timeOfDay: 0.5, day, workplace: "guardhouse" }),
    );

    // Assert that their barks over 7 days are observably different
    assert.notDeepEqual(meanBarks, kindBarks, "Different personality profiles must produce different weekly barks");
    // Mean guard should have gruff greetings or mean lines
    assert.ok(meanBarks.some((b) => /What do you want|Make it quick|Speak up|Hmph|Don't get in my way|wasting my time|Duty|Orders/i.test(b)));
    // Kind guard should have warm greetings or kind lines
    assert.ok(kindBarks.some((b) => /Welcome|friend|Blessings|Take care|hand|Safe travels|brawl|sword hand|skirmish/i.test(b)));
  });
});

describe("Phase 2 — Settlement Bake Integration (§15)", () => {
  it("generates characters with valid profiles for all town NPCs and emits character events", () => {
    const res = generateSettlement({
      settlementId: "test_char_town",
      seed: 9876,
      population: 150,
      verbosity: "verbose",
    });

    assert.ok(res.ok);
    const manifest = res.manifest;
    assert.ok(manifest.occupancy.npcs.length >= 100);

    for (const npc of manifest.occupancy.npcs) {
      assert.ok(npc.character, `NPC ${npc.id} must have a character instance`);
      assert.ok(npc.character.profile, `NPC ${npc.id} must have a resolved profile`);
      assert.ok(npc.character.backstory, `NPC ${npc.id} must have backstory`);
      assert.ok(npc.character.backstory.text, `NPC ${npc.id} must have rendered backstory text`);
    }

    // Check summary event
    const charEvents = res.events.filter((e) => e.stage === "character");
    assert.ok(charEvents.length > 0, "Should emit character events");
    const profiled = charEvents.find((e) => e.event === "profiled");
    assert.ok(profiled, "Should emit character:profiled summary event");
  });
});
