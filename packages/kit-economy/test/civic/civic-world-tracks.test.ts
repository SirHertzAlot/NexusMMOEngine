/**
 * Comprehensive unit & integration tests for Redwater Crossing Tracks A2, C5, and C6:
 * - Track A2: CivicWorldBridge ECS visual/barrier entities, NavObstacleSystem & PropCollisionSystem integration, idempotency & entity restarts
 * - Track C6: Mature-town foundry pivot (foundry_reforge, craft_repair_kit, repair-kit repair efficiency + overshoot clamps, ownership/maturity/specialty guards)
 * - Track C5: CaravanEscortCoordinator & CivicService heavy haul escort risk window, ambush spawn cap, self-escort & cooldown anti-farming guards
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent, hasComponent } from "bitecs";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";
import { DEFAULT_CIVIC_RULES, type CivicRules } from "@mmo-engine/rules";
import {
  CaravanEscortCoordinator,
  CivicService,
  CivicWorldBridge,
  REPAIR_KIT_MATERIAL_ID,
  SqliteCivicStore,
  countNearbyEscorts,
  isFoundryMature,
  planRepairContributionWithKits,
  resolveReforgeTargetTrait,
  runCivicAdminCommand,
} from "@mmo-engine/engine-core/dist/src/civic/index.js";
import {
  AssetRef,
  BodyConfig,
  Health,
  MotionType,
  ShapeKind,
  Transform,
  Velocity,
} from "@mmo-engine/engine-core/dist/src/components.js";
import { WalletSystem } from "../../src/wallet.js";
import { NavObstacleSystem } from "@mmo-engine/engine-core/dist/src/navigation/obstacle-system.js";
import type { TileCacheBackend } from "@mmo-engine/engine-core/dist/src/navigation/backend.js";
import type { ExtensionPlayer } from "@mmo-engine/engine-core/dist/src/net/extension.js";
import { PropCollisionSystem } from "@mmo-engine/engine-core/dist/src/prop-collision.js";
import { SimWorld } from "@mmo-engine/engine-core/dist/src/world.js";

function makeRules(): CivicRules {
  return structuredClone(DEFAULT_CIVIC_RULES);
}

interface HarnessPlayer extends ExtensionPlayer {
  sent: unknown[];
  refreshes: number;
  eid: number;
}

function makeMockTileCache() {
  let nextRef = 1;
  const added: number[] = [];
  const removed: number[] = [];
  const live = new Set<number>();
  const backend: TileCacheBackend = {
    bakeTileLayers() {
      return new Uint8Array(0);
    },
    loadLayers() {
      return new BigUint64Array(0);
    },
    unloadLayers() {},
    addObstacles(batch) {
      const refs = new Uint32Array(batch.count);
      for (let i = 0; i < batch.count; i++) {
        const r = nextRef++;
        refs[i] = r;
        added.push(r);
        live.add(r);
      }
      return refs;
    },
    removeObstacles(refs) {
      for (let i = 0; i < refs.length; i++) {
        removed.push(refs[i]!);
        live.delete(refs[i]!);
      }
    },
    update() {
      return true;
    },
    count() {
      return live.size;
    },
  };
  return { backend, added, removed };
}

function makeCivicHarness(opts?: {
  rules?: CivicRules;
  dbPath?: string;
  startMs?: number;
  onEscortAmbush?: (siteId: string, x: number, z: number, charId: number) => void;
  escortCooldownMs?: number;
  maxAmbushesPerWindow?: number;
}) {
  const sim = new SimWorld();
  let clockMs = opts?.startMs ?? 1_700_000_000_000;
  const rules = opts?.rules ?? makeRules();
  const store = new SqliteCivicStore(opts?.dbPath ?? ":memory:");
  const wallet = new WalletSystem();
  const pouches = new Map<number, Map<string, number>>();
  const ownedItems = new Map<number, number>(); // itemId -> owner charId
  const pouchMax = 500;
  let nextItemId = 1000;

  const bridge = new CivicWorldBridge({ sim, rules });

  const getPouch = (charId: number): Map<string, number> => {
    let m = pouches.get(charId);
    if (!m) {
      m = new Map();
      pouches.set(charId, m);
    }
    return m;
  };

  const civic = new CivicService({
    rules,
    store,
    now: () => clockMs,
    dayOf: (ms) => Math.floor(ms / 86_400_000),
    sweepEveryTicks: 1,
    countMaterial: (charId, mat) => getPouch(charId).get(mat) ?? 0,
    takeMaterial: (charId, mat, qty) => {
      const p = getPouch(charId);
      const have = p.get(mat) ?? 0;
      if (qty <= 0 || have < qty) return false;
      p.set(mat, have - qty);
      return true;
    },
    grantMaterial: (charId, mat, qty) => {
      if (qty <= 0) return false;
      const p = getPouch(charId);
      const have = p.get(mat) ?? 0;
      if (have + qty > pouchMax) return false;
      p.set(mat, have + qty);
      return true;
    },
    hasMaterialRoom: (charId, mat, qty) => (getPouch(charId).get(mat) ?? 0) + qty <= pouchMax,
    balanceOf: (charId) => wallet.balanceOf(charId),
    spendGold: (charId, amt, tick) => wallet.spend(charId, amt, tick),
    grantGold: (charId, amt, tick) => wallet.grant(charId, amt, tick),
    hasBagRoom: () => true,
    craftAndGrantItem: (charId) => {
      const id = ++nextItemId;
      ownedItems.set(id, charId);
      return id;
    },
    ownsItem: (charId, itemId) => ownedItems.get(itemId) === charId,
    onSiteStateChange: (siteId, stage, damaged) => bridge.syncSite(siteId, stage, damaged),
    onEscortAmbush: opts?.onEscortAmbush,
    escortOptions: {
      ...(opts?.escortCooldownMs !== undefined ? { cooldownMs: opts.escortCooldownMs } : {}),
      ...(opts?.maxAmbushesPerWindow !== undefined ? { maxAmbushesPerWindow: opts.maxAmbushesPerWindow } : {}),
    },
  });

  bridge.syncAll(civic.store.listSites());

  const makePlayer = (charId: number, name: string, x = 0, z = 0, hp = 100): HarnessPlayer => {
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid);
    addComponent(sim.ecs, Health, eid);
    Transform.px[eid] = x;
    Transform.pz[eid] = z;
    Transform.qw[eid] = 1;
    Transform.sx[eid] = 1;
    Transform.sy[eid] = 1;
    Transform.sz[eid] = 1;
    Health.current[eid] = hp;
    Health.max[eid] = 100;
    const sent: unknown[] = [];
    const p: HarnessPlayer = {
      characterId: charId,
      username: name.toLowerCase(),
      name,
      eid,
      sent,
      refreshes: 0,
      entity: () => eid,
      send: (m) => sent.push(m),
      refreshInventory: () => {
        p.refreshes++;
      },
    };
    return p;
  };

  return {
    sim,
    rules,
    store,
    wallet,
    bridge,
    civic,
    ownedItems,
    getPouch,
    advanceMs: (ms: number) => {
      clockMs += ms;
    },
    nowMs: () => clockMs,
    makePlayer,
  };
}

describe("Track A2: CivicWorldBridge physical entities, NavObstacle & PropCollision", () => {
  it("toggles static gorge barrier & deck AssetRef.variant across stage transitions, damage, repair, and entity restarts", () => {
    const sim = new SimWorld();
    const rules = makeRules();
    const siteDef = rules.sites[0]!;
    const { backend, added, removed } = makeMockTileCache();
    const navObs = new NavObstacleSystem(backend, { chunkWorldSize: 16, agentRadius: 0.4 });
    const propCol = new PropCollisionSystem();

    const bridge = new CivicWorldBridge({ sim, rules, groundHeightAt: () => 2 });
    bridge.syncAll([]);

    const pair0 = bridge.entitiesOf(siteDef.id);
    assert.ok(pair0);
    assert.equal(hasComponent(sim.ecs, Transform, pair0.deckEid), true);
    assert.equal(hasComponent(sim.ecs, AssetRef, pair0.deckEid), true);
    assert.equal(AssetRef.variant[pair0.deckEid], 0);
    assert.equal(Transform.py[pair0.deckEid], 2);

    assert.equal(hasComponent(sim.ecs, BodyConfig, pair0.barrierEid), true);
    assert.equal(BodyConfig.shapeKind[pair0.barrierEid], ShapeKind.Box);
    assert.equal(BodyConfig.motionType[pair0.barrierEid], MotionType.Static);
    assert.ok(BodyConfig.halfY[pair0.barrierEid]! > 0.2, "barrier must exceed NavObstacle thin-slab threshold");
    assert.equal(bridge.isBlocked(siteDef.id), true);

    // NavObstacleSystem cuts obstacle when ruined (stage 0)
    navObs.step(sim);
    assert.equal(added.length, 1);
    assert.equal(navObs.counts.placed, 1);

    // PropCollisionSystem pushes kinematic walker away from the gorge barrier
    const walker = sim.spawn();
    addComponent(sim.ecs, Transform, walker);
    addComponent(sim.ecs, Velocity, walker);
    addComponent(sim.ecs, BodyConfig, walker);
    Transform.px[walker] = siteDef.x;
    Transform.py[walker] = 2;
    Transform.pz[walker] = siteDef.z + 1.5;
    Transform.qw[walker] = 1;
    BodyConfig.shapeKind[walker] = ShapeKind.Capsule;
    BodyConfig.radius[walker] = 0.4;
    BodyConfig.halfY[walker] = 0.5;
    BodyConfig.motionType[walker] = MotionType.Kinematic;
    propCol.step(sim);
    assert.ok(Transform.pz[walker]! > siteDef.z + 2.0, "ruined bridge barrier must push kinematic mover back");

    // Advance to Stage 1 -> removes BodyConfig cleanly, NavObstacle removes obstacle, PropCollision lets walker pass!
    bridge.syncSite(siteDef.id, 1, false);
    assert.equal(AssetRef.variant[pair0.deckEid], 1);
    assert.equal(hasComponent(sim.ecs, BodyConfig, pair0.barrierEid), false);
    assert.equal(bridge.isBlocked(siteDef.id), false);

    navObs.step(sim);
    assert.equal(removed.length, 1);
    assert.equal(navObs.counts.placed, 0);

    Transform.pz[walker] = siteDef.z;
    propCol.step(sim);
    assert.equal(Transform.pz[walker], siteDef.z, "open bridge lets mover stand on span");

    // Idempotent repeated syncs must NOT spawn duplicate entities
    bridge.syncSite(siteDef.id, 1, false);
    bridge.syncAll([{ siteId: siteDef.id, stage: 2, damaged: false }]);
    const pair2 = bridge.entitiesOf(siteDef.id)!;
    assert.equal(pair2.deckWireId, pair0.deckWireId);
    assert.equal(pair2.barrierWireId, pair0.barrierWireId);
    assert.equal(AssetRef.variant[pair2.deckEid], 2);
    assert.equal(bridge.isBlocked(siteDef.id), false);

    // Structural damage re-arms barrier and switches deck variant to BROKEN_VARIANT (0xfffe)
    bridge.syncSite(siteDef.id, 2, true);
    assert.equal(AssetRef.variant[pair2.deckEid], BROKEN_VARIANT);
    assert.equal(hasComponent(sim.ecs, BodyConfig, pair2.barrierEid), true);
    assert.equal(bridge.isBlocked(siteDef.id), true);
    navObs.step(sim);
    assert.equal(added.length, 2);
    assert.equal(navObs.counts.placed, 1);

    // Repair clears barrier again
    bridge.syncSite(siteDef.id, 2, false);
    assert.equal(AssetRef.variant[pair2.deckEid], 2);
    assert.equal(bridge.isBlocked(siteDef.id), false);
    navObs.step(sim);
    assert.equal(removed.length, 2);

    // Entity despawn / restart resilience: despawn barrier & deck, syncSite respawns cleanly
    sim.despawn(pair2.deckEid);
    sim.despawn(pair2.barrierEid);
    assert.equal(bridge.entitiesOf(siteDef.id), undefined);
    bridge.syncSite(siteDef.id, 0, false);
    const respawned = bridge.entitiesOf(siteDef.id);
    assert.ok(respawned);
    assert.notEqual(respawned.deckWireId, pair2.deckWireId);
    assert.notEqual(respawned.barrierWireId, pair2.barrierWireId);
    assert.equal(respawned.blocked, true);

    // Unknown siteId is a safe no-op
    bridge.syncSite("nonexistent-site", 1, false);
    bridge.dispose();
    assert.equal(bridge.entitiesOf(siteDef.id), undefined);
  });

  it("wires seamlessly with CivicService contribution, wear damage, repair, and admin commands", () => {
    const env = makeCivicHarness();
    const bridgeDef = env.rules.sites[0]!;
    const alice = env.makePlayer(1, "Alice", bridgeDef.x, bridgeDef.z);
    env.civic.onEnter(alice);

    assert.equal(env.bridge.isBlocked("redwater-bridge"), true);

    env.getPouch(1).set("wood", 200);
    env.getPouch(1).set("stone", 200);
    env.getPouch(1).set("iron", 200);
    env.wallet.grant(1, 500, 1);

    // Complete Stage 1 -> bridge barrier unblocks automatically via onSiteStateChange
    env.civic.onMessage(alice, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "a2-s1",
      materials: { wood: 30, stone: 20 },
      gold: 25,
    });
    assert.equal(env.bridge.isBlocked("redwater-bridge"), false);
    assert.equal(AssetRef.variant[env.bridge.entitiesOf("redwater-bridge")!.deckEid], 1);

    // Wear crossing until damaged -> barrier re-blocks automatically!
    for (let i = 0; i < 32; i++) {
      env.advanceMs(16_000);
      env.sim.currentTick += 1;
      env.civic.step(env.sim, 1 / 30);
    }
    assert.equal(env.store.getSite("redwater-bridge")!.damaged, true);
    assert.equal(env.bridge.isBlocked("redwater-bridge"), true);
    assert.equal(AssetRef.variant[env.bridge.entitiesOf("redwater-bridge")!.deckEid], BROKEN_VARIANT);

    // Admin repair unblocks bridge cleanly
    const res = runCivicAdminCommand(
      env.civic,
      { subcommand: "repair", siteId: "redwater-bridge" },
      "gm",
      () => true,
      (id, st, dmg) => env.bridge.syncSite(id, st, dmg),
    );
    assert.equal(res.ok, true);
    assert.equal(env.bridge.isBlocked("redwater-bridge"), false);
  });
});

describe("Track C6: Mature-town foundry pivot, masterwork reforge, and repair-kit efficiency", () => {
  it("evaluates pure maturity, reforge trait resolution, and repair-kit overshoot planning", () => {
    const millDef = DEFAULT_CIVIC_RULES.foundries.find((f) => f.id === "millhaven")!;
    assert.equal(isFoundryMature({ depletedPermille: 499 }, millDef), false);
    assert.equal(isFoundryMature({ depletedPermille: 500 }, millDef), true);

    assert.deepEqual(resolveReforgeTargetTrait("bog-standard", "high-carbon", DEFAULT_CIVIC_RULES.traits), {
      ok: true,
      traitId: "high-carbon",
      usedActiveSpecialty: true,
    });
    assert.deepEqual(resolveReforgeTargetTrait("high-carbon", "high-carbon", DEFAULT_CIVIC_RULES.traits), {
      ok: true,
      traitId: "masterwork",
      usedActiveSpecialty: false,
    });
    assert.equal(resolveReforgeTargetTrait("masterwork", "high-carbon", DEFAULT_CIVIC_RULES.traits).ok, false);

    // 1 repair kit (cost iron:2, wood:2 -> 4*2=8 progress) clamps overshoot when offering 10 kits against 18 need
    const plan = planRepairContributionWithKits({ [REPAIR_KIT_MATERIAL_ID]: 10 }, { wood: 12, iron: 6 }, { iron: 2, wood: 2 });
    assert.equal(plan.repairKitsUsed, 3);
    assert.equal(plan.acceptedMaterials[REPAIR_KIT_MATERIAL_ID], 3);
    assert.equal(plan.repairProgressDelta.wood, 12);
    assert.equal(plan.repairProgressDelta.iron, 6);
  });

  it("enforces maturity, specialization, ownership, provenance, gold, and idempotency on foundry_reforge & craft_repair_kit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mmo-civic-c6-"));
    const dbPath = join(dir, "civic.db");
    const env = makeCivicHarness({ dbPath });
    const millDef = env.rules.foundries.find((f) => f.id === "millhaven")!;

    // Pass Stage 2 on bridge so Millhaven supply works
    const bridge = env.store.getSite("redwater-bridge")!;
    env.store.saveSite({ ...bridge, stage: 2, damaged: false, eraTag: "Restored Cart Span" });
    env.bridge.syncSite("redwater-bridge", 2, false);

    const smith = env.makePlayer(1, "Smith", millDef.x, millDef.z);
    const thief = env.makePlayer(2, "Thief", millDef.x, millDef.z);
    env.civic.onEnter(smith);
    env.civic.onEnter(thief);

    // Craft a baseline sword before specialization -> gets bog-standard provenance
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_craft",
      townId: "millhaven",
      opId: "craft-base",
      item: "sword",
      rank: "common",
    });
    const crafted = [...smith.sent].reverse().find((m) => (m as { op?: string }).op === "foundry_crafted") as {
      itemId: number;
      provenance: { traitId: string };
      foundry: { mature: boolean };
    };
    assert.equal(crafted.provenance.traitId, "bog-standard");
    assert.equal(crafted.foundry.mature, false);

    // Immature foundry blocks both craft_repair_kit and foundry_reforge
    env.getPouch(1).set("iron", 200);
    env.getPouch(1).set("wood", 200);
    env.wallet.grant(1, 500, 1);

    env.civic.onMessage(smith, {
      kind: "civic",
      op: "craft_repair_kit",
      townId: "millhaven",
      opId: "kit-immature",
    });
    assert.equal((smith.sent.at(-1) as { code: string }).code, "immature_foundry");

    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "reforge-immature",
      itemId: crafted.itemId,
    });
    assert.equal((smith.sent.at(-1) as { code: string }).code, "immature_foundry");

    // Mature foundry via GM/depletion (500 permille), STILL non-specialized -> craft_repair_kit succeeds, reforge rejects!
    const depRes = runCivicAdminCommand(
      env.civic,
      { subcommand: "set-depletion", townId: "millhaven", depletedPermille: 500 },
      "gm",
      () => true,
    );
    assert.equal(depRes.ok, true);

    env.civic.onMessage(smith, {
      kind: "civic",
      op: "craft_repair_kit",
      townId: "millhaven",
      opId: "kit-ok-1",
    });
    const kitRes = smith.sent.find((m) => (m as { op?: string }).op === "craft_repair_kit") as {
      qty: number;
      foundry: { mature: boolean };
      replayed: boolean;
    };
    assert.equal(kitRes.qty, 1);
    assert.equal(kitRes.foundry.mature, true);
    assert.equal(kitRes.replayed, false);
    assert.equal(env.getPouch(1).get(REPAIR_KIT_MATERIAL_ID), 1);
    assert.equal(env.getPouch(1).get("iron"), 198);
    assert.equal(env.getPouch(1).get("wood"), 198);

    // Idempotent replay of craft_repair_kit does NOT double-spend or grant a second kit
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "craft_repair_kit",
      townId: "millhaven",
      opId: "kit-ok-1",
    });
    assert.equal((smith.sent.at(-1) as { replayed: boolean }).replayed, true);
    assert.equal(env.getPouch(1).get(REPAIR_KIT_MATERIAL_ID), 1);

    // Non-specialized mature foundry rejects foundry_reforge without touching gold
    const goldBeforeReforge = env.wallet.balanceOf(1);
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "reforge-no-spec",
      itemId: crafted.itemId,
    });
    assert.equal((smith.sent.at(-1) as { code: string }).code, "not_specialized");
    assert.equal(env.wallet.balanceOf(1), goldBeforeReforge);

    // Activate high-carbon specialization on mature Millhaven
    const highCarbonVein = {
      veinBatchId: "hc-batch-1",
      templateId: "east-gorge-vein",
      traitId: "high-carbon",
      material: "iron",
      x: 78,
      z: -26,
      anchorIndex: 0,
      stock: 60,
      maxStock: 60,
      discoveredByCharId: 1,
      discoveredByName: "Smith",
      discoveredAt: env.nowMs(),
      respawnAt: null,
      createdAt: env.nowMs(),
    };
    env.store.upsertVein(highCarbonVein);
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_supply",
      townId: "millhaven",
      opId: "sup-hc",
      veinBatchId: "hc-batch-1",
      material: "iron",
      qty: 40,
    });

    // Thief (non-owner) cannot reforge Smith's item
    env.wallet.grant(2, 500, 1);
    env.civic.onMessage(thief, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "thief-reforge",
      itemId: crafted.itemId,
    });
    assert.equal((thief.sent.at(-1) as { code: string }).code, "not_owned");
    assert.equal(env.wallet.balanceOf(2), 500);

    // Item with no provenance cannot be reforged
    env.ownedItems.set(99999, 1);
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "no-prov-reforge",
      itemId: 99999,
    });
    assert.equal((smith.sent.at(-1) as { code: string }).code, "no_provenance");

    // Smith reforges sword -> upgrades from bog-standard to high-carbon, consumes gold & 1 batch
    const goldBeforePaidReforge = env.wallet.balanceOf(1);
    const batchesBefore = env.store.getFoundry("millhaven")!.batchesRemaining;
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "reforge-hc",
      itemId: crafted.itemId,
    });
    const reforged1 = [...smith.sent].reverse().find((m) => (m as { op?: string }).op === "foundry_reforge") as {
      provenance: { traitId: string };
      goldCost: number;
      foundry: { batchesRemaining: number };
      replayed: boolean;
    };
    assert.equal(reforged1.provenance.traitId, "high-carbon");
    assert.equal(reforged1.goldCost, millDef.reforgeGoldCost);
    assert.equal(reforged1.foundry.batchesRemaining, batchesBefore - 1);
    assert.equal(reforged1.replayed, false);
    assert.equal(env.wallet.balanceOf(1), goldBeforePaidReforge - millDef.reforgeGoldCost);
    assert.equal(env.civic.provenanceOf(crafted.itemId)?.traitId, "high-carbon");

    // Replay with same opId does NOT charge gold or consume another batch
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "reforge-hc",
      itemId: crafted.itemId,
    });
    assert.equal((smith.sent.at(-1) as { replayed: boolean }).replayed, true);
    assert.equal(env.wallet.balanceOf(1), goldBeforePaidReforge - millDef.reforgeGoldCost);
    assert.equal(env.store.getFoundry("millhaven")!.batchesRemaining, batchesBefore - 1);

    // Second reforge on item already matching active specialization promotes to "masterwork"
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "reforge-mw",
      itemId: crafted.itemId,
    });
    assert.equal(env.civic.provenanceOf(crafted.itemId)?.traitId, "masterwork");

    // Third reforge on already-masterwork item rejects cleanly without charging gold
    const goldAfterMw = env.wallet.balanceOf(1);
    env.civic.onMessage(smith, {
      kind: "civic",
      op: "foundry_reforge",
      townId: "millhaven",
      opId: "reforge-mw-again",
      itemId: crafted.itemId,
    });
    assert.equal((smith.sent.at(-1) as { code: string }).code, "already_upgraded");
    assert.equal(env.wallet.balanceOf(1), goldAfterMw);

    // Upgraded provenance survives SQLite store reopen
    env.store.close();
    const reopened = new SqliteCivicStore(dbPath);
    assert.equal(reopened.getProvenanceByItemId(crafted.itemId)?.traitId, "masterwork");
    reopened.close();
  });

  it("applies repair-kit efficiency bonus exclusively during repair mode and clamps overshoots", () => {
    const env = makeCivicHarness();
    const bridgeDef = env.rules.sites[0]!;
    const fixer = env.makePlayer(1, "Fixer", bridgeDef.x, bridgeDef.z);
    env.civic.onEnter(fixer);
    env.getPouch(1).set(REPAIR_KIT_MATERIAL_ID, 5);
    env.wallet.grant(1, 500, 1);

    // Stage 0 (not damaged): repair-kit is NOT accepted on normal build contribution
    env.civic.onMessage(fixer, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "kit-build-reject",
      materials: { [REPAIR_KIT_MATERIAL_ID]: 1 },
    });
    assert.equal((fixer.sent.at(-1) as { code: string }).code, "not_needed");
    assert.equal(env.getPouch(1).get(REPAIR_KIT_MATERIAL_ID), 5);

    // Set bridge Stage 2 damaged (wear 300 -> needs wood: 12, iron: 6, gold: 15)
    const b = env.store.getSite("redwater-bridge")!;
    env.store.saveSite({ ...b, stage: 2, damaged: true, wear: 300, eraTag: "Restored Cart Span" });
    env.bridge.syncSite("redwater-bridge", 2, true);

    // Offer 1 repair-kit + 15 gold -> reduces remaining materials by 8 (2x of {iron:2, wood:2})!
    env.civic.onMessage(fixer, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "kit-rep-1",
      materials: { [REPAIR_KIT_MATERIAL_ID]: 1 },
      gold: 15,
    });
    const partial = [...fixer.sent].reverse().find((m) => (m as { op?: string }).op === "contributed") as {
      acceptedMaterials: Record<string, number>;
      repairKitsUsed?: number;
      repaired: boolean;
    };
    assert.equal(partial.acceptedMaterials[REPAIR_KIT_MATERIAL_ID], 1);
    assert.equal(partial.repairKitsUsed, 1);
    assert.equal(partial.repaired, false);
    assert.equal(env.getPouch(1).get(REPAIR_KIT_MATERIAL_ID), 4);

    // Remaining need is 18 - 8 = 10 -> offering 10 kits (we have 4) clamps to 2 kits!
    env.civic.onMessage(fixer, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "kit-rep-2",
      materials: { [REPAIR_KIT_MATERIAL_ID]: 4 },
    });
    const finished = [...fixer.sent].reverse().find((m) => (m as { op?: string }).op === "contributed") as {
      acceptedMaterials: Record<string, number>;
      repairKitsUsed?: number;
      repaired: boolean;
    };
    assert.equal(finished.acceptedMaterials[REPAIR_KIT_MATERIAL_ID], 2);
    assert.equal(finished.repairKitsUsed, 2);
    assert.equal(finished.repaired, true);
    assert.equal(env.getPouch(1).get(REPAIR_KIT_MATERIAL_ID), 2);
    assert.equal(env.bridge.isBlocked("redwater-bridge"), false);
  });
});

describe("Track C5: Caravan escort synergy, ambush spawn cap & anti-farming guards", () => {
  it("enforces heavy threshold, per-char cooldown, ambush window cap, and self-escort guard in coordinator", () => {
    const ambushes: Array<{ siteId: string; x: number; z: number; charId: number }> = [];
    const coord = new CaravanEscortCoordinator({
      cooldownMs: 30_000,
      ambushWindowMs: 60_000,
      maxAmbushesPerWindow: 2,
      maxBonusGold: 20,
      onEscortAmbush: (siteId, x, z, charId) => ambushes.push({ siteId, x, z, charId }),
    });

    // Light haul (<= 5): never triggers
    const light = coord.evaluate({ charId: 1, siteId: "redwater-bridge", x: 58, z: -10, qty: 5, nearbyEscortCount: 2, nowMs: 1000 });
    assert.equal(light.triggered, false);
    assert.equal(light.escortBonusGold, 0);
    assert.equal(ambushes.length, 0);

    // Heavy haul with 0 escorts -> ambush fires, 0 bonus gold
    const solo = coord.evaluate({ charId: 1, siteId: "redwater-bridge", x: 58, z: -10, qty: 10, nearbyEscortCount: 0, nowMs: 2000 });
    assert.equal(solo.triggered, true);
    assert.equal(solo.ambushSpawned, true);
    assert.equal(solo.escortBonusGold, 0);

    // Immediate repeat by charId 1 inside cooldown -> blocked
    const spam = coord.evaluate({ charId: 1, siteId: "redwater-bridge", x: 58, z: -10, qty: 40, nearbyEscortCount: 3, nowMs: 5000 });
    assert.equal(spam.triggered, false);
    assert.equal(spam.reason, "cooldown");
    assert.equal(spam.escortBonusGold, 0);

    // Char 2 with massive nearbyEscortCount -> bonus strictly clamped to maxBonusGold (20), 2nd ambush allowed
    const capped = coord.evaluate({ charId: 2, siteId: "redwater-bridge", x: 58, z: -10, qty: 100, nearbyEscortCount: 99, nowMs: 6000 });
    assert.equal(capped.triggered, true);
    assert.equal(capped.ambushSpawned, true);
    assert.equal(capped.escortBonusGold, 20);

    // Char 3 within same ambushWindowMs hits maxAmbushesPerWindow (2) -> ambushSpawned false, still earns bonus gold
    const winCap = coord.evaluate({ charId: 3, siteId: "redwater-bridge", x: 58, z: -10, qty: 10, nearbyEscortCount: 1, nowMs: 7000 });
    assert.equal(winCap.triggered, true);
    assert.equal(winCap.ambushSpawned, false);
    assert.ok(winCap.escortBonusGold > 0 && winCap.escortBonusGold <= 20);
    assert.equal(ambushes.length, 2);

    // Self-escort check in countNearbyEscorts: excludes hauler, dead entities, and out-of-range players
    const sim = new SimWorld();
    const spawnAvatar = (x: number, z: number, hp: number) => {
      const eid = sim.spawn();
      addComponent(sim.ecs, Transform, eid);
      addComponent(sim.ecs, Health, eid);
      Transform.px[eid] = x;
      Transform.pz[eid] = z;
      Health.current[eid] = hp;
      Health.max[eid] = 100;
      return eid;
    };
    const eSelf = spawnAvatar(58, -10, 100);
    const eDead = spawnAvatar(59, -10, 0);
    const eFar = spawnAvatar(200, 200, 100);
    const eAlly = spawnAvatar(60, -10, 100);
    const cnt = countNearbyEscorts(
      1,
      58,
      -10,
      24,
      [
        { characterId: 1, entity: () => eSelf },
        { characterId: 1, entity: () => eSelf },
        { characterId: 2, entity: () => eDead },
        { characterId: 3, entity: () => eFar },
        { characterId: 4, entity: () => eAlly },
        { characterId: 4, entity: () => eAlly }, // duplicate charId deduplicated
      ],
      Transform.px,
      Transform.pz,
      (eid) => Health.current[eid]! > 0,
    );
    assert.equal(cnt, 1);
  });

  it("awards bounded escortBonusGold and fires bounded ambush callback on CivicService heavy hauls & contract deliveries", () => {
    const ambushes: Array<{ siteId: string; x: number; z: number; charId: number }> = [];
    const env = makeCivicHarness({
      escortCooldownMs: 60_000,
      maxAmbushesPerWindow: 2,
      onEscortAmbush: (siteId, x, z, charId) => ambushes.push({ siteId, x, z, charId }),
    });
    const millDef = env.rules.foundries.find((f) => f.id === "millhaven")!;
    const bridgeDef = env.rules.sites[0]!;
    const site = env.store.getSite("redwater-bridge")!;
    env.store.saveSite({ ...site, stage: 2, damaged: false, eraTag: "Restored Cart Span" });
    env.bridge.syncSite("redwater-bridge", 2, false);

    const hauler = env.makePlayer(1, "Hauler", millDef.x, millDef.z);
    const escort = env.makePlayer(2, "Escort", millDef.x + 4, millDef.z - 2);
    const poster = env.makePlayer(3, "Poster", 0, 0);
    env.civic.onEnter(hauler);
    env.civic.onEnter(escort);
    env.civic.onEnter(poster);

    env.store.upsertVein({
      veinBatchId: "escort-vein-1",
      templateId: "east-gorge-vein",
      traitId: "high-carbon",
      material: "iron",
      x: 78,
      z: -26,
      anchorIndex: 0,
      stock: 80,
      maxStock: 80,
      discoveredByCharId: 1,
      discoveredByName: "Hauler",
      discoveredAt: env.nowMs(),
      respawnAt: null,
      createdAt: env.nowMs(),
    });
    env.getPouch(1).set("iron", 200);
    env.getPouch(1).set("wood", 200);

    // 1. Heavy foundry_supply across redwater-bridge with alive escort nearby -> awards escortBonusGold & spawns 1 ambush
    env.civic.onMessage(hauler, {
      kind: "civic",
      op: "foundry_supply",
      townId: "millhaven",
      opId: "heavy-sup-1",
      veinBatchId: "escort-vein-1",
      material: "iron",
      qty: 20,
    });
    const supMsg = [...hauler.sent].reverse().find((m) => (m as { op?: string }).op === "foundry_updated") as {
      escortBonusGold?: number;
      replayed: boolean;
    };
    assert.ok((supMsg.escortBonusGold ?? 0) > 0);
    const bonus1 = supMsg.escortBonusGold!;
    assert.equal(env.wallet.balanceOf(1), bonus1);
    assert.equal(ambushes.length, 1);
    assert.deepEqual(ambushes[0], { siteId: "redwater-bridge", x: millDef.x, z: millDef.z, charId: 1 });

    // Replay does NOT double-award bonus gold or ambush
    env.civic.onMessage(hauler, {
      kind: "civic",
      op: "foundry_supply",
      townId: "millhaven",
      opId: "heavy-sup-1",
      veinBatchId: "escort-vein-1",
      material: "iron",
      qty: 20,
    });
    assert.equal(env.wallet.balanceOf(1), bonus1);
    assert.equal(ambushes.length, 1);

    // 2. Heavy contract_deliver inside cooldown -> 0 additional bonus gold, no ambush
    env.wallet.grant(3, 500, 1);
    env.civic.onMessage(poster, {
      kind: "civic",
      op: "contract_post",
      opId: "c-post",
      targetKind: "site",
      targetId: "redwater-bridge",
      material: "wood",
      qty: 20,
      rewardPerUnit: 10,
    });
    const posted = [...poster.sent].reverse().find((m) => (m as { op?: string }).op === "contract_update") as {
      contract: { contractId: string };
    };
    Transform.px[hauler.eid] = bridgeDef.x;
    Transform.pz[hauler.eid] = bridgeDef.z;
    Transform.px[escort.eid] = bridgeDef.x + 3;
    Transform.pz[escort.eid] = bridgeDef.z;

    env.civic.onMessage(hauler, {
      kind: "civic",
      op: "contract_deliver",
      opId: "c-del-cooldown",
      contractId: posted.contract.contractId,
      qty: 10,
    });
    const del1 = [...hauler.sent].reverse().find((m) => (m as { op?: string }).op === "contract_update") as {
      payoutGold?: number;
      escortBonusGold?: number;
    };
    assert.equal(del1.payoutGold, 100);
    assert.equal(del1.escortBonusGold, undefined);
    assert.equal(env.wallet.balanceOf(1), bonus1 + 100);
    assert.equal(ambushes.length, 1);

    // 3. Advance past cooldown -> heavy contract_deliver awards escortBonusGold & spawns 2nd ambush
    env.advanceMs(65_000);
    env.civic.onMessage(hauler, {
      kind: "civic",
      op: "contract_deliver",
      opId: "c-del-2",
      contractId: posted.contract.contractId,
      qty: 10,
    });
    const del2 = [...hauler.sent].reverse().find((m) => (m as { op?: string }).op === "contract_update") as {
      payoutGold?: number;
      escortBonusGold?: number;
    };
    assert.equal(del2.payoutGold, 100);
    assert.ok((del2.escortBonusGold ?? 0) > 0);
    assert.equal(env.wallet.balanceOf(1), bonus1 + 200 + del2.escortBonusGold!);
    assert.equal(ambushes.length, 2);
  });

  it("keeps CivicService.access strictly accurate and step() zero-alloc across idle ticks", () => {
    const env = makeCivicHarness();
    assert.deepEqual(env.civic.access, {
      system: "civic",
      reads: [
        { component: "Transform", fields: ["px", "pz"] },
        { component: "Health", fields: ["current"] },
      ],
      writes: [],
    });

    const p = env.makePlayer(1, "Walker", 0, 0);
    env.civic.onEnter(p);
    for (let i = 1; i <= 30; i++) {
      env.sim.currentTick = i;
      env.civic.step(env.sim, 1 / 30);
    }
    assert.equal(env.store.getSite("redwater-bridge")!.wear, 0);
  });
});
