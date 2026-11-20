/**
 * Track C7b — End-to-End Live WebSocket Loopback Verification for Redwater Crossing:
 * Boots a real Gateway on loopback port 0 with real SimWorld, MemoryCharacterStore,
 * ItemService (setTraitDefs + provenance lookup), CombatSystem + StaminaSystem + DuelSystem,
 * GatheringSystem, WalletSystem, modules/civic/server.js (SqliteCivicStore + CivicService),
 * CivicWorldBridge, CivicTelemetryMetrics, and makeHealthHttpHandler.
 *
 * Plays through the full vertical slice using real MirrorClients over WebSocket:
 *   survey (bearing) -> move -> survey (pinpoint) -> extract ->
 *   bridge Stage 0->2 (removing CivicWorldBridge static barrier) ->
 *   foundry_supply -> foundry_craft (ItemView.provenance + combat damage bonus) ->
 *   contract_post -> disconnect -> TTL expiry sweep -> reconnect pendingCreditsClaimed ->
 *   HTTP GET /health (200 ok) & GET /metrics/civic (Prometheus gauges).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent, hasComponent } from "bitecs";
import WebSocket from "ws";
import { MirrorClient, type MirrorEvents, type SocketLike } from "@mmo-engine/mirror";
import {
  IntentButton,
  type CivicServerMessage,
  type ErrorMessage,
  type HitMessage,
  type InventoryMessage,
  type WalletMessage,
} from "@mmo-engine/protocol";
import { DEFAULT_CIVIC_RULES, createHooks, engineDefaults } from "@mmo-engine/rules";
import { MemoryCharacterStore } from "../../src/characters/index.js";
import {
  CivicService,
  CivicWorldBridge,
  SqliteCivicStore,
} from "../../src/civic/index.js";
import * as C from "../../src/components.js";
import { WalletSystem } from "../../src/economy/wallet.js";
import { GatheringSystem } from "../../src/gathering/index.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";
import { CivicTelemetryMetrics } from "../../src/logging/index.js";
import { Gateway } from "../../src/net/gateway.js";
import { makeHealthHttpHandler } from "../../src/net/health.js";
import { SimWorld } from "../../src/world.js";
import { makeCredentialStore, TEST_PASSWORD } from "../net/auth-harness.js";
// @ts-expect-error: plain JS module outside the TS project
import { createSystems as createCombatSystems } from "../../../../../modules/combat/server.js";
// @ts-expect-error: plain JS module outside the TS project
import { createSystems as createCivicSystems, dispose as disposeCivicModule } from "../../../../../modules/civic/server.js";

const LOOK = '{"gender":"male","parts":{"head":"Chr_Head_Male_03"},"colours":{}}';

function makeWsSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const sock: SocketLike = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data: Uint8Array) {
      ws.send(data);
    },
    close() {
      ws.close();
    },
  };
  ws.onopen = () => sock.onopen?.();
  ws.onmessage = (ev) => {
    const d = ev.data;
    if (d instanceof ArrayBuffer) {
      sock.onmessage?.(new Uint8Array(d));
    } else if (ArrayBuffer.isView(d)) {
      sock.onmessage?.(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    }
  };
  ws.onerror = (ev) => sock.onerror?.(ev);
  ws.onclose = () => sock.onclose?.();
  return sock;
}

interface TrackedMirrorClient {
  client: MirrorClient;
  civicMsgs: CivicServerMessage[];
  invMsgs: InventoryMessage[];
  hitMsgs: HitMessage[];
  walletMsgs: WalletMessage[];
  errors: ErrorMessage[];
  waitCivic<T extends CivicServerMessage>(
    pred: (m: CivicServerMessage) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
  waitInventory(pred: (inv: InventoryMessage) => boolean, timeoutMs?: number): Promise<InventoryMessage>;
  waitHit(pred: (hit: HitMessage) => boolean, timeoutMs?: number): Promise<HitMessage>;
  waitWallet(pred: (w: WalletMessage) => boolean, timeoutMs?: number): Promise<WalletMessage>;
}

function createTrackedClient(
  url: string,
  username: string,
  clientName: string,
): { tracked: TrackedMirrorClient; connectPromise: Promise<void> } {
  const civicMsgs: CivicServerMessage[] = [];
  const invMsgs: InventoryMessage[] = [];
  const hitMsgs: HitMessage[] = [];
  const walletMsgs: WalletMessage[] = [];
  const errors: ErrorMessage[] = [];
  const civicWaiters: Array<() => void> = [];
  const invWaiters: Array<() => void> = [];
  const hitWaiters: Array<() => void> = [];
  const walletWaiters: Array<() => void> = [];

  const events: MirrorEvents = {
    onWelcome() {},
    onState() {},
    onError(e) {
      errors.push(e);
    },
    onClose() {},
    onCivic(msg) {
      civicMsgs.push(msg);
      for (const wake of civicWaiters.splice(0)) wake();
    },
    onInventory(inv) {
      invMsgs.push(inv);
      for (const wake of invWaiters.splice(0)) wake();
    },
    onHit(hit) {
      hitMsgs.push(hit);
      for (const wake of hitWaiters.splice(0)) wake();
    },
    onWallet(w) {
      walletMsgs.push(w);
      for (const wake of walletWaiters.splice(0)) wake();
    },
  };

  const client = new MirrorClient(makeWsSocket, events);

  function waitQueue<M>(
    list: M[],
    waiters: Array<() => void>,
    pred: (m: M) => boolean,
    label: string,
    timeoutMs = 3000,
  ): Promise<M> {
    const existing = list.find(pred);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<M>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${label}; saw ${JSON.stringify(list.slice(-4))}`));
      }, timeoutMs);
      const check = (): void => {
        const hit = list.find(pred);
        if (hit !== undefined) {
          clearTimeout(timer);
          resolve(hit);
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  }

  const tracked: TrackedMirrorClient = {
    client,
    civicMsgs,
    invMsgs,
    hitMsgs,
    walletMsgs,
    errors,
    waitCivic<T extends CivicServerMessage>(
      pred: (m: CivicServerMessage) => m is T,
      timeoutMs = 3000,
    ): Promise<T> {
      return waitQueue(civicMsgs, civicWaiters, pred, "civic message", timeoutMs) as Promise<T>;
    },
    waitInventory(pred, timeoutMs = 3000) {
      return waitQueue(invMsgs, invWaiters, pred, "inventory message", timeoutMs);
    },
    waitHit(pred, timeoutMs = 3000) {
      return waitQueue(hitMsgs, hitWaiters, pred, "hit message", timeoutMs);
    },
    waitWallet(pred, timeoutMs = 3000) {
      return waitQueue(walletMsgs, walletWaiters, pred, "wallet message", timeoutMs);
    },
  };

  const connectPromise = client.connect(url, clientName, { username, password: TEST_PASSWORD }).then(() => {});
  return { tracked, connectPromise };
}

describe("Track C7b: End-to-End Civic & Provenance Live WebSocket Slice", () => {
  let tmpDir: string | null = null;
  let gw: Gateway | null = null;
  let civicCtx: { stores?: Record<string, unknown> } | null = null;
  const openClients: MirrorClient[] = [];

  afterEach(async () => {
    for (const c of openClients.splice(0)) {
      try {
        c.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (gw) {
      await gw.close();
      gw = null;
    }
    if (civicCtx) {
      disposeCivicModule(civicCtx);
      civicCtx = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("executes survey -> bridge restore -> provenance craft & combat -> offline escrow -> /metrics/civic over real MirrorClients", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mmo-civic-e2e-"));
    let now = 1_700_000_000_000;
    const sim = new SimWorld();

    const rules = engineDefaults();
    rules.items.bases.sword = {
      ...rules.items.fallback,
      mass: 1.3,
      length: 0.9,
      edge: 0.9,
      point: 0.8,
      hardness: 0.9,
      hand: "main",
      technique: "cut",
      models: ["pack/SM_Wep_Sword_01"],
    };

    const POOL: PoolItemLike[] = [
      {
        id: "iron-sword",
        rank: "common",
        source: "craft",
        item: "sword",
        seed: 1,
        bundle: {
          Identity: { id: "iron-sword", name: "Iron Sword", base: "sword" },
          Rank: { id: "common", color: "#aaaaaa" },
          Stats: { power: 10 },
        },
      },
      {
        id: "plain-sword",
        rank: "common",
        source: "drop",
        item: "sword",
        seed: 2,
        bundle: {
          Identity: { id: "plain-sword", name: "Plain Sword", base: "sword" },
          Rank: { id: "common", color: "#aaaaaa" },
          Stats: { power: 10 },
        },
      },
    ];

    const items = new ItemService({
      defs: new ItemDefs(POOL, rules),
      loot: rules.loot,
      tickHz: 30,
    });
    const wallet = new WalletSystem();
    const gathering = new GatheringSystem({ now: () => now, cooldownMs: 0 });
    const characterStore = new MemoryCharacterStore();
    const aliceRec = await characterStore.create("alice", "Alice", LOOK, 8);
    const bobRec = await characterStore.create("user-b", "Bob", LOOK, 8);

    // Clone civic rules and constrain east-gorge-vein to high-carbon so combat math stays deterministic
    const civicRules = structuredClone(DEFAULT_CIVIC_RULES);
    const eastGorge = civicRules.veins.find((v) => v.id === "east-gorge-vein");
    assert.ok(eastGorge, "DEFAULT_CIVIC_RULES must define east-gorge-vein");
    eastGorge.isBaseline = false;
    eastGorge.traitPool = ["high-carbon"];
    civicRules.veins = [eastGorge];
    civicRules.surveying.minActivePerRegion = 1;

    const metrics = new CivicTelemetryMetrics();
    const bridge = new CivicWorldBridge({ sim, rules: civicRules });

    let civicSvc!: CivicService;
    const ctx: {
      sim: SimWorld;
      log: (m: string) => void;
      stores: Record<string, unknown>;
      config: Record<string, Record<string, unknown>>;
    } = {
      sim,
      log: () => {},
      stores: { wallet },
      config: {
        civic: {
          dataDir: tmpDir,
          rules: civicRules,
          now: () => now,
          sweepEveryTicks: 1,
          dayOf: (ms: number) => Math.floor(ms / 86_400_000),
          countMaterial: (charId: number, mat: string) => gathering.countOf(charId, mat),
          takeMaterial: (charId: number, mat: string, qty: number) => gathering.take(charId, mat, qty),
          grantMaterial: (charId: number, mat: string, qty: number) => gathering.grant(charId, mat, qty),
          hasMaterialRoom: (charId: number, mat: string, qty: number) => gathering.hasRoom(charId, mat, qty),
          hasBagRoom: () => true,
          craftAndGrantItem: (charId: number, item: string, rank: string) => {
            const d = items.defs;
            const def = d.ofBase(item).find((i) => d.ranks[i] === rank) ?? -1;
            if (def < 0) return null;
            const res = items.give(charId, def);
            return res.ok ? (res.itemId ?? null) : null;
          },
          ownsItem: (charId: number, itemId: number) => items.store.inBagOf(charId, itemId),
          onSiteStateChange: (siteId: string, stage: number, damaged: boolean) => {
            bridge.syncSite(siteId, stage, damaged);
          },
          metrics,
        },
      },
    };
    civicCtx = ctx;

    const civicMod = createCivicSystems(ctx) as { civic: CivicService };
    civicSvc = civicMod.civic;
    const civicStore = ctx.stores.civicStore as SqliteCivicStore;

    // Wire Track A1 trait definitions + provenance lookup & Track A2 initial bridge sync
    items.setTraitDefs(civicRules.traits);
    items.setProvenanceLookup((id) => civicSvc.provenanceOf(id));
    bridge.syncAll(civicStore.listSites());

    const combatSys = createCombatSystems({
      sim,
      config: {
        combat: {
          rules,
          hooks: createHooks(rules),
          combatSkills: {
            get: () => 0,
            train() {},
            techniqueSkill: () => undefined,
            familiarity: () => 0,
            useFamily() {},
            knows: () => false,
          },
          getWeaponOf: (e: number) =>
            hasComponent(sim.ecs, C.CharacterRef, e)
              ? items.weaponForCharacter(C.CharacterRef.idHi[e]! * 4294967296 + C.CharacterRef.idLo[e]!)
              : null,
          getWornFactor: () => 1,
          getCreaturesPlace: () => false,
          getGateway: () => gw,
          getRespawnSeconds: () => 10,
          getDropper: () => null,
          getQuests: () => null,
          getKindOf: () => undefined,
          getCombatTuning: () => ({
            resolution: rules.combat.resolution,
            unarmed: rules.items.unarmed,
          }),
        },
      },
      log() {},
    }) as Record<string, { step(s: SimWorld, dt: number): void }>;

    gw = new Gateway({
      port: 0,
      clock: () => now,
      world: sim,
      disconnectGraceMs: 250,
      credentialStore: await makeCredentialStore(),
      characterStore,
      items,
      http: makeHealthHttpHandler({
        renderCivicMetrics: () => metrics.renderPrometheusMetrics(),
      }),
      systems: [
        items,
        wallet,
        gathering,
        combatSys.stamina as never,
        combatSys.body as never,
        combatSys.magic as never,
        combatSys.abilities as never,
        combatSys.status as never,
        combatSys.telegraphs as never,
        combatSys.duels as never,
        combatSys.combat as never,
        combatSys.death as never,
        civicSvc,
      ],
      extensions: [civicSvc],
    });

    const port = await gw.listen();
    const url = `ws://127.0.0.1:${port}`;
    gw.frame(now);

    async function pumpFrames(count = 3, delayMs = 20): Promise<void> {
      await new Promise((r) => setTimeout(r, delayMs));
      for (let i = 0; i < count; i++) {
        now += 34;
        gw!.frame(now);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // 1. Connect real MirrorClients (Alice & Bob)
    const aliceConn = createTrackedClient(url, "alice", "alice-mirror");
    await aliceConn.connectPromise;
    const alice = aliceConn.tracked;
    openClients.push(alice.client);

    const bobConn = createTrackedClient(url, "user-b", "bob-mirror");
    await bobConn.connectPromise;
    const bob = bobConn.tracked;
    openClients.push(bob.client);

    const aliceInit = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "state" }> => m.op === "state",
    );
    assert.equal(aliceInit.sites[0]!.stage, 0);
    assert.equal(aliceInit.veins.length, 0, "undiscovered east-gorge-vein stays hidden at join");

    // Stage 0 gorge barrier must start armed
    assert.equal(bridge.isBlocked("redwater-bridge"), true);
    const bridgeEntities0 = bridge.entitiesOf("redwater-bridge")!;
    assert.equal(C.AssetRef.variant[bridgeEntities0.deckEid], 0);
    assert.equal(hasComponent(sim.ecs, C.BodyConfig, bridgeEntities0.barrierEid), true);

    const aliceEid = sim.resolveWireId(alice.client.playerEntity!);
    const bobEid = sim.resolveWireId(bob.client.playerEntity!);
    addComponent(sim.ecs, C.Transform, aliceEid);
    addComponent(sim.ecs, C.Transform, bobEid);
    C.Transform.px[aliceEid] = 0;
    C.Transform.pz[aliceEid] = 0;
    C.Transform.px[bobEid] = 1;
    C.Transform.pz[bobEid] = 0;

    // 2. Survey (bearing) -> move inside pinpointRadius -> survey (pinpoint) -> extract high-carbon iron
    alice.client.civic({ kind: "civic", op: "survey" });
    const farSurvey = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "survey_result" }> =>
        m.op === "survey_result" && m.band !== "pinpoint",
    );
    assert.equal(farSurvey.veinBatchId, undefined, "distant survey must not leak veinBatchId");

    const activeVein = civicStore.listVeins(true)[0]!;
    now += 3500; // past surveyCooldownMs
    C.Transform.px[aliceEid] = activeVein.x + 2;
    C.Transform.pz[aliceEid] = activeVein.z;
    alice.client.civic({ kind: "civic", op: "survey" });
    const pinpoint = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "survey_result" }> =>
        m.op === "survey_result" && m.band === "pinpoint",
    );
    assert.equal(pinpoint.newlyDiscovered, true);
    assert.equal(pinpoint.traitId, "high-carbon");
    const veinBatchId = pinpoint.veinBatchId!;

    // Mine 45 iron in bounded batches respecting maxExtractQtyPerCall (5)
    for (let i = 0; i < 9; i++) {
      const beforeIdx = alice.civicMsgs.length;
      now += 600;
      alice.client.civic({ kind: "civic", op: "extract", veinBatchId, qty: 5 });
      const extracted = await alice.waitCivic(
        (m): m is Extract<CivicServerMessage, { op: "extracted" }> =>
          m.op === "extracted" && alice.civicMsgs.indexOf(m) >= beforeIdx,
      );
      assert.equal(extracted.material, "iron");
      assert.equal(extracted.qty, 5);
    }
    assert.equal(gathering.countOf(aliceRec.id, "iron"), 45);

    // 3. Bridge restoration Stage 0 -> 2 over live wire, disarming CivicWorldBridge barrier
    const bridgeDef = civicRules.sites[0]!;
    const stage1Def = bridgeDef.stages.find((s) => s.stage === 1)!;
    const stage2Def = bridgeDef.stages.find((s) => s.stage === 2)!;
    C.Transform.px[aliceEid] = bridgeDef.x;
    C.Transform.pz[aliceEid] = bridgeDef.z;
    for (const [mat, qty] of Object.entries(stage1Def.requirements)) {
      gathering.grant(aliceRec.id, mat, qty);
    }
    for (const [mat, qty] of Object.entries(stage2Def.requirements)) {
      gathering.grant(aliceRec.id, mat, qty);
    }
    wallet.grant(aliceRec.id, stage1Def.goldCost + stage2Def.goldCost + 2000, sim.currentTick);

    alice.client.civic({
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "e2e-stage-1",
      materials: stage1Def.requirements,
      gold: stage1Def.goldCost,
    });
    const contrib1 = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "contributed" }> =>
        m.op === "contributed" && m.stage === 1,
    );
    assert.equal(contrib1.stageAdvanced, true);

    alice.client.civic({
      kind: "civic",
      op: "contribute",
      siteId: "redwater-bridge",
      opId: "e2e-stage-2",
      materials: stage2Def.requirements,
      gold: stage2Def.goldCost,
    });
    const contrib2 = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "contributed" }> =>
        m.op === "contributed" && m.stage === 2,
    );
    assert.equal(contrib2.stageAdvanced, true);
    assert.equal(bridge.isBlocked("redwater-bridge"), false, "Stage 2 must open the gorge barrier");
    assert.equal(C.AssetRef.variant[bridgeEntities0.deckEid], 2);
    assert.equal(hasComponent(sim.ecs, C.BodyConfig, bridgeEntities0.barrierEid), false);

    // 4. Baseline sword vs Millhaven high-carbon provenance sword in live duel
    const plainDef = items.defs.indexOf("plain-sword");
    assert.ok(plainDef >= 0);
    const plainGive = items.give(aliceRec.id, plainDef);
    assert.equal(plainGive.ok, true);
    const plainSwordId = plainGive.itemId!;
    await pumpFrames(2);

    const equipPlainP = alice.waitInventory((inv) => inv.main?.id === plainSwordId);
    alice.client.equip(plainSwordId);
    await pumpFrames(2);
    await equipPlainP;
    const baseWeapon = items.weaponForCharacter(aliceRec.id);
    assert.ok(baseWeapon);

    C.Transform.px[aliceEid] = 0;
    C.Transform.pz[aliceEid] = 0;
    C.Transform.px[bobEid] = 1;
    C.Transform.pz[bobEid] = 0;
    alice.client.duel("challenge", bob.client.playerEntity!.toString());
    await pumpFrames(3);
    bob.client.duel("accept");
    await pumpFrames(3);

    alice.client.stance("cut", "torso");
    await pumpFrames(2);

    const bobHpBeforeBase = C.Health.current[bobEid]!;
    const baseHitP = alice.waitHit((h) => h.target === bob.client.playerEntity!.toString());
    alice.client.sendIntent({
      mx: 0,
      my: 0,
      mz: 0,
      lookYaw: Math.PI / 2,
      lookPitch: 0,
      jump: false,
      buttons: IntentButton.Attack,
    });
    await pumpFrames(12, 15);
    const baseHit = await baseHitP;
    const baseDmg = bobHpBeforeBase - C.Health.current[bobEid]!;
    assert.ok(baseHit.amount > 0 && baseDmg > 0, `baseline sword hit must deal positive damage (${baseDmg})`);

    // Release attack button, finish recovery window & restore Bob health/coords
    alice.client.sendIntent({
      mx: 0,
      my: 0,
      mz: 0,
      lookYaw: Math.PI / 2,
      lookPitch: 0,
      jump: false,
      buttons: 0,
    });
    await pumpFrames(50, 5);
    C.Health.current[bobEid] = C.Health.max[bobEid]!;
    C.Transform.px[bobEid] = 1;
    C.Transform.pz[bobEid] = 0;

    // Move Alice to Millhaven foundry -> supply 40 high-carbon iron -> craft provenance sword
    const millhaven = civicRules.foundries.find((f) => f.id === "millhaven")!;
    assert.ok(millhaven);
    C.Transform.px[aliceEid] = millhaven.x;
    C.Transform.pz[aliceEid] = millhaven.z;

    alice.client.civic({
      kind: "civic",
      op: "foundry_supply",
      townId: "millhaven",
      opId: "e2e-supply",
      veinBatchId,
      material: "iron",
      qty: 40,
    });
    const foundryUpd = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "foundry_updated" }> =>
        m.op === "foundry_updated" && m.specialized === true,
    );
    assert.equal(foundryUpd.foundry.activeTraitId, "high-carbon");

    alice.client.civic({
      kind: "civic",
      op: "foundry_craft",
      townId: "millhaven",
      opId: "e2e-craft",
      item: "sword",
      rank: "common",
    });
    const crafted = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "foundry_crafted" }> => m.op === "foundry_crafted",
    );
    assert.equal(crafted.provenance.traitId, "high-carbon");
    assert.equal(crafted.provenance.townId, "millhaven");

    const craftedBagInv = await alice.waitInventory((inv) =>
      inv.bag.some((s) => s?.id === crafted.itemId && s.provenance?.traitId === "high-carbon"),
    );
    const bagSword = craftedBagInv.bag.find((s) => s?.id === crafted.itemId)!;
    assert.ok(bagSword.stats.power! > 10, `expected high-carbon boosted power > 10, got ${bagSword.stats.power}`);

    // Equip high-carbon sword over wire (Alice returns to combat coords before frame ticks)
    C.Transform.px[aliceEid] = 0;
    C.Transform.pz[aliceEid] = 0;
    C.Transform.px[bobEid] = 1;
    C.Transform.pz[bobEid] = 0;
    const equipHcP = alice.waitInventory((inv) => inv.main?.id === crafted.itemId);
    alice.client.equip(crafted.itemId);
    await pumpFrames(2);
    await equipHcP;
    const hcWeapon = items.weaponForCharacter(aliceRec.id);
    assert.ok(hcWeapon);
    assert.ok(hcWeapon.item.mass > baseWeapon.item.mass, "high-carbon provenance must boost combat weapon mass");

    alice.client.stance("cut", "torso");
    await pumpFrames(2);
    alice.hitMsgs.length = 0;
    const hcHitP = alice.waitHit((h) => h.target === bob.client.playerEntity!.toString());
    alice.client.sendIntent({
      mx: 0,
      my: 0,
      mz: 0,
      lookYaw: Math.PI / 2,
      lookPitch: 0,
      jump: false,
      buttons: IntentButton.Attack,
    });
    await pumpFrames(12, 15);
    const hcHit = await hcHitP;
    const traitDmg = C.Health.max[bobEid]! - C.Health.current[bobEid]!;
    assert.ok(
      traitDmg > baseDmg && hcHit.amount > baseHit.amount,
      `high-carbon provenance strike (${traitDmg}) must exceed baseline (${baseDmg})`,
    );

    // 5. Escrow contract post -> Alice disconnects -> TTL expiry sweep -> reconnect claims pendingCredits
    alice.client.civic({
      kind: "civic",
      op: "contract_post",
      opId: "e2e-contract",
      targetKind: "site",
      targetId: "redwater-bridge",
      material: "wood",
      qty: 10,
      rewardPerUnit: 20,
      ttlHours: 1,
    });
    const posted = await alice.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "contract_update" }> => m.op === "contract_update",
    );
    assert.equal(posted.contract.totalQty, 10);
    assert.equal(posted.contract.rewardPerUnit, 20);
    const walletAfterPost = wallet.balanceOf(aliceRec.id);

    alice.client.disconnect();
    // Wait for TCP socket close to hit Gateway and expire parked grace + 1h contract TTL
    await new Promise((r) => setTimeout(r, 80));
    now += 3_700_000;
    gw.frame(now);
    assert.equal(civicStore.getPendingCredits(aliceRec.id), 200);

    // Reconnect Alice -> receives pendingCreditsClaimed === 200 and wallet refund
    const aliceRe = createTrackedClient(url, "alice", "alice-reconnect");
    await aliceRe.connectPromise;
    const alice2 = aliceRe.tracked;
    openClients.push(alice2.client);

    const reState = await alice2.waitCivic(
      (m): m is Extract<CivicServerMessage, { op: "state" }> => m.op === "state",
    );
    assert.equal(reState.pendingCreditsClaimed, 200);
    assert.equal(civicStore.getPendingCredits(aliceRec.id), 0);
    assert.equal(wallet.balanceOf(aliceRec.id), walletAfterPost + 200);
    await pumpFrames(2);
    await alice2.waitWallet((w) => w.balance === walletAfterPost + 200);

    // 6. Verify 1 Hz telemetry gauges + HTTP GET /health and GET /metrics/civic
    await pumpFrames(2);
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(await healthRes.text(), "ok");

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics/civic`);
    assert.equal(metricsRes.status, 200);
    assert.match(metricsRes.headers.get("content-type") ?? "", /text\/plain/);
    const metricsBody = await metricsRes.text();
    assert.match(metricsBody, /mmo_civic_bridge_stage 2/);
    assert.match(metricsBody, /mmo_civic_active_veins \d+/);
    assert.match(metricsBody, /mmo_civic_open_contracts 0/);
    assert.match(metricsBody, /mmo_civic_sweeps_total [1-9]\d*/);
  });
});
