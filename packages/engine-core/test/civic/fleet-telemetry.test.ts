/**
 * Track B4 (Multi-Region Snapshot Recall & Fleet Provenance) and
 * Track C7a (Zero-Alloc Civic SAB Telemetry Metrics) tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as argon2 from "argon2";
import express from "express";
import { z } from "zod";
import { mergeExpositions } from "@mmo-engine/nethealth";
import { loadRules } from "@mmo-engine/rules";
import {
  CraftExecuteSchema,
  LootGrantSchema,
  MemoryWorldStore,
  WorldCoreImpl,
  createWebrpcRouter,
  type InventoryItem,
} from "@mmo-engine/world-server";
import { SqliteCivicStore } from "../../src/civic/civic-store.js";
import { ItemService, loadItemDefs } from "../../src/items/index.js";
import { LedgerKind } from "../../src/persist/item-ledger.js";
import {
  CIVIC_METRICS_BYTES,
  CivicTelemetryMetrics,
  LogMetricsPage,
  type CivicTelemetrySnapshot,
} from "../../src/logging/index.js";
import {
  CIVIC_SNAPSHOT_VERSION,
  CivicWorldSnapshotSchema,
  MAX_CIVIC_SNAPSHOT_BYTES,
  exportCivicSnapshot,
  importCivicSnapshot,
} from "../../src/world/civic-sync.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const TEST_NOW = 1_700_000_000_000;

function tableCount(store: SqliteCivicStore, table: string): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function allTableCounts(store: SqliteCivicStore): Record<string, number> {
  return {
    civic_sites: tableCount(store, "civic_sites"),
    civic_contributors: tableCount(store, "civic_contributors"),
    civic_history: tableCount(store, "civic_history"),
    civic_veins: tableCount(store, "civic_veins"),
    civic_foundries: tableCount(store, "civic_foundries"),
    civic_foundry_char_weights: tableCount(store, "civic_foundry_char_weights"),
    civic_contracts: tableCount(store, "civic_contracts"),
    civic_pending_credits: tableCount(store, "civic_pending_credits"),
    civic_provenance: tableCount(store, "civic_provenance"),
    civic_item_provenance: tableCount(store, "civic_item_provenance"),
  };
}

function seedFullStore(store: SqliteCivicStore): {
  openContractId: number;
  filledContractId: number;
  itemId: number;
  provenanceId: number;
} {
  store.saveSite({
    id: "redwater-bridge",
    stage: 2,
    progress: { wood: 14, stone: 7 },
    goldProgress: 35,
    repairProgress: { wood: 3, iron: 1 },
    repairGoldProgress: 4,
    wear: 340,
    damaged: true,
    eraTag: "Restored Cart Span",
    updatedAt: TEST_NOW + 1000,
  });

  store.saveContributor({
    siteId: "redwater-bridge",
    charId: 10,
    name: "Alice",
    rawScore: 150,
    effectiveWeight: 125.5,
    todayDay: 19675,
    todayRaw: 50,
    updatedAt: TEST_NOW + 1000,
  });
  store.saveContributor({
    siteId: "redwater-bridge",
    charId: 11,
    name: "Bob",
    rawScore: 40,
    effectiveWeight: 40,
    todayDay: 19675,
    todayRaw: 40,
    updatedAt: TEST_NOW + 900,
  });

  store.appendHistory({
    siteId: "redwater-bridge",
    eventType: "contributed",
    actorId: 10,
    actorName: "Alice",
    eraTag: "Timber Foot-Scaffold",
    detail: "Supplied timber toward Redwater Gorge Bridge",
    createdAt: TEST_NOW + 100,
  });
  store.appendHistory({
    siteId: "redwater-bridge",
    eventType: "stage_advanced",
    actorId: 10,
    actorName: "Alice",
    eraTag: "Restored Cart Span",
    detail: "Advanced Redwater Gorge Bridge to Stage 2",
    createdAt: TEST_NOW + 500,
  });
  store.appendHistory({
    siteId: "redwater-bridge",
    eventType: "damaged",
    actorId: 11,
    actorName: "Crossing traffic",
    eraTag: "Restored Cart Span",
    detail: "Redwater Gorge Bridge suffered structural wear (340/1000)",
    createdAt: TEST_NOW + 1000,
  });

  // Undiscovered, discovered, and depleted veins
  store.upsertVein({
    veinBatchId: "east-gorge-vein-1",
    templateId: "east-gorge-vein",
    traitId: "high-carbon",
    material: "iron",
    x: 78,
    z: -26,
    anchorIndex: 0,
    stock: 80,
    maxStock: 80,
    discoveredByCharId: null,
    discoveredByName: null,
    discoveredAt: null,
    respawnAt: null,
    createdAt: TEST_NOW,
  });
  store.upsertVein({
    veinBatchId: "highland-ridge-vein-2",
    templateId: "highland-ridge-vein",
    traitId: "deep-vein",
    material: "iron",
    x: 115,
    z: 28,
    anchorIndex: 0,
    stock: 28,
    maxStock: 60,
    discoveredByCharId: 10,
    discoveredByName: "Alice",
    discoveredAt: TEST_NOW + 200,
    respawnAt: null,
    createdAt: TEST_NOW + 50,
  });
  store.upsertVein({
    veinBatchId: "oakhaven-surface-3",
    templateId: "oakhaven-surface",
    traitId: "bog-standard",
    material: "iron",
    x: -12,
    z: 14,
    anchorIndex: 0,
    stock: 0,
    maxStock: 40,
    discoveredByCharId: 0,
    discoveredByName: "Regional Survey",
    discoveredAt: TEST_NOW,
    respawnAt: TEST_NOW + 25_000,
    createdAt: TEST_NOW,
  });

  store.saveFoundry({
    id: "millhaven",
    oreBuffer: { iron: 18 },
    activeVeinBatchId: "highland-ridge-vein-2",
    activeTraitId: "deep-vein",
    batchesRemaining: 12,
    expiresAt: TEST_NOW + 3_600_000,
    depletedPermille: 525,
    updatedAt: TEST_NOW + 1100,
  });
  store.saveFoundryCharWeight("millhaven", 10, "Alice", 60.5, 19675, 40);

  const openContract = store.insertContract({
    posterId: 10,
    posterName: "Alice",
    targetKind: "foundry",
    targetId: "millhaven",
    material: "iron",
    totalQty: 20,
    deliveredQty: 5,
    rewardPerUnit: 25,
    escrowTotal: 500,
    escrowRemaining: 375,
    feePaid: 10,
    status: "open",
    createdAt: TEST_NOW + 300,
    expiresAt: TEST_NOW + 86_400_000,
    updatedAt: TEST_NOW + 800,
  });
  const filledContract = store.insertContract({
    posterId: 11,
    posterName: "Bob",
    targetKind: "site",
    targetId: "redwater-bridge",
    material: "wood",
    totalQty: 10,
    deliveredQty: 10,
    rewardPerUnit: 12,
    escrowTotal: 120,
    escrowRemaining: 0,
    feePaid: 2,
    status: "filled",
    createdAt: TEST_NOW + 200,
    expiresAt: TEST_NOW + 86_400_000,
    updatedAt: TEST_NOW + 600,
  });

  store.addPendingCredits(77, 300, TEST_NOW + 1200);

  store.mintProvenance({
    veinBatchId: "oakhaven-surface-3",
    traitId: "bog-standard",
    townId: "oakhaven",
    crafterId: 11,
    crafterName: "Bob",
    eraTag: "Timber Foot-Scaffold",
    craftedAt: TEST_NOW + 400,
  });
  const minted2 = store.mintProvenance({
    veinBatchId: "highland-ridge-vein-2",
    traitId: "deep-vein",
    townId: "millhaven",
    crafterId: 10,
    crafterName: "Alice",
    eraTag: "Restored Cart Span",
    craftedAt: TEST_NOW + 1300,
  });
  const itemId = 42;
  store.bindItemProvenance(itemId, minted2.provenanceId);

  return {
    openContractId: openContract.id,
    filledContractId: filledContract.id,
    itemId,
    provenanceId: minted2.provenanceId,
  };
}

describe("Track B4: Civic Snapshot Recall & Shard Migration", () => {
  it("migrates all 10 tables cleanly across fresh SqliteCivicStore instances", () => {
    const src = new SqliteCivicStore(":memory:");
    const seeded = seedFullStore(src);

    const snap = exportCivicSnapshot(src, TEST_NOW + 2000);
    assert.equal(snap.schemaVersion, CIVIC_SNAPSHOT_VERSION);
    assert.deepEqual(CivicWorldSnapshotSchema.parse(snap), snap);

    const dst = new SqliteCivicStore(":memory:");
    const result = importCivicSnapshot(dst, snap);
    assert.equal(result.authoritative, false);
    assert.equal(result.totalRows, 17);
    assert.equal(result.appliedRows, 17);
    assert.deepEqual(allTableCounts(dst), allTableCounts(src));

    // Damaged bridge + partial repair progress + eraTag survived
    const bridge = dst.getSite("redwater-bridge")!;
    assert.equal(bridge.stage, 2);
    assert.equal(bridge.damaged, true);
    assert.equal(bridge.wear, 340);
    assert.deepEqual(bridge.progress, { wood: 14, stone: 7 });
    assert.deepEqual(bridge.repairProgress, { wood: 3, iron: 1 });
    assert.equal(bridge.repairGoldProgress, 4);
    assert.equal(bridge.eraTag, "Restored Cart Span");

    // Contributors + plaque history survived and AUTOINCREMENT advances cleanly
    assert.equal(dst.countContributors("redwater-bridge"), 2);
    assert.equal(dst.getContributor("redwater-bridge", 10)?.effectiveWeight, 125.5);
    const hist = dst.listHistory("redwater-bridge", 10, 0);
    assert.equal(hist.length, 3);
    assert.equal(hist[0]!.seq, 3);
    const nextHist = dst.appendHistory({
      siteId: "redwater-bridge",
      eventType: "repaired",
      actorId: 10,
      actorName: "Alice",
      eraTag: "Restored Cart Span",
      detail: "Post-migration repair plaque",
      createdAt: TEST_NOW + 3000,
    });
    assert.equal(nextHist.seq, 4);

    // Veins (including undiscovered privacy & depleted respawnAt) survived
    const hidden = dst.getVein("east-gorge-vein-1")!;
    assert.equal(hidden.discoveredByCharId, null);
    assert.equal(hidden.stock, 80);
    const active = dst.getVein("highland-ridge-vein-2")!;
    assert.equal(active.stock, 28);
    assert.equal(active.discoveredByName, "Alice");
    const depleted = dst.getVein("oakhaven-surface-3")!;
    assert.equal(depleted.stock, 0);
    assert.equal(depleted.respawnAt, TEST_NOW + 25_000);

    // Foundry & weights survived
    const foundry = dst.getFoundry("millhaven")!;
    assert.equal(foundry.activeTraitId, "deep-vein");
    assert.equal(foundry.batchesRemaining, 12);
    assert.equal(foundry.depletedPermille, 525);
    assert.deepEqual(foundry.oreBuffer, { iron: 18 });
    assert.equal(dst.getFoundryCharWeight("millhaven", 10)?.weight, 60.5);

    // Open contract escrow & filled contract survived; new contract autoincrement advances
    const open = dst.getContract(seeded.openContractId)!;
    assert.equal(open.status, "open");
    assert.equal(open.deliveredQty, 5);
    assert.equal(open.escrowRemaining, 375);
    const filled = dst.getContract(seeded.filledContractId)!;
    assert.equal(filled.status, "filled");
    assert.equal(filled.escrowRemaining, 0);
    const postMigContract = dst.insertContract({
      posterId: 10,
      posterName: "Alice",
      targetKind: "site",
      targetId: "redwater-bridge",
      material: "wood",
      totalQty: 5,
      deliveredQty: 0,
      rewardPerUnit: 10,
      escrowTotal: 50,
      escrowRemaining: 50,
      feePaid: 1,
      status: "open",
      createdAt: TEST_NOW + 3100,
      expiresAt: TEST_NOW + 90_000_000,
      updatedAt: TEST_NOW + 3100,
    });
    assert.ok(postMigContract.id > Math.max(seeded.openContractId, seeded.filledContractId));

    // Pending credits survived and claimable once on target shard
    assert.equal(dst.getPendingCredits(77), 300);
    assert.equal(dst.claimPendingCredits(77, TEST_NOW + 3200), 300);
    assert.equal(dst.getPendingCredits(77), 0);

    // Item provenance survived and binds cleanly to ItemService on target shard
    const prov = dst.getProvenanceByItemId(seeded.itemId)!;
    assert.equal(prov.provenanceId, seeded.provenanceId);
    assert.equal(prov.veinBatchId, "highland-ridge-vein-2");
    assert.equal(prov.traitId, "deep-vein");
    assert.equal(prov.townId, "millhaven");
    assert.equal(prov.crafterName, "Alice");

    const dir = mkdtempSync(join(tmpdir(), "mmo-b4-items-"));
    const { defs } = loadItemDefs(dir, loadRules(join(REPO, "content", "rules")));
    const items = new ItemService({
      defs,
      loot: {
        bagSlots: 20,
        ownershipSeconds: 30,
        despawnSeconds: 300,
        maxGroundItems: 64,
        pickupRange: 2.5,
        bagColumns: 5,
      },
      tickHz: 30,
      provenanceOf: (id) => dst.getProvenanceByItemId(id),
    });
    const swordDef = defs.ofBase("sword")[0]!;
    items.store.restore({
      id: seeded.itemId,
      kind: LedgerKind.Bag,
      def: swordDef,
      owner: 10,
      slot: 0,
      durability: 100,
      x: 0,
      z: 0,
      count: 1,
    });
    assert.equal(items.view(seeded.itemId).provenance?.veinBatchId, "highland-ridge-vein-2");
    assert.equal(items.view(seeded.itemId).provenance?.traitId, "deep-vein");
    assert.equal(items.moveItem(seeded.itemId, 10, 11), true);
    assert.equal(items.view(seeded.itemId).provenance?.townId, "millhaven");

    const nextProv = dst.mintProvenance({
      veinBatchId: "east-gorge-vein-1",
      traitId: "high-carbon",
      townId: "millhaven",
      crafterId: 10,
      crafterName: "Alice",
      eraTag: "Restored Cart Span",
      craftedAt: TEST_NOW + 3300,
    });
    assert.equal(nextProv.provenanceId, seeded.provenanceId + 1);

    src.close();
    dst.close();
  });

  it("handles empty snapshots safely and preserves idempotency across repeated imports", () => {
    const emptySrc = new SqliteCivicStore(":memory:");
    const emptySnap = exportCivicSnapshot(emptySrc, TEST_NOW);

    const emptyDst = new SqliteCivicStore(":memory:");
    const r0 = importCivicSnapshot(emptyDst, emptySnap);
    assert.equal(r0.totalRows, 0);
    assert.equal(r0.appliedRows, 0);
    assert.equal(tableCount(emptyDst, "civic_sites"), 0);

    const populated = new SqliteCivicStore(":memory:");
    seedFullStore(populated);
    const snap = exportCivicSnapshot(populated, TEST_NOW + 2000);
    const countsBefore = allTableCounts(populated);

    // Importing empty snapshot into populated store is a safe no-op
    importCivicSnapshot(populated, emptySnap);
    assert.deepEqual(allTableCounts(populated), countsBefore);

    // Importing same non-empty snapshot repeatedly never duplicates history, provenance, or rows
    const dst = new SqliteCivicStore(":memory:");
    importCivicSnapshot(dst, snap);
    const firstCounts = allTableCounts(dst);
    importCivicSnapshot(dst, snap);
    importCivicSnapshot(dst, snap);
    importCivicSnapshot(dst, snap, { authoritative: true });
    assert.deepEqual(allTableCounts(dst), firstCounts);
    assert.equal(firstCounts.civic_history, 3);
    assert.equal(firstCounts.civic_provenance, 2);
    assert.equal(firstCounts.civic_item_provenance, 1);

    emptySrc.close();
    emptyDst.close();
    populated.close();
    dst.close();
  });

  it("keeps newer monotonic timestamps by default and overwrites cleanly on authoritative recall", () => {
    const src = new SqliteCivicStore(":memory:");
    seedFullStore(src);
    const olderSnap = exportCivicSnapshot(src, TEST_NOW + 2000);

    const dst = new SqliteCivicStore(":memory:");
    importCivicSnapshot(dst, olderSnap);

    // Advance local state on dst past olderSnap timestamps
    dst.saveSite({
      ...dst.getSite("redwater-bridge")!,
      damaged: false,
      wear: 0,
      repairProgress: {},
      repairGoldProgress: 0,
      updatedAt: TEST_NOW + 99_000,
    });
    assert.equal(dst.claimPendingCredits(77, TEST_NOW + 99_000), 300);
    dst.upsertVein({
      ...dst.getVein("highland-ridge-vein-2")!,
      stock: 11,
    });

    // Default monotonic import must NOT regress repaired site, claimed credit, or extracted vein
    importCivicSnapshot(dst, olderSnap);
    assert.equal(dst.getSite("redwater-bridge")!.damaged, false);
    assert.equal(dst.getSite("redwater-bridge")!.wear, 0);
    assert.equal(dst.getPendingCredits(77), 0);
    assert.equal(dst.getVein("highland-ridge-vein-2")!.stock, 11);

    // Authoritative recall overwrites cleanly
    importCivicSnapshot(dst, olderSnap, { authoritative: true });
    assert.equal(dst.getSite("redwater-bridge")!.damaged, true);
    assert.equal(dst.getSite("redwater-bridge")!.wear, 340);
    assert.equal(dst.getPendingCredits(77), 300);
    assert.equal(dst.getVein("highland-ridge-vein-2")!.stock, 28);

    src.close();
    dst.close();
  });

  it("rejects malformed, partial, negative-escrow, and oversized snapshots without partial DB mutation", () => {
    const store = new SqliteCivicStore(":memory:");
    seedFullStore(store);
    const baseline = exportCivicSnapshot(store, TEST_NOW + 5000);

    const badPayloads: unknown[] = [
      null,
      "corrupt-string",
      42,
      {},
      // Partial snapshot missing required tables
      { schemaVersion: 1, civic_sites: baseline.civic_sites },
      // Wrong schema version
      { ...baseline, schemaVersion: 99 },
      // Extra unknown key (.strict())
      { ...baseline, unexpectedKey: true },
      // Negative contract escrow
      {
        ...baseline,
        civic_contracts: [
          { ...baseline.civic_contracts[0]!, escrowRemaining: -1 },
        ],
      },
      // Escrow remaining exceeding escrow total
      {
        ...baseline,
        civic_contracts: [
          { ...baseline.civic_contracts[0]!, escrowRemaining: 999_999 },
        ],
      },
      // Delivered qty exceeding total qty
      {
        ...baseline,
        civic_contracts: [
          { ...baseline.civic_contracts[0]!, deliveredQty: 999 },
        ],
      },
      // Negative pending credits
      {
        ...baseline,
        civic_pending_credits: [
          { charId: 77, amount: -50, updatedAt: TEST_NOW },
        ],
      },
      // Vein stock exceeding maxStock
      {
        ...baseline,
        civic_veins: [
          { ...baseline.civic_veins[0]!, stock: 999 },
        ],
      },
      // Non-finite wear
      {
        ...baseline,
        civic_sites: [
          { ...baseline.civic_sites[0]!, wear: Number.NaN },
        ],
      },
    ];

    for (const payload of badPayloads) {
      assert.throws(() => importCivicSnapshot(store, payload), z.ZodError);
      const after = exportCivicSnapshot(store, TEST_NOW + 5000);
      assert.deepEqual(after, baseline, "rejected snapshot must not mutate any table");
    }

    // Oversized snapshot (> MAX_CIVIC_SNAPSHOT_BYTES)
    const bigHistory = Array.from({ length: 5000 }, (_, i) => ({
      seq: i + 100,
      siteId: "redwater-bridge",
      eventType: "contributed" as const,
      actorId: 10,
      actorName: "Alice",
      eraTag: "Restored Cart Span",
      detail: "D".repeat(480),
      createdAt: TEST_NOW + i,
    }));
    const oversized = { ...baseline, civic_history: bigHistory };
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > MAX_CIVIC_SNAPSHOT_BYTES);
    assert.throws(() => importCivicSnapshot(store, oversized), z.ZodError);
    assert.deepEqual(exportCivicSnapshot(store, TEST_NOW + 5000), baseline);

    store.close();
  });
});

describe("Track B4: World-Server Atomic Craft & Loot Provenance", () => {
  it("validates optional provenance on CraftExecute & LootGrant and preserves it across trade/mutate", async (t) => {
    const apiKey = "fleet-prov-key";
    const worldStore = new MemoryWorldStore();
    const core = new WorldCoreImpl({
      store: worldStore,
      heartbeatTimeoutMs: 60_000,
      heartbeatIntervalMs: 60_000,
      apiKeyHash: await argon2.hash(apiKey),
    });

    const app = express();
    app.use(createWebrpcRouter(core));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const rpc = async (method: string, body: unknown, token?: string) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${base}/rpc/World/${method}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    const reg = await rpc("RegisterRegion", {
      input: {
        regionId: "r1",
        chunkRange: { x0: 0, x1: 100, z0: 0, z1: 100 },
        endpoint: "ws://localhost:7777",
        capacity: 100,
        apiKey,
        opId: "reg-r1",
      },
    });
    assert.equal(reg.status, 200);
    const token = (reg.json["lease"] as { token: string }).token;

    const lock1 = await rpc(
      "AcquireCharacterLock",
      { input: { regionId: "r1", characterId: 1, ttlMs: 60_000, opId: "lock-1" } },
      token,
    );
    const lock2 = await rpc(
      "AcquireCharacterLock",
      { input: { regionId: "r1", characterId: 2, ttlMs: 60_000, opId: "lock-2" } },
      token,
    );
    const epoch1 = (lock1.json["lock"] as { epoch: number }).epoch;
    const epoch2 = (lock2.json["lock"] as { epoch: number }).epoch;

    await rpc(
      "PutCharacterState",
      {
        input: {
          regionId: "r1",
          characterId: 1,
          epoch: epoch1,
          state: { gold: 100, inventory: [] },
          opId: "seed-1",
        },
      },
      token,
    );
    await rpc(
      "PutCharacterState",
      {
        input: {
          regionId: "r1",
          characterId: 2,
          epoch: epoch2,
          state: { gold: 50, inventory: [] },
          opId: "seed-2",
        },
      },
      token,
    );

    const provenance = {
      veinBatchId: "highland-ridge-vein-2",
      traitId: "deep-vein",
      townId: "millhaven",
      crafterId: 1,
      crafterName: "Forgeon",
      eraTag: "Restored Cart Span",
      craftedAt: TEST_NOW + 500,
    };

    // 1. Craft with provenance
    const craftPayload = {
      regionId: "r1",
      opId: "craft-prov-1",
      participant: { characterId: 1, epoch: epoch1, expectedVersion: 1 },
      consumes: [],
      goldFee: 10,
      outputs: [{ instanceId: "blade-1", def: 12, provenance }],
    };
    assert.equal(CraftExecuteSchema.safeParse(craftPayload).success, true);
    const craftRes = await rpc("CraftExecute", { input: craftPayload }, token);
    assert.equal(craftRes.status, 200);
    const craftResult = craftRes.json["result"] as {
      ok: boolean;
      ledger: Array<{ kind: string; instanceId?: string; provenance?: typeof provenance }>;
    };
    assert.equal(craftResult.ok, true);
    assert.deepEqual(craftResult.ledger[0]?.provenance, provenance);

    // 2. LootGrant without provenance (100% backward-compatible: no provenance key)
    const plainLootPayload = {
      regionId: "r1",
      opId: "loot-plain-1",
      participant: { characterId: 1, epoch: epoch1, expectedVersion: 2 },
      sourceId: "loot:boar-1",
      instanceId: "hide-1",
      def: 3,
    };
    assert.equal(LootGrantSchema.safeParse(plainLootPayload).success, true);
    const plainLootRes = await rpc("LootGrant", { input: plainLootPayload }, token);
    assert.equal(plainLootRes.status, 200);

    // 3. LootGrant with provenance
    const provLootPayload = {
      regionId: "r1",
      opId: "loot-prov-1",
      participant: { characterId: 1, epoch: epoch1, expectedVersion: 3 },
      sourceId: "loot:foundry-relic",
      instanceId: "relic-1",
      def: 99,
      provenance,
    };
    const provLootRes = await rpc("LootGrant", { input: provLootPayload }, token);
    assert.equal(provLootRes.status, 200);

    const recAfterLoot = await worldStore.getCharacterState(1);
    const inv1 = (recAfterLoot?.state as { inventory: Array<InventoryItem & { provenance?: unknown }> }).inventory;
    const craftedItem = inv1.find((i) => i.instanceId === "blade-1")!;
    const plainItem = inv1.find((i) => i.instanceId === "hide-1")!;
    const relicItem = inv1.find((i) => i.instanceId === "relic-1")!;
    assert.deepEqual(craftedItem.provenance, provenance);
    assert.equal("provenance" in plainItem, false, "backward-compatible items carry no extra provenance property");
    assert.deepEqual(relicItem.provenance, provenance);

    // 4. Move inside bag + trade to char 2 -> provenance survives intact!
    const moveRes = await rpc(
      "InventoryMutate",
      {
        input: {
          regionId: "r1",
          opId: "move-prov-1",
          participant: { characterId: 1, epoch: epoch1, expectedVersion: 4 },
          mutations: [{ kind: "move", instanceId: "blade-1", toSlot: 9 }],
        },
      },
      token,
    );
    assert.equal(moveRes.status, 200);

    const tradeRes = await rpc(
      "TradeCommit",
      {
        input: {
          regionId: "r1",
          opId: "trade-prov-1",
          a: { characterId: 1, epoch: epoch1, expectedVersion: 5 },
          b: { characterId: 2, epoch: epoch2, expectedVersion: 1 },
          aGivesGold: 0,
          bGivesGold: 25,
          aGivesItems: ["blade-1"],
          bGivesItems: [],
        },
      },
      token,
    );
    assert.equal(tradeRes.status, 200);
    const char2State = await worldStore.getCharacterState(2);
    const inv2 = (char2State?.state as { inventory: Array<InventoryItem & { provenance?: unknown }> }).inventory;
    assert.equal(inv2.length, 1);
    assert.equal(inv2[0]!.instanceId, "blade-1");
    assert.deepEqual(inv2[0]!.provenance, provenance);

    // 5. Reject malformed provenance at Zod + webrpc boundary
    const badCrafts = [
      // Missing required eraTag
      {
        ...craftPayload,
        opId: "bad-prov-1",
        outputs: [{ instanceId: "x-1", def: 12, provenance: { ...provenance, eraTag: undefined } }],
      },
      // Negative craftedAt
      {
        ...craftPayload,
        opId: "bad-prov-2",
        outputs: [{ instanceId: "x-2", def: 12, provenance: { ...provenance, craftedAt: -5 } }],
      },
      // Negative crafterId
      {
        ...craftPayload,
        opId: "bad-prov-3",
        outputs: [{ instanceId: "x-3", def: 12, provenance: { ...provenance, crafterId: -1 } }],
      },
      // Unknown extra field inside provenance
      {
        ...craftPayload,
        opId: "bad-prov-4",
        outputs: [{ instanceId: "x-4", def: 12, provenance: { ...provenance, extra: "nope" } }],
      },
    ];
    for (const bad of badCrafts) {
      assert.equal(CraftExecuteSchema.safeParse(bad).success, false);
      const wire = await rpc("CraftExecute", { input: bad }, token);
      assert.equal(wire.status, 400);
    }
    const badLoot = {
      ...provLootPayload,
      opId: "bad-loot-prov",
      provenance: { ...provenance, veinBatchId: "" },
    };
    assert.equal(LootGrantSchema.safeParse(badLoot).success, false);
    assert.equal((await rpc("LootGrant", { input: badLoot }, token)).status, 400);
  });
});

describe("Track C7a: Zero-Alloc CivicTelemetryMetrics SAB Gauges", () => {
  it("backs gauges with a 64-byte SharedArrayBuffer readable across threads and validates header", () => {
    const writer = new CivicTelemetryMetrics();
    assert.ok(writer.sab instanceof SharedArrayBuffer);
    assert.equal(writer.sab.byteLength, CIVIC_METRICS_BYTES);
    assert.equal(CIVIC_METRICS_BYTES, 64);

    const reader = new CivicTelemetryMetrics(writer.sab);
    writer.recordSweep(4, 9, 2, 185.5, 1, 42.25);

    assert.equal(reader.activeVeins, 4);
    assert.equal(reader.openContracts, 9);
    assert.equal(reader.bridgeStage, 2);
    assert.equal(reader.bridgeWear, 185.5);
    assert.equal(reader.matureFoundries, 1);
    assert.equal(reader.lastSweepMicros, 42.25);
    assert.equal(reader.sweepCount, 1);

    assert.deepEqual(reader.snapshot(), {
      activeVeins: 4,
      openContracts: 9,
      bridgeStage: 2,
      bridgeWear: 185.5,
      matureFoundries: 1,
      lastSweepMicros: 42.25,
      sweepCount: 1,
    });

    // Zero-alloc snapshot(out) reuses caller buffer in place
    const reused: CivicTelemetrySnapshot = {
      activeVeins: 0,
      openContracts: 0,
      bridgeStage: 0,
      bridgeWear: 0,
      matureFoundries: 0,
      lastSweepMicros: 0,
      sweepCount: 0,
    };
    const sameRef = reader.snapshot(reused);
    assert.equal(sameRef, reused);
    assert.equal(reused.activeVeins, 4);
    assert.equal(reused.sweepCount, 1);

    // Invalid SAB attachments throw cleanly
    assert.throws(() => new CivicTelemetryMetrics(new SharedArrayBuffer(16)), RangeError);
    assert.throws(() => new CivicTelemetryMetrics(new SharedArrayBuffer(64)), /invalid magic/);
  });

  it("clamps invalid/negative/overflow values and renders mergeable Prometheus exposition", () => {
    const m = new CivicTelemetryMetrics();
    m.recordSweep(-5, Number.NaN, Number.POSITIVE_INFINITY, -12.3, 1e12, -0.5);
    assert.deepEqual(m.snapshot(), {
      activeVeins: 0,
      openContracts: 0,
      bridgeStage: 0,
      bridgeWear: 0,
      matureFoundries: 0x7fffffff,
      lastSweepMicros: 0,
      sweepCount: 1,
    });

    m.recordSweep(3, 5, 2, 120, 2, 19.5);
    const prom = m.renderPrometheusMetrics();
    assert.match(prom, /# TYPE mmo_civic_active_veins gauge\nmmo_civic_active_veins 3\n/);
    assert.match(prom, /# TYPE mmo_civic_open_contracts gauge\nmmo_civic_open_contracts 5\n/);
    assert.match(prom, /# TYPE mmo_civic_bridge_stage gauge\nmmo_civic_bridge_stage 2\n/);
    assert.match(prom, /# TYPE mmo_civic_bridge_wear gauge\nmmo_civic_bridge_wear 120\n/);
    assert.match(prom, /# TYPE mmo_civic_mature_foundries gauge\nmmo_civic_mature_foundries 2\n/);
    assert.match(prom, /# TYPE mmo_civic_sweep_duration_micros gauge\nmmo_civic_sweep_duration_micros 19.5\n/);
    assert.match(prom, /# TYPE mmo_civic_sweeps_total counter\nmmo_civic_sweeps_total 2\n/);

    // Merges cleanly with LogMetricsPage exposition
    const logPage = new LogMetricsPage();
    const merged = mergeExpositions(logPage.renderLogMetrics(), prom);
    assert.match(merged, /mmo_log_records_total/);
    assert.match(merged, /mmo_civic_sweeps_total 2/);
  });

  it("executes 100k recordSweep calls within tight latency/allocation bounds and AGENTS.md §6 invariants", () => {
    const srcPath = join(REPO, "packages", "engine-core", "src", "logging", "civic-metrics.ts");
    const src = readFileSync(srcPath, "utf8");
    const recordStart = src.indexOf("public recordSweep(");
    const recordEnd = src.indexOf("public get activeVeins", recordStart);
    assert.ok(recordStart >= 0 && recordEnd > recordStart);
    const recordBody = src.slice(recordStart, recordEnd);

    // AGENTS.md §6: zero clock syscalls, zero rest params, zero closures, zero console
    assert.equal(/performance\.now|Date\.now|hrtime/.test(recordBody), false);
    assert.equal(/\.\.\./.test(recordBody), false);
    assert.equal(/=>/.test(recordBody), false);
    assert.equal(/console\./.test(src), false);

    const m = new CivicTelemetryMetrics();
    const reusable: CivicTelemetrySnapshot = {
      activeVeins: 0,
      openContracts: 0,
      bridgeStage: 0,
      bridgeWear: 0,
      matureFoundries: 0,
      lastSweepMicros: 0,
      sweepCount: 0,
    };

    // JIT warmup
    for (let i = 0; i < 10_000; i++) {
      m.recordSweep(2, 3, 1, 100, 1, 12);
    }

    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      m.recordSweep(i & 7, i & 15, i & 3, i & 511, i & 1, 8.5);
    }
    const elapsedMs = performance.now() - t0;
    gc?.();
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;

    assert.equal(m.sweepCount, 110_000);
    assert.ok(elapsedMs < 250, `100k recordSweep calls took ${elapsedMs.toFixed(2)}ms (expected < 250ms)`);
    const maxAllowedBytes = gc ? 64 * 1024 : 2 * 1024 * 1024;
    assert.ok(
      heapDelta < maxAllowedBytes,
      `heap grew by ${heapDelta} bytes over 100k recordSweep calls (limit ${maxAllowedBytes})`,
    );

    m.snapshot(reusable);
    assert.equal(reusable.sweepCount, 110_000);
  });
});
