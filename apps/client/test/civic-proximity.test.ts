/**
 * Unit tests for civic landmark proximity prompts (`nearestCivicTarget`),
 * world-target priority yielding (`hasCloserWorldTarget`), and HUD layout
 * placement (`hud.json` + `DEFAULT_LAYOUT`).
 */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CivicFoundryView, CivicSiteView, CivicVeinView } from "@mmo-engine/protocol";
import { t } from "../src/i18n.js";
import { INITIAL_CIVIC_UI_STATE, type CivicUiState } from "../src/ui/civic-panel.js";
import {
  civicTargetDisplayName,
  hasCloserWorldTarget,
  nearestCivicTarget,
} from "../src/ui/civic-proximity.js";
import { DEFAULT_LAYOUT, loadHudLayout } from "../src/ui/hud-layout.js";

function makeSite(patch: Partial<CivicSiteView> = {}): CivicSiteView {
  return {
    siteId: "redwater-bridge",
    name: "Redwater Gorge Bridge",
    kind: "bridge",
    x: 42,
    z: -18,
    stage: 1,
    maxStage: 2,
    damaged: false,
    wear: 20,
    wearMax: 1000,
    eraTag: "Timber Foot-Scaffold",
    progress: {},
    goldProgress: 0,
    nextRequirements: { wood: 40, iron: 25 },
    nextGoldCost: 75,
    repairRequirements: {},
    repairGoldCost: 0,
    heavyHaulAllowed: false,
    totalContributors: 1,
    ...patch,
  };
}

function makeFoundry(patch: Partial<CivicFoundryView> = {}): CivicFoundryView {
  return {
    townId: "oakhaven",
    name: "Oakhaven Hearth",
    x: -24,
    z: 6,
    activeTraitId: "bog-standard",
    traitName: "Standard Iron",
    activeVeinBatchId: null,
    batchesRemaining: 0,
    expiresAt: null,
    oreBuffer: {},
    activationThreshold: 25,
    depletedPermille: 0,
    mature: false,
    craftBonusSummary: "Standard",
    ...patch,
  };
}

function makeVein(patch: Partial<CivicVeinView> = {}): CivicVeinView {
  return {
    veinBatchId: "east-gorge-vein-1",
    templateId: "east-gorge-vein",
    traitId: "high-carbon",
    traitName: "High-Carbon Ore",
    material: "iron",
    x: 78,
    z: -26,
    stock: 40,
    maxStock: 80,
    discoveredAt: 1_700_000_000_000,
    ...patch,
  };
}

function stateWith(patch: Partial<CivicUiState>): CivicUiState {
  return { ...INITIAL_CIVIC_UI_STATE, ...patch };
}

describe("nearestCivicTarget", () => {
  it("returns null on empty state, nullish state, or non-finite player coordinates", () => {
    assert.equal(nearestCivicTarget(0, 0, INITIAL_CIVIC_UI_STATE), null);
    assert.equal(nearestCivicTarget(0, 0, null), null);
    const s = stateWith({ sites: [makeSite({ x: 0, z: 0 })] });
    assert.equal(nearestCivicTarget(Number.NaN, 0, s), null);
    assert.equal(nearestCivicTarget(0, Number.POSITIVE_INFINITY, s), null);
    assert.equal(nearestCivicTarget(Number.NEGATIVE_INFINITY, 0, s), null);
  });

  it("skips landmarks with non-finite coordinates", () => {
    const s = stateWith({
      sites: [makeSite({ siteId: "bad-site", x: Number.NaN, z: 0 })],
      foundries: [makeFoundry({ townId: "bad-foundry", x: 0, z: Number.POSITIVE_INFINITY })],
      veins: [
        makeVein({ veinBatchId: "bad-vein", x: Number.NaN, z: 0 }),
        makeVein({ veinBatchId: "good-vein", x: 5, z: 0 }),
      ],
    });
    const res = nearestCivicTarget(0, 0, s);
    assert.equal(res?.kind, "vein");
    assert.equal(res?.id, "good-vein");
    assert.equal(res?.distanceM, 5);
  });

  it("enforces exact radius bounds (site <= 8m, foundry <= 14m, vein <= 16m)", () => {
    const siteState = stateWith({ sites: [makeSite({ x: 8, z: 0 })] });
    assert.equal(nearestCivicTarget(0, 0, siteState)?.kind, "site");
    assert.equal(nearestCivicTarget(-0.01, 0, siteState), null);

    const foundryState = stateWith({ foundries: [makeFoundry({ x: 0, z: 14 })] });
    assert.equal(nearestCivicTarget(0, 0, foundryState)?.kind, "foundry");
    assert.equal(nearestCivicTarget(0, -0.01, foundryState), null);

    const veinState = stateWith({ veins: [makeVein({ x: 16, z: 0 })] });
    assert.equal(nearestCivicTarget(0, 0, veinState)?.kind, "vein");
    assert.equal(nearestCivicTarget(-0.01, 0, veinState), null);
  });

  it("ignores depleted or undiscovered veins", () => {
    const s = stateWith({
      veins: [
        makeVein({ veinBatchId: "depleted", x: 1, z: 0, stock: 0 }),
        makeVein({ veinBatchId: "undiscovered", x: 2, z: 0, stock: 10, discoveredAt: 0 }),
      ],
    });
    assert.equal(nearestCivicTarget(0, 0, s), null);
  });

  it("suggests repair vs contribute vs inspect for civic sites and resolves i18n keys", () => {
    const damaged = stateWith({
      sites: [makeSite({ x: 2, z: 0, damaged: true, stage: 1, maxStage: 2 })],
    });
    const dmgTarget = nearestCivicTarget(0, 0, damaged);
    assert.equal(dmgTarget?.actionLabelKey, "civic.promptRepair");
    assert.equal(dmgTarget?.labelKey, "civic.landmarkSite");
    assert.notEqual(t(dmgTarget!.actionLabelKey), dmgTarget!.actionLabelKey);
    assert.notEqual(t(dmgTarget!.labelKey), dmgTarget!.labelKey);

    const incomplete = stateWith({
      sites: [makeSite({ x: 2, z: 0, damaged: false, stage: 1, maxStage: 2 })],
    });
    const contribTarget = nearestCivicTarget(0, 0, incomplete);
    assert.equal(contribTarget?.actionLabelKey, "civic.promptContribute");
    assert.notEqual(t(contribTarget!.actionLabelKey), contribTarget!.actionLabelKey);

    const complete = stateWith({
      sites: [makeSite({ x: 2, z: 0, damaged: false, stage: 2, maxStage: 2 })],
    });
    const inspectTarget = nearestCivicTarget(0, 0, complete);
    assert.equal(inspectTarget?.actionLabelKey, "civic.promptInspect");
    assert.notEqual(t(inspectTarget!.actionLabelKey), inspectTarget!.actionLabelKey);
  });

  it("picks the closest landmark across all categories and breaks exact ties deterministically", () => {
    const s = stateWith({
      sites: [makeSite({ siteId: "s-far", x: 7, z: 0 })],
      foundries: [makeFoundry({ townId: "f-mid", x: 5, z: 0 })],
      veins: [makeVein({ veinBatchId: "v-near", x: 3, z: 0 })],
    });
    const nearest = nearestCivicTarget(0, 0, s);
    assert.equal(nearest?.kind, "vein");
    assert.equal(nearest?.id, "v-near");
    assert.equal(nearest?.distanceM, 3);

    // Exact distance tie between site and foundry -> deterministic site priority
    const tied = stateWith({
      sites: [makeSite({ siteId: "s-5", x: 5, z: 0 })],
      foundries: [makeFoundry({ townId: "f-5", x: 0, z: 5 })],
      veins: [makeVein({ veinBatchId: "v-5", x: -5, z: 0 })],
    });
    const tieWinner = nearestCivicTarget(0, 0, tied);
    assert.equal(tieWinner?.kind, "site");
    assert.equal(tieWinner?.id, "s-5");
    assert.equal(tieWinner?.distanceM, 5);
  });

  it("formats display names for sites, foundries, and veins", () => {
    const s = stateWith({
      sites: [makeSite({ siteId: "redwater-bridge", name: "Redwater Gorge Bridge" })],
      foundries: [makeFoundry({ townId: "oakhaven", name: "Oakhaven Hearth" })],
      veins: [makeVein({ veinBatchId: "v1", traitName: "Deep-Vein Ferrite", material: "iron" })],
    });
    assert.equal(
      civicTargetDisplayName({ kind: "site", id: "redwater-bridge", labelKey: "k", actionLabelKey: "a", distanceM: 1 }, s),
      "Redwater Gorge Bridge",
    );
    assert.equal(
      civicTargetDisplayName({ kind: "foundry", id: "oakhaven", labelKey: "k", actionLabelKey: "a", distanceM: 1 }, s),
      "Oakhaven Hearth",
    );
    assert.equal(
      civicTargetDisplayName({ kind: "vein", id: "v1", labelKey: "k", actionLabelKey: "a", distanceM: 1 }, s),
      "Deep-Vein Ferrite (iron)",
    );
  });
});

describe("hasCloserWorldTarget", () => {
  it("yields to closer or equidistant standard world targets without stealing priority", () => {
    assert.equal(hasCloserWorldTarget(0, 0, 5, []), false);
    assert.equal(hasCloserWorldTarget(0, 0, 5, [{ x: 2, z: 0 }]), true);
    assert.equal(hasCloserWorldTarget(0, 0, 5, [{ x: 5, z: 0 }]), true);
    assert.equal(hasCloserWorldTarget(0, 0, 5, [{ x: 6, z: 0 }]), false);
    assert.equal(hasCloserWorldTarget(Number.NaN, 0, 5, [{ x: 10, z: 0 }]), true);
  });
});

describe("civic-panel HUD placement", () => {
  it("places civic-panel in DEFAULT_LAYOUT and content/ui/hud.json without overlapping bag-panel", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../../../../content/ui/hud.json", import.meta.url), "utf8"),
    ) as unknown;
    const hudJson = loadHudLayout(raw);

    const defCivic = DEFAULT_LAYOUT.widgets["civic-panel"];
    const defBag = DEFAULT_LAYOUT.widgets["bag-panel"];
    assert.ok(defCivic, "DEFAULT_LAYOUT includes civic-panel");
    assert.ok(defBag, "DEFAULT_LAYOUT includes bag-panel");
    assert.equal(defCivic.visible, true);
    assert.notEqual(defCivic.anchor, defBag.anchor);

    const jsonCivic = hudJson.widgets["civic-panel"];
    const jsonBag = hudJson.widgets["bag-panel"];
    assert.ok(jsonCivic, "content/ui/hud.json includes civic-panel");
    assert.ok(jsonBag, "content/ui/hud.json includes bag-panel");
    assert.equal(jsonCivic.visible, true);
    assert.notEqual(jsonCivic.anchor, jsonBag.anchor);
    assert.deepEqual(jsonCivic, defCivic);
  });
});
