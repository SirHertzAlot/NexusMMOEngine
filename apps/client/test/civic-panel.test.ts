/**
 * Client UI state & provenance tests for CivicPanel (`nextCivicState`).
 */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_CIVIC_UI_STATE, nextCivicState } from "../src/ui/civic-panel.js";

describe("CivicPanel state reducer", () => {
  it("tracks state snapshots, survey bearings, foundry updates, contracts, and notices purely", () => {
    let s = INITIAL_CIVIC_UI_STATE;

    s = nextCivicState(s, {
      kind: "civic",
      op: "state",
      tick: 120,
      sites: [
        {
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
          progress: { wood: 10 },
          goldProgress: 0,
          nextRequirements: { wood: 40, iron: 25 },
          nextGoldCost: 75,
          repairRequirements: {},
          repairGoldCost: 0,
          heavyHaulAllowed: false,
          totalContributors: 3,
        },
      ],
      veins: [],
      foundries: [],
      contracts: [],
      pendingCreditsClaimed: 150,
    });
    assert.equal(s.sites.length, 1);
    assert.equal(s.pendingCreditsClaimed, 150);

    s = nextCivicState(s, {
      kind: "civic",
      op: "survey_result",
      band: "warm",
      direction: "NE",
      distanceBucketM: 70,
    });
    assert.equal(s.lastSurvey?.direction, "NE");
    assert.equal(s.lastSurvey?.distanceBucketM, 70);

    s = nextCivicState(s, {
      kind: "civic",
      op: "contributed",
      siteId: "redwater-bridge",
      opId: "c1",
      acceptedMaterials: { wood: 30, iron: 25 },
      acceptedGold: 75,
      stage: 2,
      damaged: false,
      wear: 0,
      stageAdvanced: true,
      repaired: false,
      eraTag: "Restored Cart Span",
      replayed: false,
    });
    assert.equal(s.sites[0]!.stage, 2);
    assert.equal(s.lastNotice?.code, "stage_advanced");

    s = nextCivicState(s, {
      kind: "civic",
      op: "contract_update",
      opId: "cp1",
      action: "posted",
      contract: {
        contractId: "1",
        posterId: 1,
        posterName: "Alice",
        targetKind: "site",
        targetId: "redwater-bridge",
        material: "iron",
        totalQty: 20,
        deliveredQty: 0,
        rewardPerUnit: 15,
        status: "open",
        createdAt: 1000,
        expiresAt: 2000,
      },
      replayed: false,
    });
    assert.equal(s.contracts.length, 1);
    assert.equal(s.lastNotice?.code, "contract_posted");
  });
});
