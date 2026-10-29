/**
 * Unit tests verifying creature rules, species completeness, loot tables,
 * and animation mapping resolution.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Move } from "@mmo-engine/protocol";
import { MOVE_CLIPS } from "../src/animation.js";

describe("Creature rules & animation mapping", () => {
  // Repo root regardless of cwd (tests compile to dist/test/, so four ups).
  const rootDir = fileURLToPath(new URL("../../../..", import.meta.url));
  const speciesData = JSON.parse(fs.readFileSync(`${rootDir}/content/species/species.json`, "utf8"));
  const creaturesData = JSON.parse(fs.readFileSync(`${rootDir}/content/rules/creatures.json`, "utf8"));
  const lootData = JSON.parse(fs.readFileSync(`${rootDir}/content/rules/loot.json`, "utf8"));
  const modelsData = JSON.parse(fs.readFileSync(`${rootDir}/content/wildlife/flora-fauna-models.json`, "utf8"));

  it("defines every enemy species from species.json in creatures.json", () => {
    const speciesKeys = Object.keys(speciesData);
    assert.ok(speciesKeys.length >= 18);
    for (const key of speciesKeys) {
      assert.ok(creaturesData.creatures[key], `Creature ${key} must exist in creatures.json`);
      const c = creaturesData.creatures[key];
      assert.ok(c.health > 0, `${key} health > 0`);
      assert.ok(c.aggroRadius > 0, `${key} aggroRadius > 0`);
      assert.ok(c.weapons && c.weapons.length > 0, `${key} weapons defined`);
      assert.ok(c.drops && c.drops.table, `${key} drops table defined`);
      assert.ok(lootData.tables[c.drops.table], `Drop table ${c.drops.table} for ${key} must exist in loot.json`);
    }
  });

  it("maps creature natural combat moves to valid animation clips", () => {
    const creatureMoves = [
      Move.Bite,
      Move.Claw,
      Move.Pounce,
      Move.Roar,
      Move.Breath,
      Move.TailWhip,
      Move.Stomp,
      Move.WingBuffet,
      Move.Sting,
      Move.Cleave,
    ];
    for (const move of creatureMoves) {
      const clip = MOVE_CLIPS[move];
      assert.ok(clip !== undefined, `Move ${move} must map to a valid ClipId in MOVE_CLIPS`);
      assert.ok(clip >= 20 && clip <= 29, `Clip ${clip} must be in creature combat clip range (20-29)`);
    }
  });

  it("defines model mappings and rig types for flora and fauna", () => {
    assert.ok(modelsData.rigTypes.quadruped);
    assert.ok(modelsData.rigTypes.avian);
    assert.ok(modelsData.rigTypes.serpentine);
    assert.ok(modelsData.rigTypes.aquatic);
    assert.ok(modelsData.rigTypes.arachnid);
    assert.ok(modelsData.rigTypes.flora);
    assert.ok(modelsData.modelTypePatterns.length >= 6);
  });
});
