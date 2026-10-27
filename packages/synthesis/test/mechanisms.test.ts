import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  evaluateCombination,
  invokeTrapCollision,
  resetTrap,
  disarmTrap,
  synthesizeAssembly,
  extractLearnedRuleSet,
  isConnectingTwoFloors,
  type CombinationPuzzleDefinition,
  type CollisionTrapDefinition,
  type SynthesisProblem,
  type ExampleAssembly,
} from "../src/index.js";

describe("Dungeon Combination Puzzles & Collision Traps", () => {
  const dummyPuzzle: CombinationPuzzleDefinition = {
    puzzleId: "test_gate_combination",
    name: "Trial of the Triple Runes",
    target: {
      type: "door",
      partId: "SM_Env_Door_Bars_01",
      targetRef: "Crypt_Sanctum_Gate",
      transform: { pos: [0, 2, 15], rot: [0, 1, 0, 0], scale: [1, 1, 1] },
      isLocked: true,
    },
    entrypoint: {
      inputs: [
        {
          slotIndex: 0,
          kind: "rune-pillar",
          partId: "SM_Env_Rune_Pillar_01",
          options: ["Hawk", "Serpent", "Wolf", "Dragon"],
          currentState: "Hawk",
          transform: { pos: [-2, 1.5, 10], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          slotIndex: 1,
          kind: "rune-pillar",
          partId: "SM_Env_Rune_Pillar_02",
          options: ["Hawk", "Serpent", "Wolf", "Dragon"],
          currentState: "Hawk",
          transform: { pos: [0, 1.5, 10], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          slotIndex: 2,
          kind: "rune-pillar",
          partId: "SM_Env_Rune_Pillar_04",
          options: ["Hawk", "Serpent", "Wolf", "Dragon"],
          currentState: "Hawk",
          transform: { pos: [2, 1.5, 10], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      ],
      promptTransform: { pos: [0, 1, 9], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
    solution: ["Wolf", "Serpent", "Dragon"],
    clues: [
      {
        clueIndex: 0,
        partId: "SM_Prop_Wall_Banner_02",
        symbol: "Wolf",
        clueType: "banner",
        description: "First Seal: Wolf",
        transform: { pos: [-6, 2, -10], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        roomLocation: "West Aisle",
      },
      {
        clueIndex: 1,
        partId: "SM_Env_Statue_01",
        symbol: "Serpent",
        clueType: "statue",
        description: "Second Seal: Serpent",
        transform: { pos: [6, 1.5, -2], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        roomLocation: "East Aisle",
      },
      {
        clueIndex: 2,
        partId: "SM_Prop_Wall_Banner_05",
        symbol: "Dragon",
        clueType: "carving",
        description: "Third Seal: Dragon",
        transform: { pos: [-6, 2, 5], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        roomLocation: "Approach Nave",
      },
    ],
    possibleCombinationsCount: 64, // 4^3
    onUnlock: {
      action: "open_door",
      animation: "door_bars_slide_open",
      grantsAccessTo: "Inner Sanctum",
    },
  };

  const dummyTrap: CollisionTrapDefinition = {
    trapId: "test_floor_spears",
    trapType: "floor-spear-grate",
    partId: "SM_Prop_Trap_Spears_Grate_01",
    assetRef: "SM_Prop_Trap_Spears_Grate_01",
    transform: { pos: [0, 0.05, 5], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
    triggerVolume: {
      shape: "box",
      boundsMin: [-1.25, 0.0, 3.75],
      boundsMax: [1.25, 0.4, 6.25],
      hidden: true,
    },
    onCollision: {
      animation: "spears_thrust_up",
      damage: 35,
      damageType: "physical",
      cooldownSec: 2.5,
      knockbackVec: [0, 2.5, 0],
    },
    state: "armed",
  };

  it("evaluates combination puzzle: correct sequence unlocks target", () => {
    const puzzle = JSON.parse(JSON.stringify(dummyPuzzle));
    const result = evaluateCombination(puzzle, ["Wolf", "Serpent", "Dragon"]);

    assert.equal(result.solved, true);
    assert.equal(result.targetUnlocked, true);
    assert.equal(puzzle.target.isLocked, false);
    assert.equal(result.animationToPlay, "door_bars_slide_open");
  });

  it("evaluates combination puzzle: wrong sequence fails and preserves lock", () => {
    const puzzle = JSON.parse(JSON.stringify(dummyPuzzle));
    const result = evaluateCombination(puzzle, ["Hawk", "Hawk", "Hawk"]);

    assert.equal(result.solved, false);
    assert.equal(result.targetUnlocked, false);
    assert.equal(puzzle.target.isLocked, true);
  });

  it("evaluates combination puzzle: rejects inputs outside limited set of options", () => {
    const puzzle = JSON.parse(JSON.stringify(dummyPuzzle));
    const result = evaluateCombination(puzzle, ["Wolf", "InvalidSymbol", "Dragon"]);

    assert.equal(result.solved, false);
    assert.ok(result.message.includes("is not a valid option"));
  });

  it("verifies plainly shown clues match the solution sequence", () => {
    assert.equal(dummyPuzzle.clues.length, dummyPuzzle.solution.length);
    dummyPuzzle.clues.forEach((clue, idx) => {
      assert.equal(clue.symbol, dummyPuzzle.solution[idx]);
    });
  });

  it("detects collision with hidden trap: triggers animation and delivers damage", () => {
    const trap = JSON.parse(JSON.stringify(dummyTrap));

    // Player steps directly onto the hidden spot at [0, 0.1, 5]
    const result = invokeTrapCollision(trap, [0, 0.1, 5]);

    assert.equal(result.triggered, true);
    assert.equal(result.damageDealt, 35);
    assert.equal(result.animationPlayed, "spears_thrust_up");
    assert.equal(trap.state, "triggered");
  });

  it("ignores player outside trap trigger bounds", () => {
    const trap = JSON.parse(JSON.stringify(dummyTrap));

    // Player is standing safely at [5, 0.1, 5]
    const result = invokeTrapCollision(trap, [5, 0.1, 5]);

    assert.equal(result.triggered, false);
    assert.equal(result.damageDealt, 0);
    assert.equal(trap.state, "armed");
  });

  it("trap lifecycle: triggered trap enters cooldown and does not double-trigger", () => {
    const trap = JSON.parse(JSON.stringify(dummyTrap));

    invokeTrapCollision(trap, [0, 0.1, 5]);
    assert.equal(trap.state, "triggered");

    // Second step while still triggered
    const secondResult = invokeTrapCollision(trap, [0, 0.1, 5]);
    assert.equal(secondResult.triggered, false);
    assert.equal(secondResult.damageDealt, 0);

    // Reset trap after cooldown
    resetTrap(trap);
    assert.equal(trap.state, "armed");

    // Can trigger again after reset
    const thirdResult = invokeTrapCollision(trap, [0, 0.1, 5]);
    assert.equal(thirdResult.triggered, true);
  });

  it("disarming a trap disables trigger events", () => {
    const trap = JSON.parse(JSON.stringify(dummyTrap));

    disarmTrap(trap);
    assert.equal(trap.state, "disarmed");

    const result = invokeTrapCollision(trap, [0, 0.1, 5]);
    assert.equal(result.triggered, false);
    assert.equal(result.damageDealt, 0);
  });

  it("synthesizer outputs structured combination puzzles and collision traps", () => {
    // Minimal assembly with floor, wall, door, trap, puzzle, prop parts
    const dummyAssembly: ExampleAssembly = {
      id: "demo",
      family: "dungeon",
      source: "demo.unity",
      license: "proprietary",
      parts: [
        { partId: "SM_Env_Tiles_01", assetRef: "a", transform: { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { partId: "SM_Env_Wall_Solid_01", assetRef: "b", transform: { pos: [0, 2, 2.5], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { partId: "SM_Env_Door_Bars_01", assetRef: "c", transform: { pos: [0, 2, 5], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { partId: "SM_Env_Rune_Pillar_01", assetRef: "d", transform: { pos: [2, 1.5, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { partId: "SM_Prop_Trap_Spears_Grate_01", assetRef: "e", transform: { pos: [-2, 0.05, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { partId: "SM_Prop_Chest_01", assetRef: "f", transform: { pos: [0, 0.5, 4], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { partId: "SM_Prop_Wall_Banner_02", assetRef: "g", transform: { pos: [-2.5, 2, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
      ],
    };

    const ruleSet = extractLearnedRuleSet([dummyAssembly]);
    const output = synthesizeAssembly({
      ruleSet,
      seed: 42,
      site: {
        bounds: { min: [-15, 0, -15], max: [15, 10, 15] },
      },
      blueprint: { archetype: "crypt-hall" },
      budget: { maxParts: 120 },
    });

    assert.ok(output.puzzles && output.puzzles.length > 0, "must generate combination puzzle");
    assert.ok(output.traps && output.traps.length > 0, "must generate collision traps");

    const puzzle = output.puzzles[0];
    assert.equal(puzzle.entrypoint.inputs.length, 3);
    assert.equal(puzzle.solution.length, 3);
    assert.equal(puzzle.clues.length, 3);
    assert.equal(puzzle.target.isLocked, true);
    assert.ok(puzzle.possibleCombinationsCount > 0);

    const trap = output.traps[0];
    assert.equal(trap.state, "armed");
    assert.equal(trap.triggerVolume.hidden, true);
    assert.ok(trap.onCollision.damage > 0);

    // Universal Measurement System verification
    assert.ok(output.measurement, "must generate measurement report");
    assert.equal(output.measurement.humanScaleBaseline.referenceHeightM, 1.8);
    assert.equal(output.measurement.humanScaleBaseline.eyeLevelM, 1.62);
    assert.ok(output.measurement.spatialPerception.tier, "spatial tier must be computed");
    assert.ok(output.measurement.scaleTierCounts.handheld >= 0);
    assert.ok(output.measurement.scaleTierCounts.human > 0);
    assert.ok(output.measurement.interactivitySummary.interactableCount > 0);

    // Verify structural invariants: walls and floors preserve unit scale 1.0
    const structuralPlacements = output.placements.filter(p =>
      p.partId.includes("Wall") || p.partId.includes("Tiles")
    );
    for (const p of structuralPlacements) {
      assert.deepEqual(p.transform.scale, [1, 1, 1], `Structural part ${p.partId} must maintain exact 1.0 scale`);
    }

    // Verify organic clutter or props have controlled size variance applied
    const rubblePlacements = output.placements.filter(p => p.partId.includes("Rubble"));
    if (rubblePlacements.length > 0) {
      const hasVariedScale = rubblePlacements.some(p => p.transform.scale[0] !== 1.0);
      assert.ok(hasVariedScale, "Rubble placements should feature size variance");
    }

    // In single-level crypt-hall: no freestanding pillars or disconnected stairs
    const freestandingPillarsOrStairs = output.placements.filter(
      p => p.category === "pillar" || p.category === "stairs"
    );
    assert.equal(freestandingPillarsOrStairs.length, 0, "Single-level room must not contain freestanding pillars or disconnected stairs");
  });

  it("isConnectingTwoFloors enforces floor connectivity for stairs and pillars", () => {
    // 1. Single floor level: stairs and pillars must be rejected
    const singleFloorRoom = [
      { partId: "floor_1", assetRef: "a", category: "floor", transform: { pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } },
      { partId: "floor_2", assetRef: "a", category: "floor", transform: { pos: [0, 0, 5] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } },
    ];

    const freestandingPillar = {
      partId: "pillar_1",
      assetRef: "p",
      category: "pillar",
      transform: { pos: [0, 1.75, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    };
    assert.equal(isConnectingTwoFloors(freestandingPillar, singleFloorRoom), false, "Pillar on single floor must be rejected");

    const disconnectedStairs = {
      partId: "stairs_1",
      assetRef: "s",
      category: "stairs",
      transform: { pos: [0, 1.75, 2.5] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    };
    assert.equal(isConnectingTwoFloors(disconnectedStairs, singleFloorRoom), false, "Stairs on single floor must be rejected");

    // 2. Two floor levels: ground (y=0) and upper loft (y=3.5)
    const twoFloorRoom = [
      ...singleFloorRoom,
      { partId: "loft_floor_1", assetRef: "a", category: "floor", transform: { pos: [0, 3.5, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } },
    ];

    // Pillar supporting loft deck from ground floor
    const connectedPillar = {
      partId: "pillar_supported",
      assetRef: "p",
      category: "pillar",
      transform: { pos: [0, 1.75, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    };
    assert.equal(isConnectingTwoFloors(connectedPillar, twoFloorRoom), true, "Pillar connecting ground to upper loft must be accepted");

    // Stairs connecting ground (z=5) to upper loft (z=0)
    const connectedStairs = {
      partId: "stairs_connected",
      assetRef: "s",
      category: "stairs",
      transform: { pos: [0, 1.75, 2.5] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    };
    assert.equal(isConnectingTwoFloors(connectedStairs, twoFloorRoom), true, "Stairs connecting ground floor to loft must be accepted");

    // 3. Pillar holding up an overhead roof/ceiling arch
    const roomWithCeiling = [
      ...singleFloorRoom,
      { partId: "ceiling_arch_1", assetRef: "c", category: "ceiling", transform: { pos: [0, 3.5, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } },
    ];
    assert.equal(
      isConnectingTwoFloors(freestandingPillar, roomWithCeiling),
      true,
      "Pillar supporting overhead ceiling/roof arch must be accepted"
    );
  });
});
