/**
 * TDD: CombatHud — reticle visibility, stance technique resolution, aimed
 * body part priority (locked > reticle raycast > lookPitch), melee reach
 * detection, combo chain window indicator, and hitmarker flash.
 */
import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Move, type ItemView } from "@mmo-engine/protocol";
import { deriveCombatHudModel, pitchToAimPart, type CombatReticleTelemetry } from "../src/ui/combat-hud.js";

const BASE_TELEMETRY: CombatReticleTelemetry = {
  hoveredEntity: null,
  hoveredPart: null,
  hoveredDistance: Infinity,
  pitchAimPart: "torso",
  activeMove: Move.None,
  moveElapsed: 0,
  pointerLocked: false,
};

const SWORD_ITEM: ItemView = {
  id: 1,
  def: "iron-sword",
  name: "Iron Sword",
  base: "sword",
  rank: "common",
  color: "#cfd6df",
  hand: "main",
  stats: { power: 5 },
  durability: 100,
  model: "dungeon-pack/SM_Wep_Straightsword_01",
};

describe("CombatHud view-model", () => {
  it("maps lookPitch to body parts accurately", () => {
    assert.equal(pitchToAimPart(0), "torso");
    assert.equal(pitchToAimPart(-0.35), "head");
    assert.equal(pitchToAimPart(0.45), "legLeft");
    assert.equal(pitchToAimPart(0.24), "armUpperLeft");
  });

  it("prioritizes lockedAim > hoveredPart (reticle) > pitchAimPart", () => {
    const pitchModel = deriveCombatHudModel({
      view: "first",
      technique: null,
      lockedAim: null,
      telemetry: { ...BASE_TELEMETRY, pitchAimPart: "head" },
      mainWeapon: SWORD_ITEM,
    });
    assert.equal(pitchModel.showReticle, true);
    assert.equal(pitchModel.effectiveTechnique, "cut");
    assert.equal(pitchModel.aimMode, "pitch");
    assert.equal(pitchModel.effectiveAimPart, "head");

    const reticleModel = deriveCombatHudModel({
      view: "first",
      technique: "thrust",
      lockedAim: null,
      telemetry: {
        ...BASE_TELEMETRY,
        hoveredEntity: 12n,
        hoveredPart: "legRight",
        hoveredDistance: 1.5,
        pitchAimPart: "torso",
      },
      mainWeapon: SWORD_ITEM,
    });
    assert.equal(reticleModel.effectiveTechnique, "thrust");
    assert.equal(reticleModel.aimMode, "reticle");
    assert.equal(reticleModel.effectiveAimPart, "legRight");
    assert.equal(reticleModel.inMeleeReach, true);

    const lockedModel = deriveCombatHudModel({
      view: "third",
      technique: "bludgeon",
      lockedAim: "armUpperRight",
      telemetry: {
        ...BASE_TELEMETRY,
        hoveredEntity: 12n,
        hoveredPart: "legRight",
        hoveredDistance: 5.0,
        pointerLocked: true,
      },
      mainWeapon: SWORD_ITEM,
    });
    assert.equal(lockedModel.showReticle, true, "shown in third-person when pointerLocked");
    assert.equal(lockedModel.aimMode, "locked");
    assert.equal(lockedModel.effectiveAimPart, "armUpperRight");
    assert.equal(lockedModel.inMeleeReach, false, "5.0m is outside sword reach");
  });

  it("tracks 3-hit combo stages, chain windows, guard state, and hitmarker flashes", () => {
    const chainReady = deriveCombatHudModel({
      view: "first",
      technique: "cut",
      lockedAim: null,
      telemetry: {
        ...BASE_TELEMETRY,
        activeMove: Move.SwordA,
        moveElapsed: 0.25, // inside SwordA chain window [0.15..0.42]
      },
      mainWeapon: SWORD_ITEM,
      lastHit: {
        hit: { kind: "hit", tick: 10, source: "1", target: "2", outcome: "hit", amount: 12, health: 88, max: 100 },
        atMs: 1000,
      },
      nowMs: 1150,
    });
    assert.equal(chainReady.comboStage, 1);
    assert.equal(chainReady.inChainWindow, true);
    assert.equal(chainReady.hitMarker, "hit");

    const expiredHit = deriveCombatHudModel({
      view: "first",
      technique: "cut",
      lockedAim: null,
      telemetry: { ...BASE_TELEMETRY, activeMove: Move.Guard, moveElapsed: 0.5 },
      lastHit: {
        hit: { kind: "hit", tick: 10, source: "1", target: "2", outcome: "blocked", amount: 2, health: 98, max: 100 },
        atMs: 1000,
      },
      nowMs: 1500,
    });
    assert.equal(expiredHit.isGuarding, true);
    assert.equal(expiredHit.hitMarker, null);
  });
});
