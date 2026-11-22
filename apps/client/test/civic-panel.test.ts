/**
 * Client UI state, provenance, foundry maturation/reforge/repair-kit reducer,
 * and compass survey flare VFX tests (`nextCivicState`, `directionVector`, `VfxAdapter`).
 */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CivicFoundryView, SurveyDirection } from "@mmo-engine/protocol";
import { INITIAL_CIVIC_UI_STATE, nextCivicState } from "../src/ui/civic-panel.js";
import { directionVector, VfxAdapter } from "../src/render/vfx/VFXAdapter.js";

function makeFoundry(patch: Partial<CivicFoundryView> = {}): CivicFoundryView {
  return {
    townId: "millhaven",
    name: "Millhaven Foundry",
    x: 58,
    z: -10,
    activeTraitId: "high-carbon",
    traitName: "High-Carbon Ore",
    activeVeinBatchId: "east-gorge-vein-1",
    batchesRemaining: 12,
    expiresAt: 9_999_999,
    oreBuffer: { iron: 10 },
    activationThreshold: 40,
    depletedPermille: 550,
    mature: true,
    reforgeGoldCost: 25,
    repairKitCost: { iron: 2, wood: 2 },
    craftBonusSummary: "+15% Power, +10% Durability",
    ...patch,
  };
}

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
      foundries: [makeFoundry({ mature: false, depletedPermille: 120 })],
      contracts: [],
      pendingCreditsClaimed: 150,
    });
    assert.equal(s.sites.length, 1);
    assert.equal(s.foundries.length, 1);
    assert.equal(s.foundries[0]!.mature, false);
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

  it("handles foundry_reforge, craft_repair_kit, and escortBonusGold updates cleanly", () => {
    let s = nextCivicState(INITIAL_CIVIC_UI_STATE, {
      kind: "civic",
      op: "state",
      tick: 300,
      sites: [],
      veins: [],
      foundries: [makeFoundry({ mature: true, depletedPermille: 520, batchesRemaining: 10 })],
      contracts: [],
      pendingCreditsClaimed: 0,
    });

    s = nextCivicState(s, {
      kind: "civic",
      op: "foundry_reforge",
      opId: "rf-1",
      townId: "millhaven",
      itemId: 42,
      provenance: {
        provenanceId: 9,
        veinBatchId: "east-gorge-vein-1",
        traitId: "masterwork",
        townId: "millhaven",
        crafterId: 1,
        crafterName: "Alice",
        eraTag: "Restored Cart Span",
        craftedAt: 5000,
      },
      goldCost: 25,
      foundry: makeFoundry({ mature: true, depletedPermille: 545, batchesRemaining: 9 }),
      replayed: false,
    });
    assert.equal(s.foundries[0]!.batchesRemaining, 9);
    assert.equal(s.foundries[0]!.depletedPermille, 545);
    assert.equal(s.lastNotice?.code, "foundry_reforge");
    assert.ok(s.lastNotice?.message.includes("42"));
    assert.ok(s.lastNotice?.message.includes("masterwork"));

    s = nextCivicState(s, {
      kind: "civic",
      op: "craft_repair_kit",
      opId: "rk-1",
      townId: "millhaven",
      qty: 1,
      consumedMaterials: { iron: 2, wood: 2 },
      foundry: makeFoundry({ mature: true, depletedPermille: 550, batchesRemaining: 9 }),
      replayed: false,
    });
    assert.equal(s.foundries[0]!.depletedPermille, 550);
    assert.equal(s.lastNotice?.code, "craft_repair_kit");
    assert.ok(s.lastNotice?.message.includes("+1"));

    s = nextCivicState(s, {
      kind: "civic",
      op: "foundry_updated",
      opId: "fu-1",
      foundry: makeFoundry({ mature: true, depletedPermille: 560 }),
      specialized: false,
      escortBonusGold: 12,
      replayed: false,
    });
    assert.equal(s.foundries[0]!.depletedPermille, 560);
    assert.equal(s.lastNotice?.code, "escort_bonus");
    assert.ok(s.lastNotice?.message.includes("+12g"));
  });
});

describe("Survey flare VFX (directionVector & VfxAdapter.emitSurveyFlare)", () => {
  it("maps all 8 compass octants and 'here' matching world convention", () => {
    assert.deepEqual(directionVector("N"), { x: 0, z: -1 });
    assert.deepEqual(directionVector("E"), { x: 1, z: 0 });
    assert.deepEqual(directionVector("S"), { x: 0, z: 1 });
    assert.deepEqual(directionVector("W"), { x: -1, z: 0 });
    assert.deepEqual(directionVector("here"), { x: 0, z: 0 });

    const diagonals: Array<[SurveyDirection, number, number]> = [
      ["NE", 1, -1],
      ["SE", 1, 1],
      ["SW", -1, 1],
      ["NW", -1, -1],
    ];
    for (const [dir, sx, sz] of diagonals) {
      const v = directionVector(dir);
      assert.ok(Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-6, `${dir} normalized`);
      assert.equal(Math.sign(v.x), sx, `${dir} x sign`);
      assert.equal(Math.sign(v.z), sz, `${dir} z sign`);
    }
  });

  it("spawns scaled directional sparks/bursts by band, cleans up flares, and is safe no-op when disposed", () => {
    const signals: Array<{
      id: string;
      effect?: unknown;
      radius: number;
      x: number;
      z: number;
      obj: { position: { x: number; y: number; z: number }; matrixWorld: { elements: ArrayLike<number> } };
      disposed: boolean;
    }> = [];
    const bursts: Array<{ x: number; y: number; z: number; color: number }> = [];
    let subsystemDisposes = 0;

    const adapter = new VfxAdapter({
      client: {} as never,
      terrain: {} as never,
      particleFx: {
        update: () => {},
        dispose: () => {
          subsystemDisposes++;
        },
      } as never,
      quarksFx: {
        attachSignal: (
          sig: { id: string; params: Record<string, unknown> },
          obj: { position: { x: number; y: number; z: number }; matrixWorld: { elements: ArrayLike<number> } },
        ) => {
          const rec = {
            id: sig.id,
            effect: sig.params.effect,
            radius: Number(sig.params.radius ?? 0),
            x: obj.position.x,
            z: obj.position.z,
            obj,
            disposed: false,
          };
          signals.push(rec);
          return {
            system: {} as never,
            dispose: () => {
              rec.disposed = true;
            },
          };
        },
        update: () => {},
        dispose: () => {
          subsystemDisposes++;
        },
      } as never,
      entityFx: {
        spawnBurst: (p: { x: number; y: number; z: number }, color: number) => {
          bursts.push({ x: p.x, y: p.y, z: p.z, color });
        },
        update: () => {},
        dispose: () => {
          subsystemDisposes++;
        },
      } as never,
      qualityTier: "medium",
    });
    adapter.initialize();

    // "none" and non-finite origin are safe no-ops
    adapter.emitSurveyFlare({ x: 10, y: 2, z: 20 }, "N", "none");
    adapter.emitSurveyFlare({ x: Number.NaN, y: 0, z: 0 }, "N", "warm");
    assert.equal(signals.length, 0);
    assert.equal(bursts.length, 0);

    // Faint vs warm vs hot vs pinpoint scale radius and offset toward octant
    adapter.emitSurveyFlare({ x: 10, y: 1, z: 20 }, "E", "faint");
    adapter.emitSurveyFlare({ x: 10, y: 1, z: 20 }, "E", "warm");
    adapter.emitSurveyFlare({ x: 10, y: 1, z: 20 }, "N", "hot");
    adapter.emitSurveyFlare({ x: 10, y: 1, z: 20 }, "here", "pinpoint");

    assert.equal(bursts.length, 4);
    assert.ok(bursts[0]!.x > 10 && bursts[0]!.z === 20, "faint E offsets +X");
    assert.ok(bursts[1]!.x > bursts[0]!.x, "warm E offsets further than faint E");
    assert.ok(bursts[2]!.z < 20 && bursts[2]!.x === 10, "hot N offsets -Z");
    assert.equal(bursts[3]!.x, 10);
    assert.equal(bursts[3]!.z, 20);

    const faintSpark = signals.find((s) => s.id === "survey_flare" && s.x === bursts[0]!.x);
    const warmSpark = signals.find((s) => s.id === "survey_flare" && s.x === bursts[1]!.x);
    const hotSpark = signals.find((s) => s.id === "survey_flare" && s.z === bursts[2]!.z);
    const pinpointSpark = signals.find((s) => s.id === "survey_flare" && s.x === 10 && s.z === 20);
    assert.ok(faintSpark && warmSpark && hotSpark && pinpointSpark);
    assert.ok(faintSpark.radius < warmSpark.radius && warmSpark.radius < hotSpark.radius && hotSpark.radius < pinpointSpark.radius);
    assert.ok(signals.some((s) => s.id === "survey_flare_aura"), "hot/pinpoint attach aura");

    // Verify matrixWorld translation matches offset flare coordinates on the orphaned Object3D
    assert.equal(faintSpark.obj.matrixWorld.elements[12], bursts[0]!.x);
    assert.ok(Math.abs(faintSpark.obj.matrixWorld.elements[13]! - 1.6) < 1e-6);
    assert.equal(faintSpark.obj.matrixWorld.elements[14], bursts[0]!.z);
    assert.equal(hotSpark.obj.matrixWorld.elements[12], bursts[2]!.x);
    assert.equal(hotSpark.obj.matrixWorld.elements[14], bursts[2]!.z);

    // Advance clock past TTL -> expired flares dispose cleanly
    adapter.update(2.0);
    assert.ok(signals.every((s) => s.disposed), "expired flare handles disposed");

    // Dispose -> subsequent calls are safe no-ops
    const countBeforeDispose = bursts.length;
    adapter.dispose();
    assert.equal(subsystemDisposes, 3);
    adapter.emitSurveyFlare({ x: 0, y: 0, z: 0 }, "S", "pinpoint");
    assert.equal(bursts.length, countBeforeDispose);
    // Double dispose is idempotent
    adapter.dispose();
    assert.equal(subsystemDisposes, 3);
  });
});
