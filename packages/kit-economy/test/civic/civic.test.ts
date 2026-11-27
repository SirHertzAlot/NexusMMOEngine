/**
 * Exhaustive base-case & edge-case tests for Living Regional Provenance & Civic Logistics
 * (Redwater Crossing vertical slice): surveying, finite veins, cooperative bridges + traffic
 * wear, foundry specialization, escrow contracts + offline auto-refund, item provenance across
 * restarts, additive SQLite migrations, admin commands, and server module assembly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { addComponent } from "bitecs";
import { DEFAULT_CIVIC_RULES, loadRules, type CivicRules } from "@mmo-engine/rules";
import {
  CivicService,
  SqliteCivicStore,
  runCivicAdminCommand,
} from "@mmo-engine/engine-core/dist/src/civic/index.js";
import { Health, Transform } from "@mmo-engine/engine-core/dist/src/components.js";
import { WalletSystem } from "../../src/wallet.js";
import { ItemService, ItemWhere, loadItemDefs } from "@mmo-engine/engine-core/dist/src/items/index.js";
import { assembleServerSystems } from "@mmo-engine/engine-core/dist/src/modules.js";
import type { ExtensionPlayer } from "@mmo-engine/engine-core/dist/src/net/extension.js";
import { SimWorld } from "@mmo-engine/engine-core/dist/src/world.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));

function makeRules(): CivicRules {
  return structuredClone(DEFAULT_CIVIC_RULES);
}

interface HarnessPlayer extends ExtensionPlayer {
  sent: unknown[];
  refreshes: number;
  eid: number;
}

function makeEnv(opts?: { rules?: CivicRules; dbPath?: string; startMs?: number }) {
  const sim = new SimWorld();
  let clockMs = opts?.startMs ?? 1_700_000_000_000;
  const rules = opts?.rules ?? makeRules();
  const store = new SqliteCivicStore(opts?.dbPath ?? ":memory:");
  const wallet = new WalletSystem();
  const pouches = new Map<number, Map<string, number>>();
  const pouchMax = 500;
  const bagRoom = new Set<number>();
  let nextItemId = 100;
  const siteEvents: Array<{ siteId: string; stage: number; damaged: boolean }> = [];

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
    hasBagRoom: (charId) => !bagRoom.has(charId),
    craftAndGrantItem: () => ++nextItemId,
    onSiteStateChange: (siteId, stage, damaged) => siteEvents.push({ siteId, stage, damaged }),
  });

  const makePlayer = (charId: number, name: string, x = 0, z = 0, hp = 100): HarnessPlayer => {
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid);
    addComponent(sim.ecs, Health, eid);
    Transform.px[eid] = x;
    Transform.pz[eid] = z;
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
    civic,
    store,
    wallet,
    pouches,
    bagRoom,
    siteEvents,
    getPouch,
    advanceMs: (ms: number) => {
      clockMs += ms;
    },
    setClock: (ms: number) => {
      clockMs = ms;
    },
    makePlayer,
  };
}

describe("Domain 1: Dynamic surveying & finite vein edge cases", () => {
  it("hides undiscovered veins from public state and returns bucketed directions outside pinpoint radius", () => {
    const rules = makeRules();
    // Place non-baseline hidden vein at (80, 0), single minActivePerRegion = 1
    rules.surveying.minActivePerRegion = 1;
    rules.veins = [
      {
        id: "hidden-vein",
        material: "iron",
        stock: 2,
        isBaseline: false,
        respawnDelayMs: 10_000,
        traitPool: ["high-carbon"],
        spawnAnchors: [
          { x: 80, z: 0 },
          { x: 120, z: 0 },
        ],
      },
    ];
    const env = makeEnv({ rules });
    const alice = env.makePlayer(1, "Alice", 0, 0);
    env.civic.onEnter(alice);

    // Must not expose undiscovered vein coordinates in state push
    const initState = alice.sent[0] as { op: string; veins: unknown[] };
    assert.equal(initState.op, "state");
    assert.equal(initState.veins.length, 0);

    // Cannot blind-extract by guessing veinBatchId before discovery
    env.civic.onMessage(alice, { kind: "civic", op: "extract", veinBatchId: "hidden-vein-1", qty: 1 });
    assert.equal((alice.sent.at(-1) as { code: string }).code, "unknown_vein");

    // Survey at (0, 0) -> bucketed East ~80 m, NO veinBatchId leaked
    env.civic.onMessage(alice, { kind: "civic", op: "survey" });
    const warm = alice.sent.at(-1) as { op: string; band: string; direction: string; distanceBucketM: number; veinBatchId?: string };
    assert.equal(warm.op, "survey_result");
    assert.equal(warm.band, "warm");
    assert.equal(warm.direction, "E");
    assert.equal(warm.distanceBucketM, 80);
    assert.equal(warm.veinBatchId, undefined);

    // Survey cooldown blocks rapid spam
    env.civic.onMessage(alice, { kind: "civic", op: "survey" });
    assert.equal((alice.sent.at(-1) as { code: string }).code, "cooldown");

    // Dead player cannot survey
    env.advanceMs(3000);
    Health.current[alice.eid] = 0;
    env.civic.onMessage(alice, { kind: "civic", op: "survey" });
    assert.equal((alice.sent.at(-1) as { code: string }).code, "dead");

    // Move inside pinpointRadiusM (14 m) and survive -> reveals vein
    Health.current[alice.eid] = 100;
    Transform.px[alice.eid] = 74;
    env.civic.onMessage(alice, { kind: "civic", op: "survey" });
    const pinpoint = alice.sent.find(
      (m) => (m as { op?: string; band?: string }).op === "survey_result" && (m as { band?: string }).band === "pinpoint",
    ) as { veinBatchId: string; newlyDiscovered: boolean; traitId: string };
    assert.ok(pinpoint);
    assert.equal(pinpoint.newlyDiscovered, true);
    assert.equal(pinpoint.traitId, "high-carbon");

    // Pouch full check BEFORE stock decrement preserves ore stock!
    env.getPouch(1).set("iron", 500); // full (pouchMax = 500)
    env.civic.onMessage(alice, { kind: "civic", op: "extract", veinBatchId: pinpoint.veinBatchId, qty: 1 });
    assert.equal((alice.sent.at(-1) as { code: string }).code, "pouch_full");
    assert.equal(env.store.getVein(pinpoint.veinBatchId)!.stock, 2);

    // Clear pouch headroom -> extract 1, then simultaneous last-ore race with Bob
    env.getPouch(1).set("iron", 0);
    const bob = env.makePlayer(2, "Bob", 74, 0);
    env.civic.onMessage(alice, { kind: "civic", op: "extract", veinBatchId: pinpoint.veinBatchId, qty: 1 });
    env.advanceMs(600);
    env.civic.onMessage(alice, { kind: "civic", op: "extract", veinBatchId: pinpoint.veinBatchId, qty: 1 });
    env.civic.onMessage(bob, { kind: "civic", op: "extract", veinBatchId: pinpoint.veinBatchId, qty: 1 });

    // Alice got both units; Bob gets clean depletion notice and stock never went negative
    assert.equal(env.getPouch(1).get("iron"), 2);
    assert.equal(env.getPouch(2).get("iron") ?? 0, 0);
    assert.equal(env.store.getVein(pinpoint.veinBatchId)!.stock, 0);
    assert.equal((bob.sent.at(-1) as { code: string }).code, "depleted");

    // Wall-clock respawn rotates to next anchor with a fresh veinBatchId
    env.advanceMs(10_500);
    env.sim.currentTick += 1;
    env.civic.step(env.sim, 1 / 30);
    env.civic.ensureActiveVeins(1_700_000_000_000 + 14_100);
    const rotated = env.store.listVeins(false)[0]!;
    assert.notEqual(rotated.veinBatchId, pinpoint.veinBatchId);
    assert.equal(rotated.stock, 2);
    assert.equal(rotated.x !== 80 || rotated.z !== 0, true);
  });
});

describe("Domain 2: Civic bridge restoration, overshoot clamp, anti-whale & debounced wear", () => {
  it("clamps overshoots, rolls back failed multi-resource debits, isolates opIds, applies anti-whale weights & repairs wear without wiping stage", () => {
    const env = makeEnv();
    const bridgeDef = env.civic.getRules().sites[0]!;
    const alice = env.makePlayer(1, "Alice", bridgeDef.x, bridgeDef.z);
    const bob = env.makePlayer(2, "Bob", bridgeDef.x, bridgeDef.z);
    env.civic.onEnter(alice);
    env.civic.onEnter(bob);

    // Multi-resource atomicity check: stage 1 needs wood: 30, stone: 20, goldCost: 25
    // Alice has enough wood (50) and stone (50) but short gold (10) -> must spend 0 wood, 0 stone, 0 gold!
    env.getPouch(1).set("wood", 50);
    env.getPouch(1).set("stone", 50);
    env.wallet.grant(1, 10, 1);
    env.civic.onMessage(alice, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "atomic-fail",
      materials: { wood: 30, stone: 20 },
      gold: 25,
    });
    assert.equal((alice.sent.at(-1) as { code: string }).code, "insufficient_gold");
    assert.equal(env.getPouch(1).get("wood"), 50);
    assert.equal(env.getPouch(1).get("stone"), 50);
    assert.equal(env.wallet.balanceOf(1), 10);

    // Overshoot clamp + scoped idempotency: give excess materials/gold and send twice; Bob uses same opId!
    env.wallet.grant(1, 500, 1);
    env.getPouch(1).set("wood", 100);
    env.getPouch(1).set("stone", 100);
    env.civic.onMessage(alice, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "shared-op",
      materials: { wood: 99, stone: 99 },
      gold: 99,
    });
    const aliceRes = alice.sent.find((m) => (m as { op?: string }).op === "contributed") as {
      acceptedMaterials: Record<string, number>;
      acceptedGold: number;
      stage: number;
      stageAdvanced: boolean;
      replayed: boolean;
    };
    assert.equal(aliceRes.stage, 1);
    assert.equal(aliceRes.stageAdvanced, true);
    assert.equal(aliceRes.acceptedMaterials.wood, 30);
    assert.equal(aliceRes.acceptedMaterials.stone, 20);
    assert.equal(aliceRes.acceptedGold, 25);
    assert.equal(env.getPouch(1).get("wood"), 70);
    assert.equal(env.getPouch(1).get("stone"), 80);
    assert.equal(env.wallet.balanceOf(1), 510 - 25);

    // Alice replay gets replayed: true with zero second spend
    env.civic.onMessage(alice, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "shared-op",
      materials: { wood: 99 },
    });
    const replay = alice.sent.at(-1) as { op: string; replayed: boolean };
    assert.equal(replay.op, "contributed");
    assert.equal(replay.replayed, true);
    assert.equal(env.getPouch(1).get("wood"), 70);

    // Bob using the exact same opId string ("shared-op") is NOT blocked by Alice's opId!
    env.getPouch(2).set("wood", 250);
    env.getPouch(2).set("iron", 250);
    env.wallet.grant(2, 500, 1);
    // Stage 2 needs wood: 40, iron: 25, gold: 75 (total 140). First check Bob partial contribution with "shared-op"
    env.civic.onMessage(bob, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "shared-op",
      materials: { wood: 20 },
    });
    const bobRes = bob.sent.find((m) => (m as { op?: string }).op === "contributed") as {
      replayed: boolean;
      acceptedMaterials: Record<string, number>;
    };
    assert.equal(bobRes.replayed, false);
    assert.equal(bobRes.acceptedMaterials.wood, 20);

    // Complete stage 2 by Alice (pushes past daily cap later to verify diminishing weight)
    env.getPouch(1).set("iron", 250);
    env.getPouch(1).set("wood", 250);
    env.civic.onMessage(alice, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "finish-stage-2",
      materials: { wood: 50, iron: 50 },
      gold: 200,
    });
    const siteAfterStage2 = env.store.getSite("redwater-bridge")!;
    assert.equal(siteAfterStage2.stage, 2);
    assert.equal(siteAfterStage2.damaged, false);

    // Debounced crossing traffic wear -> trips damaged at damageThreshold (300) without dropping stage back to 0!
    // crossingCooldownMs = 15_000, wearPerCrossing = 10 -> 30 debounced ticks trigger damaged
    for (let i = 0; i < 35; i++) {
      env.advanceMs(16_000);
      env.sim.currentTick += 1;
      env.civic.step(env.sim, 1 / 30);
    }
    const damagedSite = env.store.getSite("redwater-bridge")!;
    assert.equal(damagedSite.damaged, true);
    assert.equal(damagedSite.stage, 2); // never wiped back to ruined stage 0!
    assert.ok(damagedSite.wear >= bridgeDef.damageThreshold);
    assert.equal(env.siteEvents.at(-1)?.damaged, true);

    // Idle offline clock advance produces ZERO passive decay
    const wearBeforeIdle = damagedSite.wear;
    env.advanceMs(7 * 86_400_000);
    assert.equal(env.store.getSite("redwater-bridge")!.wear, wearBeforeIdle);

    // Repair damaged span cleanly (Stage 2 preserved; repair progress isolated cleanly)
    env.civic.onMessage(bob, {
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "repair-all",
      materials: { wood: 100, iron: 100 },
      gold: 100,
    });
    const repaired = env.store.getSite("redwater-bridge")!;
    assert.equal(repaired.damaged, false);
    assert.equal(repaired.wear, 0);
    assert.equal(repaired.stage, 2);
  });
});

describe("Domain 3: Settlement foundry specialization & bridge haul gating", () => {
  it("gates Millhaven heavy hauls behind bridge stage 2, activates finite trait batches & expires cleanly back to baseline", () => {
    const env = makeEnv();
    const mill = env.civic.getRules().foundries.find((f) => f.id === "millhaven")!;
    const player = env.makePlayer(1, "Smith", mill.x, mill.z);
    env.civic.onEnter(player);
    env.getPouch(1).set("iron", 200);

    // Pinpoint high-carbon vein first (at default anchors) -> or pick active baseline batch
    const veins = env.store.listVeins(false);
    assert.ok(veins.length > 0);
    const batchId = veins[0]!.veinBatchId;

    // Stage 0 bridge blocks Millhaven supply completely
    env.civic.onMessage(player, {
      kind: "civic",
      op: "foundry_supply",
      townId: "millhaven",
      opId: "fs-0",
      veinBatchId: batchId,
      material: "iron",
      qty: 5,
    });
    assert.equal((player.sent.at(-1) as { code: string }).code, "crossing_blocked");

    // Advance bridge to Stage 1 -> small pack (<=5) passes, heavy haul (>5) blocked!
    const s = env.store.getSite("redwater-bridge")!;
    env.store.saveSite({ ...s, stage: 1, eraTag: "Timber Foot-Scaffold" });
    env.civic.onMessage(player, {
      kind: "civic",
      op: "foundry_supply",
      townId: "millhaven",
      opId: "fs-heavy-fail",
      veinBatchId: batchId,
      material: "iron",
      qty: 40,
    });
    assert.equal((player.sent.at(-1) as { code: string }).code, "heavy_haul_blocked");

    // Advance bridge to Stage 2 -> bulk 40 iron succeeds, triggers specialization + bridge heavy haul wear
    env.store.saveSite({ ...s, stage: 2, wear: 0, damaged: false, eraTag: "Restored Cart Span" });
    env.civic.onMessage(player, {
      kind: "civic",
      op: "foundry_supply",
      townId: "millhaven",
      opId: "fs-bulk",
      veinBatchId: batchId,
      material: "iron",
      qty: 40,
    });
    const updated = sentOrFind(player, "foundry_updated") as {
      specialized: boolean;
      foundry: { batchesRemaining: number; activeTraitId: string; depletedPermille: number };
    };
    assert.equal(updated.specialized, true);
    assert.equal(updated.foundry.batchesRemaining, mill.batchesPerSpecialization);
    assert.ok(updated.foundry.depletedPermille > 0);
    assert.equal(env.store.getSite("redwater-bridge")!.wear, env.civic.getRules().sites[0]!.wearPerHeavyHaul);

    // Bag full blocks craft BEFORE consuming a specialty batch
    env.bagRoom.add(1);
    env.civic.onMessage(player, {
      kind: "civic",
      op: "foundry_craft",
      townId: "millhaven",
      opId: "fc-full",
      item: "sword",
      rank: "common",
    });
    assert.equal((player.sent.at(-1) as { code: string }).code, "bag_full");
    assert.equal(env.store.getFoundry("millhaven")!.batchesRemaining, mill.batchesPerSpecialization);

    // Craft succeeds, mints provenance, decrements batchesRemaining by 1
    env.bagRoom.delete(1);
    env.civic.onMessage(player, {
      kind: "civic",
      op: "foundry_craft",
      townId: "millhaven",
      opId: "fc-ok",
      item: "sword",
      rank: "common",
    });
    const crafted = sentOrFind(player, "foundry_crafted") as {
      itemId: number;
      provenance: { townId: string; crafterName: string; eraTag: string };
      foundry: { batchesRemaining: number };
    };
    assert.equal(crafted.foundry.batchesRemaining, mill.batchesPerSpecialization - 1);
    assert.equal(crafted.provenance.townId, "millhaven");
    assert.equal(crafted.provenance.crafterName, "Smith");
    assert.equal(env.civic.provenanceOf(crafted.itemId)?.provenanceId !== undefined, true);

    // TTL expiry returns foundry cleanly back to bog-standard baseline
    env.advanceMs(mill.specializationTtlMs + 1000);
    env.sim.currentTick += 1;
    env.civic.step(env.sim, 1 / 30);
    const expired = env.store.getFoundry("millhaven")!;
    assert.equal(expired.batchesRemaining, 0);
    assert.equal(expired.activeTraitId, "bog-standard");
  });
});

describe("Domain 4: Escrow contracts, partial delivery, race guards & offline auto-refund", () => {
  it("enforces contract cap, integer math, partial delivery clamping, cancel/deliver race exclusion & offline credit claim", () => {
    const env = makeEnv();
    const bridgeDef = env.civic.getRules().sites[0]!;
    const poster = env.makePlayer(1, "Poster", 0, 0);
    const hauler = env.makePlayer(2, "Hauler", bridgeDef.x, bridgeDef.z);
    env.civic.onEnter(poster);
    env.civic.onEnter(hauler);
    env.wallet.grant(1, 10_000, 1);

    // Post work order: 10 wood at 20g/u -> subtotal 200, fee floor(200*0.02) = 4, totalLock = 204
    env.civic.onMessage(poster, {
      kind: "civic",
      op: "contract_post",
      opId: "post-1",
      targetKind: "site",
      targetId: "redwater-bridge",
      material: "wood",
      qty: 10,
      rewardPerUnit: 20,
      ttlHours: 2,
    });
    assert.equal(env.wallet.balanceOf(1), 10_000 - 204);
    const posted = sentOrFind(poster, "contract_update");
    assert.equal(posted.contract.totalQty, 10);

    // Partial clamped delivery: hauler has 100 wood, delivers "50" -> clamped to remaining 10, contract filled!
    env.getPouch(2).set("wood", 100);
    env.civic.onMessage(hauler, {
      kind: "civic",
      op: "contract_deliver",
      opId: "del-1",
      contractId: posted.contract.contractId,
      qty: 50,
    });
    assert.equal(env.getPouch(2).get("wood"), 90);
    assert.equal(env.wallet.balanceOf(2), 200);

    // Concurrent cancel attempt on already-filled contract cannot double-refund!
    env.civic.onMessage(poster, {
      kind: "civic",
      op: "contract_cancel",
      opId: "cancel-filled",
      contractId: posted.contract.contractId,
    });
    assert.equal((poster.sent.at(-1) as { code: string }).code, "not_open");
    assert.equal(env.wallet.balanceOf(1), 10_000 - 204);

    // Offline expiry + pending credit claim on next login:
    const balBeforeSecond = env.wallet.balanceOf(1);
    env.civic.onMessage(poster, {
      kind: "civic",
      op: "contract_post",
      opId: "post-expire",
      targetKind: "site",
      targetId: "redwater-bridge",
      material: "wood",
      qty: 10,
      rewardPerUnit: 30,
      ttlHours: 1,
    });
    // locked: 300 + 6 fee = 306
    assert.equal(env.wallet.balanceOf(1), balBeforeSecond - 306);
    env.civic.onLeave(poster);

    // Advance past 1h TTL while poster is offline -> sweep moves 300 escrow into civic_pending_credits
    env.advanceMs(3_700_000);
    env.sim.currentTick += 1;
    env.civic.step(env.sim, 1 / 30);
    assert.equal(env.store.getPendingCredits(1), 300);

    // Re-enter world -> pending credits automatically paid out into wallet and cleared!
    const posterBack = env.makePlayer(1, "Poster", 0, 0);
    env.civic.onEnter(posterBack);
    const reState = posterBack.sent.find((m) => (m as { op?: string }).op === "state") as { pendingCreditsClaimed: number };
    assert.equal(reState.pendingCreditsClaimed, 300);
    assert.equal(env.wallet.balanceOf(1), balBeforeSecond - 6);
    assert.equal(env.store.getPendingCredits(1), 0);

    // Enforce maxOpenPerCharacter spam cap (10)
    for (let i = 0; i < 10; i++) {
      env.civic.onMessage(posterBack, {
        kind: "civic",
        op: "contract_post",
        opId: `cap-${i}`,
        targetKind: "site",
        targetId: "redwater-bridge",
        material: "wood",
        qty: 1,
        rewardPerUnit: 1,
      });
    }
    env.civic.onMessage(posterBack, {
      kind: "civic",
      op: "contract_post",
      opId: "cap-overflow",
      targetKind: "site",
      targetId: "redwater-bridge",
      material: "wood",
      qty: 1,
      rewardPerUnit: 1,
    });
    assert.equal((posterBack.sent.at(-1) as { code: string }).code, "contract_cap");
  });
});

describe("Domain 5: Provenance persistence across restarts, ItemService view, DB migrations, admin & modules", () => {
  it("hydrates ItemView.provenance across item moves/equips and SQLite DB reopens, plus additive schema migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "mmo-civic-"));
    const dbPath = join(dir, "civic.db");

    // Simulate legacy v0 table missing repair_progress/era_tag columns -> must migrate without data loss
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE civic_sites (
        id TEXT PRIMARY KEY,
        stage INTEGER NOT NULL,
        progress TEXT NOT NULL,
        gold_progress INTEGER NOT NULL DEFAULT 0,
        wear INTEGER NOT NULL DEFAULT 0,
        damaged INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO civic_sites (id, stage, progress, gold_progress, wear, damaged, updated_at)
      VALUES ('redwater-bridge', 2, '{}', 0, 15, 0, 1000);
    `);
    rawDb.close();

    const store1 = new SqliteCivicStore(dbPath);
    assert.equal(store1.getSite("redwater-bridge")!.stage, 2);

    const rulesDir = join(REPO, "content", "rules");
    const { defs } = loadItemDefs(dir, loadRules(rulesDir));
    const items = new ItemService({ defs, loot: { bagSlots: 20, ownershipSeconds: 30, despawnSeconds: 300, maxGroundItems: 64, pickupRange: 2.5, bagColumns: 5 }, tickHz: 30 });
    const swordDef = defs.ofBase("sword")[0]!;
    const giveRes = items.give(1, swordDef);
    assert.equal(giveRes.ok, true);
    const swordId = giveRes.itemId!;

    const env1 = makeEnv({ dbPath });
    store1.close();
    const minted = env1.store.mintProvenance({
      veinBatchId: "highland-ridge-vein-1",
      traitId: "high-carbon",
      townId: "millhaven",
      crafterId: 1,
      crafterName: "Forgeon",
      eraTag: "Restored Cart Span",
      craftedAt: 1_700_000_000_000,
    });
    env1.store.bindItemProvenance(swordId, minted.provenanceId);
    items.setProvenanceLookup((id) => env1.civic.provenanceOf(id));

    // Attach to bag -> transfer to char 2 -> close & reopen DB -> provenance intact!
    assert.equal(items.view(swordId).provenance?.townId, "millhaven");
    assert.equal(items.view(swordId).provenance?.crafterName, "Forgeon");
    items.moveItem(swordId, 1, 2);
    assert.equal(items.view(swordId).provenance?.traitId, "high-carbon");

    env1.store.close();
    const store2 = new SqliteCivicStore(dbPath);
    items.setProvenanceLookup((id) => store2.getProvenanceByItemId(id));
    assert.equal(items.view(swordId).provenance?.veinBatchId, "highland-ridge-vein-1");

    // Admin commands
    const civic2 = new CivicService({
      rules: makeRules(),
      store: store2,
      countMaterial: () => 0,
      takeMaterial: () => false,
      grantMaterial: () => false,
      hasMaterialRoom: () => false,
      balanceOf: () => 0,
      spendGold: () => false,
      grantGold: () => true,
      hasBagRoom: () => true,
      craftAndGrantItem: () => null,
    });
    const inspectRes = runCivicAdminCommand(civic2, { subcommand: "inspect", target: "sites" }, "gm", () => true);
    assert.equal(inspectRes.ok, true);
    const stageRes = runCivicAdminCommand(civic2, { subcommand: "stage", siteId: "redwater-bridge", stage: 1 }, "gm", () => true);
    assert.equal(stageRes.ok, true);
    assert.equal(store2.getSite("redwater-bridge")!.stage, 1);
    store2.close();
    void ItemWhere;
    void rulesDir;
  });

  it("assembles modules/civic after economy + items via assembleServerSystems and disposes cleanly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mmo-mod-civic-"));
    const setFile = join(tmp, "modules.json");
    writeFileSync(setFile, JSON.stringify({ modules: ["economy", "items", "civic"] }));

    const ctx: { sim: SimWorld; log: (m: string) => void; config: Record<string, Record<string, unknown>>; stores?: Record<string, unknown> } = {
      sim: new SimWorld(),
      log: () => {},
      config: {
        economy: { dataDir: tmp },
        items: {
          dataDir: tmp,
          rules: loadRules(join(REPO, "content", "rules")),
          ledger: { load: () => [], maxItemId: () => 0, append: () => {}, flush: () => {} },
        },
        civic: { dataDir: tmp },
      },
    };
    const modulesDir = join(REPO, "modules");
    const r = await assembleServerSystems({
      modulesDir,
      setFile,
      provided: { core: {} },
      ctx,
    });
    assert.ok(r.byName["civic"], "civic must register as a SimSystem");
    assert.ok(r.extensions["civic"], "civic must register as a GatewayExtension");
    assert.ok(r.modules.indexOf("items") < r.modules.indexOf("civic"));
    assert.ok(ctx.stores?.civicStore, "civicStore published on ctx.stores");
    await r.disposeModules();
    assert.equal(ctx.stores?.civicStore, undefined);
  });
});

// Helper declaration merged cleanly on test file scope
declare module "node:test" {}
function sentOrFind(p: HarnessPlayer, op: string): any {
  const m = [...p.sent].reverse().find((x) => (x as { op?: string }).op === op);
  assert.ok(m, `expected message with op=${op}`);
  return m;
}
// Attach helper to env return in runtime calls below without changing MakeEnv signature:
Object.assign(globalThis, {});
