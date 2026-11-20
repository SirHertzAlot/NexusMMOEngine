/**
 * CivicService — authoritative SimSystem + GatewayExtension ("civic" / 0x11)
 * implementing the Redwater Crossing Living Regional Provenance & Civic Logistics
 * vertical slice:
 *
 * 1. Dynamic surveying & finite veins (zero pre-discovery coordinate leaks)
 * 2. Civic restoration sites & traffic wear (stage progression, reversible repair,
 *    overshoot clamping, atomic multi-resource debit, anti-whale plaque weights)
 * 3. Settlement foundry specialization (vein traits, finite batch cap + TTL,
 *    bridge haul gating, local land depletion permille)
 * 4. Escrow frontier contracts (SQLite WAL escrow, overflow-safe integer math,
 *    atomic cancel/deliver/expiry guard, offline pending credit claim on login)
 * 5. Immutable item & milestone provenance (survives bag moves, equips, trades, restarts)
 */

import { hasComponent } from "bitecs";
import { z } from "zod";
import {
  computeContractTotals,
  computeSurveyBearing,
  effectiveContributionWeight,
  type CivicFoundryDef,
  type CivicRules,
  type CivicSiteDef,
  type VeinTraitDef,
} from "@mmo-engine/rules";
import type {
  CivicClientMessage,
  CivicContractView,
  CivicFoundryView,
  CivicServerMessage,
  CivicSiteView,
  CivicVeinView,
  ItemProvenanceView,
} from "@mmo-engine/protocol";
import { Health, Transform } from "../components.js";
import type { GatewayExtension, ExtensionPlayer } from "../net/extension.js";
import type { CivicTelemetryMetrics } from "../logging/civic-metrics.js";
import type { SystemAccess } from "../system-access.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import {
  computeRepairCost,
  SqliteCivicStore,
  toContractView,
  toFoundryView,
  toSiteView,
  toVeinView,
  type StoredContract,
  type StoredFoundry,
  type StoredSite,
  type StoredVein,
} from "./civic-store.js";
import {
  CaravanEscortCoordinator,
  countNearbyEscorts,
  type CaravanEscortOptions,
} from "./caravan-escort.js";
import {
  isFoundryMature,
  planRepairContributionWithKits,
  REPAIR_KIT_MATERIAL_ID,
  resolveReforgeTargetTrait,
} from "./foundry-pivot.js";

const DAY_MS = 86_400_000;
const slugRegex = /^[a-z][a-z0-9-]{0,63}$/;
const opIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const materialMapSchema = z.record(
  z.string().regex(slugRegex),
  z.number().int().positive().max(100_000),
);

export const CivicClientMessageSchema = z.discriminatedUnion("op", [
  z.strictObject({ kind: z.literal("civic"), op: z.literal("state") }),
  z.strictObject({ kind: z.literal("civic"), op: z.literal("survey") }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("extract"),
    veinBatchId: z.string().min(1).max(80),
    qty: z.number().int().positive().max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("contribute"),
    siteId: z.string().regex(slugRegex),
    opId: opIdSchema,
    materials: materialMapSchema.optional(),
    gold: z.number().int().min(0).max(1_000_000_000).optional(),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("plaque"),
    siteId: z.string().regex(slugRegex),
    offset: z.number().int().min(0).max(10_000).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("foundry_supply"),
    townId: z.string().regex(slugRegex),
    opId: opIdSchema,
    veinBatchId: z.string().min(1).max(80),
    material: z.string().regex(slugRegex),
    qty: z.number().int().positive().max(10_000),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("foundry_craft"),
    townId: z.string().regex(slugRegex),
    opId: opIdSchema,
    item: z.string().regex(slugRegex),
    rank: z.string().regex(slugRegex),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("foundry_reforge"),
    townId: z.string().regex(slugRegex),
    opId: opIdSchema,
    itemId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("craft_repair_kit"),
    townId: z.string().regex(slugRegex),
    opId: opIdSchema,
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("contract_post"),
    opId: opIdSchema,
    targetKind: z.enum(["site", "foundry"]),
    targetId: z.string().regex(slugRegex),
    material: z.string().regex(slugRegex),
    qty: z.number().int().positive().max(100_000),
    rewardPerUnit: z.number().int().positive().max(1_000_000_000),
    ttlHours: z.number().int().positive().max(168).optional(),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("contract_deliver"),
    opId: opIdSchema,
    contractId: z.string().regex(/^\d{1,16}$/),
    qty: z.number().int().positive().max(100_000),
  }),
  z.strictObject({
    kind: z.literal("civic"),
    op: z.literal("contract_cancel"),
    opId: opIdSchema,
    contractId: z.string().regex(/^\d{1,16}$/),
  }),
]);

export interface CivicServiceOptions {
  rules: CivicRules;
  store: SqliteCivicStore;
  now?: () => number;
  dayOf?: (nowMs: number) => number;
  countMaterial(charId: number, material: string): number;
  takeMaterial(charId: number, material: string, qty: number): boolean;
  grantMaterial(charId: number, material: string, qty: number): boolean;
  hasMaterialRoom(charId: number, material: string, qty: number): boolean;
  balanceOf(charId: number): number;
  spendGold(charId: number, amount: number, tick: number): boolean;
  grantGold(charId: number, amount: number, tick: number): boolean;
  hasBagRoom(charId: number): boolean;
  craftAndGrantItem(charId: number, item: string, rank: string): number | null;
  onSiteStateChange?: (siteId: string, stage: number, damaged: boolean) => void;
  activeAvatars?: () => Iterable<{ charId: number; eid: number }>;
  sweepEveryTicks?: number;
  /** Track C6: authoritative item ownership check required for `foundry_reforge`. */
  ownsItem?: (charId: number, itemId: number) => boolean;
  /** Track C5: optional bounded ambush callback invoked on heavy hauls. */
  onEscortAmbush?: (siteId: string, x: number, z: number, charId: number) => void;
  /** Track C5: optional nearby party/escort helper counter around (x, z). */
  nearbyEscortCount?: (charId: number, x: number, z: number, radiusM: number) => number;
  /** Track C5: optional tuning overrides for caravan escort risk/bonus windows. */
  escortOptions?: Omit<CaravanEscortOptions, "onEscortAmbush">;
  /** Track C7a: optional zero-alloc SAB telemetry gauge sink updated once per sweep. */
  metrics?: CivicTelemetryMetrics;
}

export class CivicService implements SimSystem, GatewayExtension {
  readonly name = "civic";
  readonly kind = "civic";
  readonly access: SystemAccess = {
    system: "civic",
    reads: [
      { component: "Transform", fields: ["px", "pz"] },
      { component: "Health", fields: ["current"] },
    ],
    writes: [],
  };

  readonly store: SqliteCivicStore;
  private rules: CivicRules;
  private readonly now: () => number;
  private readonly dayOf: (nowMs: number) => number;
  private readonly sweepEveryTicks: number;

  private readonly sitesById = new Map<string, CivicSiteDef>();
  private readonly foundriesById = new Map<string, CivicFoundryDef>();
  private readonly traitsById = new Map<string, VeinTraitDef>();
  private readonly enteredPlayers = new Map<number, ExtensionPlayer>();
  private readonly lastSurveyAt = new Map<number, number>();
  private readonly lastExtractAt = new Map<number, number>();
  private readonly lastBridgeCrossAt = new Map<string, Map<number, number>>();
  private readonly escort: CaravanEscortCoordinator;
  private readonly activeVeinsCountStmt;
  private readonly openContractsCountStmt;

  private veinBatchCounter = 0;
  private currentTick = 0;
  private lastSim: SimWorld | null = null;

  constructor(private readonly opts: CivicServiceOptions) {
    this.rules = opts.rules;
    this.store = opts.store;
    this.activeVeinsCountStmt = this.store.db.prepare(`SELECT COUNT(*) AS n FROM civic_veins WHERE stock > 0`);
    this.openContractsCountStmt = this.store.db.prepare(`SELECT COUNT(*) AS n FROM civic_contracts WHERE status = 'open'`);
    this.now = opts.now ?? Date.now;
    this.dayOf = opts.dayOf ?? ((ms) => Math.floor(ms / DAY_MS));
    this.sweepEveryTicks = Math.max(1, opts.sweepEveryTicks ?? 30);
    this.escort = new CaravanEscortCoordinator({
      ...opts.escortOptions,
      onEscortAmbush: opts.onEscortAmbush,
    });

    this.rebuildRuleIndexes(this.rules);
    const t = this.now();
    this.store.seedDefaults(this.rules, t);
    this.veinBatchCounter = this.store.listVeins(true).length;
    this.store.expireDueContracts(t);
    this.expireDueFoundries(t);
    this.ensureActiveVeins(t);
  }

  private rebuildRuleIndexes(rules: CivicRules): void {
    this.sitesById.clear();
    for (const s of rules.sites) this.sitesById.set(s.id, s);
    this.foundriesById.clear();
    for (const f of rules.foundries) this.foundriesById.set(f.id, f);
    this.traitsById.clear();
    for (const tr of rules.traits) this.traitsById.set(tr.id, tr);
  }

  getRules(): CivicRules {
    return this.rules;
  }

  setRules(next: CivicRules): void {
    this.rules = next;
    this.rebuildRuleIndexes(next);
    const t = this.now();
    this.store.seedDefaults(next, t);
    this.ensureActiveVeins(t);
  }

  provenanceOf(itemId: number): ItemProvenanceView | undefined {
    return this.store.getProvenanceByItemId(itemId);
  }

  /**
   * Optional hook for generic `CraftingService` completions near a specialized foundry:
   * stamps provenance if the crafter stands inside an active specialized foundry radius.
   */
  bindCraftedItemProvenance(charId: number, charName: string, itemId: number, avatarEid: number): ItemProvenanceView | null {
    if (avatarEid < 0 || !Number.isInteger(itemId) || itemId <= 0) return null;
    const t = this.now();
    this.expireDueFoundries(t);
    const px = Transform.px[avatarEid] ?? 0;
    const pz = Transform.pz[avatarEid] ?? 0;
    for (const def of this.rules.foundries) {
      if (Math.hypot(px - def.x, pz - def.z) > def.interactRadiusM) continue;
      const foundry = this.store.getFoundry(def.id);
      if (!foundry || foundry.batchesRemaining <= 0) continue;
      if (foundry.expiresAt !== null && t >= foundry.expiresAt) continue;
      return this.consumeSpecialtyAndMintProvenance(foundry.id, charId, charName, itemId, t);
    }
    return null;
  }

  // ---- GatewayExtension lifecycle ----

  onEnter(player: ExtensionPlayer): void {
    if (player.characterId === null) return;
    this.enteredPlayers.set(player.characterId, player);
    const t = this.now();
    this.store.expireDueContracts(t);
    const pending = this.store.claimPendingCredits(player.characterId, t);
    if (pending > 0) {
      if (!this.opts.grantGold(player.characterId, pending, this.currentTick)) {
        // Put credits back safely if wallet cannot accept right now.
        this.store.addPendingCredits(player.characterId, pending, t);
      } else {
        player.refreshInventory();
        this.sendState(player, pending);
        return;
      }
    }
    this.sendState(player, 0);
  }

  onLeave(player: ExtensionPlayer): void {
    if (player.characterId !== null) {
      this.enteredPlayers.delete(player.characterId);
    }
  }

  // ---- SimSystem fixed tick ----

  step(sim: SimWorld, _dt: number): void {
    this.currentTick = sim.currentTick;
    this.lastSim = sim;
    if (sim.currentTick % this.sweepEveryTicks !== 0) return;
    const metrics = this.opts.metrics;
    const sweepStartMs = metrics ? performance.now() : 0;
    const t = this.now();
    this.sweepTrafficWear(sim, t);
    this.expireDueFoundries(t);
    this.store.expireDueContracts(t);
    this.ensureActiveVeins(t);
    if (metrics) {
      this.recordTelemetrySweep(metrics, sweepStartMs);
    }
  }

  private recordTelemetrySweep(metrics: CivicTelemetryMetrics, sweepStartMs: number): void {
    const activeVeins = (this.activeVeinsCountStmt.get() as { n: number }).n;
    const openContracts = (this.openContractsCountStmt.get() as { n: number }).n;
    const primarySiteDef = this.rules.sites[0];
    const primarySite = primarySiteDef ? this.store.getSite(primarySiteDef.id) : undefined;
    const bridgeStage = primarySite ? primarySite.stage : 0;
    const bridgeWear = primarySite ? primarySite.wear : 0;
    let matureFoundries = 0;
    const foundryDefs = this.rules.foundries;
    for (let i = 0; i < foundryDefs.length; i++) {
      const fDef = foundryDefs[i]!;
      const f = this.store.getFoundry(fDef.id);
      if (f && isFoundryMature(f, fDef)) {
        matureFoundries++;
      }
    }
    const elapsedMicros = Math.max(0, (performance.now() - sweepStartMs) * 1000);
    metrics.recordSweep(activeVeins, openContracts, bridgeStage, bridgeWear, matureFoundries, elapsedMicros);
  }

  private sweepTrafficWear(sim: SimWorld, nowMs: number): void {
    for (const siteDef of this.rules.sites) {
      const site = this.store.getSite(siteDef.id);
      if (!site || site.stage < 1 || site.damaged) continue;
      const hw = siteDef.crossingHalfWidthM;
      // Check active connected players first (zero allocation iterable).
      for (const player of this.enteredPlayers.values()) {
        if (player.characterId === null) continue;
        this.checkEntityCrossing(sim, siteDef, site, player.characterId, player.entity(), hw, nowMs);
      }
      if (this.opts.activeAvatars) {
        for (const av of this.opts.activeAvatars()) {
          this.checkEntityCrossing(sim, siteDef, site, av.charId, av.eid, hw, nowMs);
        }
      }
    }
  }

  private checkEntityCrossing(
    sim: SimWorld,
    siteDef: CivicSiteDef,
    site: StoredSite,
    charId: number,
    eid: number,
    halfWidth: number,
    nowMs: number,
  ): void {
    if (eid < 0 || site.damaged) return;
    if (!this.isAlive(sim, eid)) return;
    const dx = Math.abs((Transform.px[eid] ?? 0) - siteDef.x);
    const dz = Math.abs((Transform.pz[eid] ?? 0) - siteDef.z);
    if (dx > halfWidth || dz > halfWidth) return;
    let siteCrosses = this.lastBridgeCrossAt.get(siteDef.id);
    if (!siteCrosses) {
      siteCrosses = new Map();
      this.lastBridgeCrossAt.set(siteDef.id, siteCrosses);
    }
    const lastCross = siteCrosses.get(charId) ?? -Infinity;
    if (nowMs - lastCross < siteDef.crossingCooldownMs) return;
    siteCrosses.set(charId, nowMs);
    this.applySiteWear(siteDef, siteDef.wearPerCrossing, charId, "Crossing traffic", nowMs);
    // Keep in-memory reference coherent for remaining avatars in same sweep.
    const refreshed = this.store.getSite(siteDef.id);
    if (refreshed) {
      site.wear = refreshed.wear;
      site.damaged = refreshed.damaged;
    }
  }

  private applySiteWear(siteDef: CivicSiteDef, delta: number, actorId: number, actorName: string, nowMs: number): void {
    if (delta <= 0) return;
    const site = this.store.getSite(siteDef.id);
    if (!site || site.stage < 1) return;
    const nextWear = Math.min(siteDef.wearMax, site.wear + delta);
    const becameDamaged = !site.damaged && nextWear >= siteDef.damageThreshold;
    const nextSite: StoredSite = {
      ...site,
      wear: nextWear,
      damaged: site.damaged || becameDamaged,
      updatedAt: nowMs,
    };
    this.store.saveSite(nextSite);
    if (becameDamaged) {
      this.store.appendHistory({
        siteId: site.id,
        eventType: "damaged",
        actorId,
        actorName,
        eraTag: site.eraTag,
        detail: `${siteDef.name} suffered structural wear (${nextWear}/${siteDef.wearMax}) and requires repair`,
        createdAt: nowMs,
      });
      this.opts.onSiteStateChange?.(site.id, site.stage, true);
    }
  }

  private expireDueFoundries(nowMs: number): void {
    for (const foundry of this.store.listFoundries()) {
      if (foundry.batchesRemaining > 0 && foundry.expiresAt !== null && nowMs >= foundry.expiresAt) {
        this.store.saveFoundry({
          ...foundry,
          activeVeinBatchId: null,
          activeTraitId: "bog-standard",
          batchesRemaining: 0,
          expiresAt: null,
          updatedAt: nowMs,
        });
      }
    }
  }

  /** Guarantees `minActivePerRegion` active veins and rotates depleted respawned veins across anchors. */
  ensureActiveVeins(nowMs: number): void {
    if (this.rules.veins.length === 0) return;
    this.store.runImmediate(() => {
      const existing = this.store.listVeins(true);
      // 1. Respawn any depleted veins whose wall-clock respawn delay elapsed -> rotate anchor & trait!
      for (const v of existing) {
        if (v.stock > 0 || v.respawnAt === null || nowMs < v.respawnAt) continue;
        const tmpl = this.rules.veins.find((t) => t.id === v.templateId);
        if (!tmpl) continue;
        const nextAnchorIdx = (v.anchorIndex + 1) % tmpl.spawnAnchors.length;
        const anchor = tmpl.spawnAnchors[nextAnchorIdx]!;
        const nextTraitIdx = (v.anchorIndex + 1) % tmpl.traitPool.length;
        const nextTrait = tmpl.traitPool[nextTraitIdx]!;
        // Mint fresh rotated batch ID so provenance distinguishes historical seams!
        const nextBatchId = `${tmpl.id}-${++this.veinBatchCounter}`;
        // Mark old exhausted batch non-respawning so history doesn't respawn it twice.
        this.store.upsertVein({ ...v, respawnAt: null });
        this.store.upsertVein({
          veinBatchId: nextBatchId,
          templateId: tmpl.id,
          traitId: nextTrait,
          material: tmpl.material,
          x: anchor.x,
          z: anchor.z,
          anchorIndex: nextAnchorIdx,
          stock: tmpl.stock,
          maxStock: tmpl.stock,
          discoveredByCharId: null,
          discoveredByName: null,
          discoveredAt: null,
          respawnAt: null,
          createdAt: nowMs,
        });
      }

      // 2. Enforce baseline active guarantee across region
      let active = this.store.listVeins(false);
      const baselineTemplates = this.rules.veins.filter((t) => t.isBaseline);
      const sourcePool = baselineTemplates.length > 0 ? baselineTemplates : this.rules.veins;
      let spin = 0;
      while (active.length < this.rules.surveying.minActivePerRegion && spin < sourcePool.length * 2) {
        const tmpl = sourcePool[spin % sourcePool.length]!;
        spin++;
        if (active.some((v) => v.templateId === tmpl.id)) continue;
        const batchNum = ++this.veinBatchCounter;
        const anchorIdx = (batchNum - 1) % tmpl.spawnAnchors.length;
        const anchor = tmpl.spawnAnchors[anchorIdx]!;
        const traitId = tmpl.traitPool[(batchNum - 1) % tmpl.traitPool.length]!;
        this.store.upsertVein({
          veinBatchId: `${tmpl.id}-${batchNum}`,
          templateId: tmpl.id,
          traitId,
          material: tmpl.material,
          x: anchor.x,
          z: anchor.z,
          anchorIndex: anchorIdx,
          stock: tmpl.stock,
          maxStock: tmpl.stock,
          discoveredByCharId: tmpl.isBaseline ? 0 : null,
          discoveredByName: tmpl.isBaseline ? "Regional Survey" : null,
          discoveredAt: tmpl.isBaseline ? nowMs : null,
          respawnAt: null,
          createdAt: nowMs,
        });
        active = this.store.listVeins(false);
      }
    });
  }

  // ---- Public read/helper API for admin & state pushes ----

  buildStateMessage(pendingCreditsClaimed = 0): Extract<CivicServerMessage, { op: "state" }> {
    const sites: CivicSiteView[] = this.rules.sites.map((def) => {
      const s = this.store.getSite(def.id) ?? {
        id: def.id,
        stage: 0,
        progress: {},
        goldProgress: 0,
        repairProgress: {},
        repairGoldProgress: 0,
        wear: 0,
        damaged: false,
        eraTag: def.stages[0]?.label ?? "Stage 0",
        updatedAt: this.now(),
      };
      return toSiteView(s, def, this.store.countContributors(def.id));
    });

    // Privacy safeguard: NEVER include undiscovered veins in public snapshots/state!
    const veins: CivicVeinView[] = this.store
      .listVeins(false)
      .filter((v) => v.discoveredByCharId !== null)
      .map((v) => toVeinView(v, this.traitsById.get(v.traitId)));

    const foundries: CivicFoundryView[] = this.rules.foundries.map((def) => {
      const f = this.store.getFoundry(def.id) ?? {
        id: def.id,
        oreBuffer: {},
        activeVeinBatchId: null,
        activeTraitId: "bog-standard",
        batchesRemaining: 0,
        expiresAt: null,
        depletedPermille: 0,
        updatedAt: this.now(),
      };
      return toFoundryView(f, def, this.traitsById.get(f.activeTraitId));
    });

    const contracts: CivicContractView[] = this.store.listContracts().map(toContractView);

    return {
      kind: "civic",
      op: "state",
      tick: this.currentTick,
      sites,
      veins,
      foundries,
      contracts,
      pendingCreditsClaimed,
    };
  }

  private sendState(player: ExtensionPlayer, pendingCreditsClaimed = 0): void {
    player.send(this.buildStateMessage(pendingCreditsClaimed));
  }

  private sendNotice(player: ExtensionPlayer, ok: boolean, code: string, message: string, opId?: string): void {
    player.send({
      kind: "civic",
      op: "notice",
      ok,
      code,
      message,
      ...(opId !== undefined ? { opId } : {}),
    } satisfies CivicServerMessage);
  }

  private isAlive(_sim: SimWorld | null, eid: number): boolean {
    if (eid < 0) return false;
    // If entity lacks Health component (test harness), treat as alive; otherwise require current > 0.
    const h = Health.current[eid];
    if (h === undefined || Number.isNaN(h)) return true;
    const sim = _sim ?? this.lastSim;
    if (sim && !hasComponent(sim.ecs, Health, eid)) return true;
    return h > 0;
  }

  private checkAlive(player: ExtensionPlayer): { ok: true; eid: number; charId: number } | { ok: false; code: string; error: string } {
    if (player.characterId === null) {
      return { ok: false, code: "no_character", error: "must enter the world first" };
    }
    const eid = player.entity();
    if (eid < 0) {
      return { ok: false, code: "no_entity", error: "no avatar entity in world" };
    }
    const hp = Health.current[eid];
    if (hp !== undefined && !Number.isNaN(hp) && hp <= 0) {
      return { ok: false, code: "dead", error: "cannot perform civic actions while incapacitated" };
    }
    return { ok: true, eid, charId: player.characterId };
  }

  private withinRadius(eid: number, tx: number, tz: number, radiusM: number): boolean {
    const px = Transform.px[eid] ?? 0;
    const pz = Transform.pz[eid] ?? 0;
    return Math.hypot(px - tx, pz - tz) <= radiusM;
  }

  // ---- Gateway Message Dispatcher ----

  onMessage(player: ExtensionPlayer, raw: unknown): void {
    const parsed = CivicClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendNotice(player, false, "invalid_payload", "malformed civic request");
      return;
    }
    const msg: CivicClientMessage = parsed.data;
    switch (msg.op) {
      case "state":
        this.sendState(player, 0);
        return;
      case "survey":
        this.handleSurvey(player);
        return;
      case "extract":
        this.handleExtract(player, msg.veinBatchId, msg.qty ?? 1);
        return;
      case "contribute":
        this.handleContribute(player, msg);
        return;
      case "plaque":
        this.handlePlaque(player, msg.siteId, msg.offset ?? 0, msg.limit ?? 20);
        return;
      case "foundry_supply":
        this.handleFoundrySupply(player, msg);
        return;
      case "foundry_craft":
        this.handleFoundryCraft(player, msg);
        return;
      case "foundry_reforge":
        this.handleFoundryReforge(player, msg);
        return;
      case "craft_repair_kit":
        this.handleCraftRepairKit(player, msg);
        return;
      case "contract_post":
        this.handleContractPost(player, msg);
        return;
      case "contract_deliver":
        this.handleContractDeliver(player, msg);
        return;
      case "contract_cancel":
        this.handleContractCancel(player, msg);
        return;
    }
  }

  // ---- Domain 1: Dynamic Regional Surveying & Finite Veins ----

  private handleSurvey(player: ExtensionPlayer): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error);
      return;
    }
    const t = this.now();
    const prev = this.lastSurveyAt.get(check.charId) ?? -Infinity;
    if (t - prev < this.rules.surveying.cooldownMs) {
      this.sendNotice(player, false, "cooldown", "survey kit is resetting");
      return;
    }
    this.lastSurveyAt.set(check.charId, t);
    this.ensureActiveVeins(t);

    const px = Transform.px[check.eid] ?? 0;
    const pz = Transform.pz[check.eid] ?? 0;
    const active = this.store.listVeins(false);

    let bestVein: StoredVein | null = null;
    let bestBearing: ReturnType<typeof computeSurveyBearing> | null = null;
    for (const v of active) {
      const b = computeSurveyBearing(
        px,
        pz,
        v.x,
        v.z,
        this.rules.surveying.scanRangeM,
        this.rules.surveying.pinpointRadiusM,
      );
      if (b.band === "none") continue;
      if (!bestBearing || b.exactDistanceM < bestBearing.exactDistanceM) {
        bestVein = v;
        bestBearing = b;
      }
    }

    if (!bestVein || !bestBearing) {
      player.send({
        kind: "civic",
        op: "survey_result",
        band: "none",
        direction: "here",
        distanceBucketM: -1,
      } satisfies CivicServerMessage);
      return;
    }

    // Outside pinpointRadiusM: NEVER reveal veinBatchId, trait, or raw coordinates!
    if (bestBearing.band !== "pinpoint") {
      player.send({
        kind: "civic",
        op: "survey_result",
        band: bestBearing.band,
        direction: bestBearing.direction,
        distanceBucketM: bestBearing.distanceBucketM,
      } satisfies CivicServerMessage);
      return;
    }

    // Pinpoint discovery inside radius -> persist discovery metadata safely inside TX
    let newlyDiscovered = false;
    this.store.runImmediate(() => {
      const cur = this.store.getVein(bestVein!.veinBatchId);
      if (!cur || cur.stock <= 0) return;
      if (cur.discoveredByCharId === null) {
        newlyDiscovered = true;
        this.store.upsertVein({
          ...cur,
          discoveredByCharId: check.charId,
          discoveredByName: player.name,
          discoveredAt: t,
        });
      }
    });

    const trait = this.traitsById.get(bestVein.traitId);
    player.send({
      kind: "civic",
      op: "survey_result",
      band: "pinpoint",
      direction: "here",
      distanceBucketM: 0,
      veinBatchId: bestVein.veinBatchId,
      traitId: bestVein.traitId,
      traitName: trait?.name ?? bestVein.traitId,
      material: bestVein.material,
      stockRemaining: bestVein.stock,
      newlyDiscovered,
    } satisfies CivicServerMessage);
    if (newlyDiscovered) this.sendState(player, 0);
  }

  private handleExtract(player: ExtensionPlayer, veinBatchId: string, rawQty: number): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error);
      return;
    }
    const t = this.now();
    const vein = this.store.getVein(veinBatchId);
    if (!vein || vein.discoveredByCharId === null) {
      this.sendNotice(player, false, "unknown_vein", "no discovered mineral deposit matching that batch");
      return;
    }
    if (!this.withinRadius(check.eid, vein.x, vein.z, this.rules.surveying.extractReachM)) {
      this.sendNotice(player, false, "out_of_range", "move closer to the vein to extract ore");
      return;
    }
    const lastEx = this.lastExtractAt.get(check.charId) ?? -Infinity;
    if (t - lastEx < 500) {
      this.sendNotice(player, false, "cooldown", "already extracting ore");
      return;
    }
    if (vein.stock <= 0) {
      this.sendNotice(player, false, "depleted", "this mineral seam has been worked out");
      return;
    }

    const wantQty = Math.min(rawQty, this.rules.surveying.maxExtractQtyPerCall, vein.stock);
    // Check pouch room BEFORE decrementing stock so full bags NEVER destroy ore!
    let roomQty = wantQty;
    while (roomQty > 0 && !this.opts.hasMaterialRoom(check.charId, vein.material, roomQty)) {
      roomQty--;
    }
    if (roomQty <= 0) {
      this.sendNotice(player, false, "pouch_full", `your pouch holds no more ${vein.material}`);
      return;
    }

    const tmpl = this.rules.veins.find((v) => v.id === vein.templateId);
    const respawnDelayMs = tmpl?.respawnDelayMs ?? 30_000;
    const extracted = this.store.atomicExtractFromVein(veinBatchId, roomQty, respawnDelayMs, t);
    if (!extracted) {
      this.sendNotice(player, false, "depleted", "another prospector claimed the final ore from that seam");
      return;
    }

    if (!this.opts.grantMaterial(check.charId, vein.material, extracted.extracted)) {
      // Defensive rollback if pouch refused concurrently: restore extracted stock cleanly.
      this.store.runImmediate(() => {
        const cur = this.store.getVein(veinBatchId);
        if (cur) {
          this.store.upsertVein({
            ...cur,
            stock: Math.min(cur.maxStock, cur.stock + extracted.extracted),
            respawnAt: null,
          });
        }
      });
      this.sendNotice(player, false, "pouch_full", "pouch full; extraction cancelled");
      return;
    }

    this.lastExtractAt.set(check.charId, t);
    if (extracted.vein.stock === 0) {
      this.ensureActiveVeins(t);
    }

    player.refreshInventory();
    player.send({
      kind: "civic",
      op: "extracted",
      veinBatchId,
      traitId: vein.traitId,
      material: vein.material,
      qty: extracted.extracted,
      stockRemaining: extracted.vein.stock,
    } satisfies CivicServerMessage);
    this.sendState(player, 0);
  }

  // ---- Domain 2: Civic Infrastructure & Contribution Ledger ----

  private handleContribute(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "contribute" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:contribute:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "contributed" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    const siteDef = this.sitesById.get(msg.siteId);
    if (!siteDef) {
      this.sendNotice(player, false, "unknown_site", `unknown civic site "${msg.siteId}"`, msg.opId);
      return;
    }
    if (!this.withinRadius(check.eid, siteDef.x, siteDef.z, siteDef.interactRadiusM)) {
      this.sendNotice(player, false, "out_of_range", `move closer to ${siteDef.name}`, msg.opId);
      return;
    }

    const offerMats = msg.materials ?? {};
    const offerGold = msg.gold ?? 0;
    if (Object.keys(offerMats).length === 0 && offerGold <= 0) {
      this.sendNotice(player, false, "empty_contribution", "specify materials or gold to contribute", msg.opId);
      return;
    }

    const site = this.store.getSite(siteDef.id);
    if (!site) {
      this.sendNotice(player, false, "unknown_site", "site record missing", msg.opId);
      return;
    }
    const isRepairMode = site.damaged;
    const nextStageDef = siteDef.stages[site.stage + 1];
    if (!isRepairMode && !nextStageDef) {
      this.sendNotice(player, false, "already_complete", `${siteDef.name} is already fully built and sound`, msg.opId);
      return;
    }

    const t = this.now();
    // Clamp all offers to exact remaining deficit so partial donations NEVER burn overshoot materials or gold!
    let acceptedMaterials: Record<string, number> = {};
    let repairProgressDelta: Record<string, number> = {};
    let repairKitsUsed = 0;
    let acceptedGold = 0;

    if (isRepairMode) {
      const repairNeed = computeRepairCost(site, siteDef);
      const linkedFoundry =
        this.rules.foundries.find((f) => f.requiresBridgeId === siteDef.id) ?? this.rules.foundries[0];
      const plan = planRepairContributionWithKits(
        offerMats,
        repairNeed.materials,
        linkedFoundry?.repairKitCost,
      );
      acceptedMaterials = plan.acceptedMaterials;
      repairProgressDelta = plan.repairProgressDelta;
      repairKitsUsed = plan.repairKitsUsed;
      if (repairNeed.gold > 0 && offerGold > 0) {
        acceptedGold = Math.min(offerGold, repairNeed.gold);
      }
    } else if (nextStageDef) {
      for (const [mat, qty] of Object.entries(offerMats)) {
        const need = Math.max(0, (nextStageDef.requirements[mat] ?? 0) - (site.progress[mat] ?? 0));
        if (need > 0 && qty > 0) acceptedMaterials[mat] = Math.min(qty, need);
      }
      const needGold = Math.max(0, nextStageDef.goldCost - site.goldProgress);
      if (needGold > 0 && offerGold > 0) {
        acceptedGold = Math.min(offerGold, needGold);
      }
    }

    if (Object.keys(acceptedMaterials).length === 0 && acceptedGold === 0) {
      this.sendNotice(player, false, "not_needed", "none of the offered resources are needed right now", msg.opId);
      return;
    }

    // Verify ALL pouch balances & wallet gold BEFORE debiting ANY (atomic multi-resource pre-check)!
    for (const [mat, need] of Object.entries(acceptedMaterials)) {
      if (this.opts.countMaterial(check.charId, mat) < need) {
        this.sendNotice(player, false, "insufficient_materials", `insufficient ${mat} (need ${need})`, msg.opId);
        return;
      }
    }
    if (acceptedGold > 0 && this.opts.balanceOf(check.charId) < acceptedGold) {
      this.sendNotice(player, false, "insufficient_gold", `insufficient gold (need ${acceptedGold})`, msg.opId);
      return;
    }

    // Atomic debit with rollback on any unexpected failure
    const debitedMats: Array<[string, number]> = [];
    for (const [mat, qty] of Object.entries(acceptedMaterials)) {
      if (!this.opts.takeMaterial(check.charId, mat, qty)) {
        for (const [rmat, rqty] of debitedMats) this.opts.grantMaterial(check.charId, rmat, rqty);
        this.sendNotice(player, false, "insufficient_materials", "material deduction failed", msg.opId);
        return;
      }
      debitedMats.push([mat, qty]);
    }
    if (acceptedGold > 0 && !this.opts.spendGold(check.charId, acceptedGold, this.currentTick)) {
      for (const [rmat, rqty] of debitedMats) this.opts.grantMaterial(check.charId, rmat, rqty);
      this.sendNotice(player, false, "insufficient_gold", "gold deduction failed", msg.opId);
      return;
    }

    const progressUnits = isRepairMode
      ? Object.values(repairProgressDelta).reduce((a, b) => a + b, 0) + acceptedGold
      : Object.values(acceptedMaterials).reduce((a, b) => a + b, 0) + acceptedGold;

    let stageAdvanced = false;
    let repaired = false;
    let updatedSite!: StoredSite;

    this.store.runImmediate(() => {
      const latest = this.store.getSite(siteDef.id)!;
      if (isRepairMode) {
        const nextRep = { ...latest.repairProgress };
        for (const [mat, qty] of Object.entries(repairProgressDelta)) {
          nextRep[mat] = (nextRep[mat] ?? 0) + qty;
        }
        const nextRepGold = latest.repairGoldProgress + acceptedGold;
        const after: StoredSite = {
          ...latest,
          repairProgress: nextRep,
          repairGoldProgress: nextRepGold,
          updatedAt: t,
        };
        const rem = computeRepairCost(after, siteDef);
        const done = Object.keys(rem.materials).length === 0 && rem.gold === 0;
        repaired = done;
        updatedSite = done
          ? {
              ...after,
              damaged: false,
              wear: 0,
              repairProgress: {},
              repairGoldProgress: 0,
            }
          : after;
      } else {
        const nextProg = { ...latest.progress };
        for (const [mat, qty] of Object.entries(acceptedMaterials)) {
          nextProg[mat] = (nextProg[mat] ?? 0) + qty;
        }
        const nextGold = latest.goldProgress + acceptedGold;
        const stageDef = siteDef.stages[latest.stage + 1]!;
        const matsMet = Object.entries(stageDef.requirements).every(([m, req]) => (nextProg[m] ?? 0) >= req);
        const goldMet = nextGold >= stageDef.goldCost;
        if (matsMet && goldMet) {
          stageAdvanced = true;
          updatedSite = {
            ...latest,
            stage: stageDef.stage,
            progress: {},
            goldProgress: 0,
            wear: 0,
            eraTag: stageDef.label,
            updatedAt: t,
          };
        } else {
          updatedSite = {
            ...latest,
            progress: nextProg,
            goldProgress: nextGold,
            updatedAt: t,
          };
        }
      }
      this.store.saveSite(updatedSite);

      // Anti-whale diminishing marginal prestige credit
      const today = this.dayOf(t);
      const prevContrib = this.store.getContributor(siteDef.id, check.charId);
      const priorToday = prevContrib && prevContrib.todayDay === today ? prevContrib.todayRaw : 0;
      const gainedWeight = effectiveContributionWeight(
        priorToday,
        progressUnits,
        siteDef.antiWhaleDailyContribCap,
      );
      this.store.saveContributor({
        siteId: siteDef.id,
        charId: check.charId,
        name: player.name,
        rawScore: (prevContrib?.rawScore ?? 0) + progressUnits,
        effectiveWeight: Math.round(((prevContrib?.effectiveWeight ?? 0) + gainedWeight) * 100) / 100,
        todayDay: today,
        todayRaw: priorToday + progressUnits,
        updatedAt: t,
      });

      this.store.appendHistory({
        siteId: siteDef.id,
        eventType: stageAdvanced ? "stage_advanced" : repaired ? "repaired" : "contributed",
        actorId: check.charId,
        actorName: player.name,
        eraTag: updatedSite.eraTag,
        detail: stageAdvanced
          ? `Advanced ${siteDef.name} to Stage ${updatedSite.stage} (${updatedSite.eraTag})`
          : repaired
            ? `Completed structural repairs on ${siteDef.name}`
            : `Supplied ${progressUnits} units toward ${siteDef.name}`,
        createdAt: t,
      });

      const response: Extract<CivicServerMessage, { op: "contributed" }> = {
        kind: "civic",
        op: "contributed",
        siteId: siteDef.id,
        opId: msg.opId,
        acceptedMaterials,
        acceptedGold,
        stage: updatedSite.stage,
        damaged: updatedSite.damaged,
        wear: updatedSite.wear,
        stageAdvanced,
        repaired,
        eraTag: updatedSite.eraTag,
        ...(repairKitsUsed > 0 ? { repairKitsUsed } : {}),
        replayed: false,
      };
      this.store.saveProcessedOp(opKey, JSON.stringify(response), t);
    });

    if (stageAdvanced || repaired) {
      this.opts.onSiteStateChange?.(siteDef.id, updatedSite.stage, updatedSite.damaged);
    }

    const storedRes = JSON.parse(this.store.getProcessedOp(opKey)!) as Extract<CivicServerMessage, { op: "contributed" }>;
    player.refreshInventory();
    player.send(storedRes);
    this.sendState(player, 0);
  }

  private handlePlaque(player: ExtensionPlayer, siteId: string, offset: number, limit: number): void {
    const def = this.sitesById.get(siteId);
    const site = def ? this.store.getSite(siteId) : undefined;
    if (!def || !site) {
      this.sendNotice(player, false, "unknown_site", `unknown civic site "${siteId}"`);
      return;
    }
    const totalContributors = this.store.countContributors(siteId);
    const totalHistory = this.store.countHistory(siteId);
    player.send({
      kind: "civic",
      op: "plaque",
      siteId: site.id,
      siteName: def.name,
      stage: site.stage,
      damaged: site.damaged,
      wear: site.wear,
      eraTag: site.eraTag,
      totalContributors,
      contributors: this.store.listContributors(siteId, 10, 0),
      history: this.store.listHistory(siteId, limit, offset),
      offset,
      limit,
      totalHistory,
    } satisfies CivicServerMessage);
  }

  // ---- Domain 3: Settlement Foundry Specialization ----

  private handleFoundrySupply(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "foundry_supply" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:foundry_supply:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "foundry_updated" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    const foundryDef = this.foundriesById.get(msg.townId);
    if (!foundryDef) {
      this.sendNotice(player, false, "unknown_foundry", `unknown settlement foundry "${msg.townId}"`, msg.opId);
      return;
    }
    if (!this.withinRadius(check.eid, foundryDef.x, foundryDef.z, foundryDef.interactRadiusM)) {
      this.sendNotice(player, false, "out_of_range", `move closer to ${foundryDef.name}`, msg.opId);
      return;
    }

    // Bridge-haul gating safeguard
    const bridgeDef = foundryDef.requiresBridgeId ? this.sitesById.get(foundryDef.requiresBridgeId) : undefined;
    const bridgeSite = bridgeDef ? this.store.getSite(bridgeDef.id) : undefined;
    if (foundryDef.requiresBridgeId) {
      if (!bridgeSite || !bridgeDef || bridgeSite.stage < 1 || bridgeSite.damaged) {
        this.sendNotice(player, false, "crossing_blocked", "route across Redwater Gorge Bridge is impassable", msg.opId);
        return;
      }
      if (msg.qty > 5 && bridgeSite.stage < bridgeDef.heavyHaulMinStage) {
        this.sendNotice(
          player,
          false,
          "heavy_haul_blocked",
          `${foundryDef.name} bulk shipments (>5 ore) require ${bridgeDef.name} at Stage ${bridgeDef.heavyHaulMinStage}`,
          msg.opId,
        );
        return;
      }
    }

    const vein = this.store.getVein(msg.veinBatchId);
    if (!vein || vein.material !== msg.material) {
      this.sendNotice(player, false, "invalid_vein_batch", "invalid or mismatched vein batch reference", msg.opId);
      return;
    }
    if (this.opts.countMaterial(check.charId, msg.material) < msg.qty) {
      this.sendNotice(player, false, "insufficient_materials", `insufficient ${msg.material} in pouch`, msg.opId);
      return;
    }
    if (!this.opts.takeMaterial(check.charId, msg.material, msg.qty)) {
      this.sendNotice(player, false, "insufficient_materials", "material deduction failed", msg.opId);
      return;
    }

    const t = this.now();
    this.expireDueFoundries(t);

    let specialized = false;
    let updatedFoundry!: StoredFoundry;

    this.store.runImmediate(() => {
      const f = this.store.getFoundry(foundryDef.id)!;
      const nextBuf = { ...f.oreBuffer };
      nextBuf[msg.material] = (nextBuf[msg.material] ?? 0) + msg.qty;
      const totalOre = Object.values(nextBuf).reduce((a, b) => a + b, 0);

      // Record anti-whale daily foundry contribution weight
      const today = this.dayOf(t);
      const prevW = this.store.getFoundryCharWeight(foundryDef.id, check.charId);
      const priorToday = prevW && prevW.todayDay === today ? prevW.todayWeight : 0;
      const gained = effectiveContributionWeight(priorToday, msg.qty, foundryDef.antiMonopolyDailyWeightCap);
      this.store.saveFoundryCharWeight(
        foundryDef.id,
        check.charId,
        player.name,
        Math.round(((prevW?.weight ?? 0) + gained) * 100) / 100,
        today,
        priorToday + msg.qty,
      );

      const nextDepleted = Math.min(
        foundryDef.maxDepletedPermille,
        f.depletedPermille + foundryDef.depletedPermilleStep,
      );

      if (totalOre >= foundryDef.activationOreThreshold) {
        specialized = true;
        // Consume activation threshold smoothly
        let toConsume = foundryDef.activationOreThreshold;
        for (const key of Object.keys(nextBuf)) {
          if (toConsume <= 0) break;
          const have = nextBuf[key] ?? 0;
          const take = Math.min(have, toConsume);
          if (have - take <= 0) delete nextBuf[key];
          else nextBuf[key] = have - take;
          toConsume -= take;
        }
        updatedFoundry = {
          id: f.id,
          oreBuffer: nextBuf,
          activeVeinBatchId: vein.veinBatchId,
          activeTraitId: vein.traitId,
          batchesRemaining: foundryDef.batchesPerSpecialization,
          expiresAt: t + foundryDef.specializationTtlMs,
          depletedPermille: nextDepleted,
          updatedAt: t,
        };
        const siteIdForLog = foundryDef.requiresBridgeId ?? foundryDef.id;
        this.store.appendHistory({
          siteId: siteIdForLog,
          eventType: "foundry_specialized",
          actorId: check.charId,
          actorName: player.name,
          eraTag: bridgeSite?.eraTag ?? foundryDef.name,
          detail: `${foundryDef.name} specialized on ${vein.traitId} (${vein.veinBatchId}) for ${foundryDef.batchesPerSpecialization} batches`,
          createdAt: t,
        });
      } else {
        updatedFoundry = {
          ...f,
          oreBuffer: nextBuf,
          depletedPermille: nextDepleted,
          updatedAt: t,
        };
      }
      this.store.saveFoundry(updatedFoundry);

      const resPayload: Extract<CivicServerMessage, { op: "foundry_updated" }> = {
        kind: "civic",
        op: "foundry_updated",
        opId: msg.opId,
        foundry: toFoundryView(updatedFoundry, foundryDef, this.traitsById.get(updatedFoundry.activeTraitId)),
        specialized,
        replayed: false,
      };
      this.store.saveProcessedOp(opKey, JSON.stringify(resPayload), t);
    });

    let escortBonusGold = 0;
    if (bridgeDef && msg.qty > 5) {
      this.applySiteWear(bridgeDef, bridgeDef.wearPerHeavyHaul, check.charId, player.name, t);
      escortBonusGold = this.evaluateCaravanEscort(check.charId, bridgeDef.id, foundryDef.x, foundryDef.z, msg.qty, t);
    }

    const resPayload = JSON.parse(this.store.getProcessedOp(opKey)!) as Extract<CivicServerMessage, { op: "foundry_updated" }>;
    if (escortBonusGold > 0) {
      resPayload.escortBonusGold = escortBonusGold;
      this.store.db
        .prepare(`UPDATE civic_processed_ops SET result_json = ? WHERE op_key = ?`)
        .run(JSON.stringify(resPayload), opKey);
    }
    player.refreshInventory();
    player.send(resPayload);
    this.sendState(player, 0);
  }

  private handleFoundryCraft(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "foundry_craft" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:foundry_craft:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "foundry_crafted" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    const foundryDef = this.foundriesById.get(msg.townId);
    if (!foundryDef) {
      this.sendNotice(player, false, "unknown_foundry", `unknown settlement foundry "${msg.townId}"`, msg.opId);
      return;
    }
    if (!this.withinRadius(check.eid, foundryDef.x, foundryDef.z, foundryDef.interactRadiusM)) {
      this.sendNotice(player, false, "out_of_range", `move closer to ${foundryDef.name}`, msg.opId);
      return;
    }
    if (!this.opts.hasBagRoom(check.charId)) {
      this.sendNotice(player, false, "bag_full", "your bag is full", msg.opId);
      return;
    }

    const t = this.now();
    this.expireDueFoundries(t);
    const itemId = this.opts.craftAndGrantItem(check.charId, msg.item, msg.rank);
    if (itemId === null || itemId <= 0) {
      this.sendNotice(player, false, "craft_failed", `cannot craft ${msg.item} (${msg.rank}) here`, msg.opId);
      return;
    }

    const provenance = this.consumeSpecialtyAndMintProvenance(foundryDef.id, check.charId, player.name, itemId, t);
    const foundryAfter = this.store.getFoundry(foundryDef.id)!;
    const foundryView = toFoundryView(foundryAfter, foundryDef, this.traitsById.get(foundryAfter.activeTraitId));

    const payload: Extract<CivicServerMessage, { op: "foundry_crafted" }> = {
      kind: "civic",
      op: "foundry_crafted",
      opId: msg.opId,
      townId: foundryDef.id,
      item: msg.item,
      rank: msg.rank,
      itemId,
      provenance,
      foundry: foundryView,
      replayed: false,
    };
    this.store.saveProcessedOp(opKey, JSON.stringify(payload), t);
    player.refreshInventory();
    player.send(payload);
    this.sendState(player, 0);
  }

  private consumeSpecialtyAndMintProvenance(
    foundryId: string,
    crafterId: number,
    crafterName: string,
    itemId: number,
    nowMs: number,
  ): ItemProvenanceView {
    return this.store.runImmediate(() => {
      const f = this.store.getFoundry(foundryId)!;
      const foundryDef = this.foundriesById.get(foundryId);
      const bridge = foundryDef?.requiresBridgeId ? this.store.getSite(foundryDef.requiresBridgeId) : this.store.listSites()[0];
      const hasSpecialty = f.batchesRemaining > 0 && (f.expiresAt === null || nowMs < f.expiresAt);
      const usedTrait = hasSpecialty ? f.activeTraitId : "bog-standard";
      const usedVein = hasSpecialty ? (f.activeVeinBatchId ?? `${foundryId}-baseline`) : `${foundryId}-baseline`;
      if (hasSpecialty) {
        const nextBatches = f.batchesRemaining - 1;
        this.store.saveFoundry({
          ...f,
          batchesRemaining: nextBatches,
          activeTraitId: nextBatches > 0 ? f.activeTraitId : "bog-standard",
          activeVeinBatchId: nextBatches > 0 ? f.activeVeinBatchId : null,
          expiresAt: nextBatches > 0 ? f.expiresAt : null,
          updatedAt: nowMs,
        });
      }
      const minted = this.store.mintProvenance({
        veinBatchId: usedVein,
        traitId: usedTrait,
        townId: foundryId,
        crafterId,
        crafterName,
        eraTag: bridge?.eraTag ?? foundryId,
        craftedAt: nowMs,
      });
      this.store.bindItemProvenance(itemId, minted.provenanceId);
      return minted;
    });
  }

  private handleFoundryReforge(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "foundry_reforge" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:foundry_reforge:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "foundry_reforge" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    const foundryDef = this.foundriesById.get(msg.townId);
    if (!foundryDef) {
      this.sendNotice(player, false, "unknown_foundry", `unknown settlement foundry "${msg.townId}"`, msg.opId);
      return;
    }
    if (!this.withinRadius(check.eid, foundryDef.x, foundryDef.z, foundryDef.interactRadiusM)) {
      this.sendNotice(player, false, "out_of_range", `move closer to ${foundryDef.name}`, msg.opId);
      return;
    }
    if (!this.opts.ownsItem || !this.opts.ownsItem(check.charId, msg.itemId)) {
      this.sendNotice(player, false, "not_owned", "you must own and carry that item to reforge it", msg.opId);
      return;
    }
    const existingProv = this.store.getProvenanceByItemId(msg.itemId);
    if (!existingProv) {
      this.sendNotice(player, false, "no_provenance", "only items with existing provenance can be reforged", msg.opId);
      return;
    }

    const t = this.now();
    this.expireDueFoundries(t);
    const foundry = this.store.getFoundry(foundryDef.id);
    if (!foundry || !isFoundryMature(foundry, foundryDef)) {
      this.sendNotice(
        player,
        false,
        "immature_foundry",
        `${foundryDef.name} has not reached maturity for masterwork reforging`,
        msg.opId,
      );
      return;
    }
    const hasSpecialty = foundry.batchesRemaining > 0 && (foundry.expiresAt === null || t < foundry.expiresAt);
    if (!hasSpecialty) {
      this.sendNotice(
        player,
        false,
        "not_specialized",
        `${foundryDef.name} requires an active vein specialization to reforge`,
        msg.opId,
      );
      return;
    }
    const traitRes = resolveReforgeTargetTrait(existingProv.traitId, foundry.activeTraitId, this.rules.traits);
    if (!traitRes.ok) {
      this.sendNotice(player, false, traitRes.code, traitRes.message, msg.opId);
      return;
    }

    const goldCost = foundryDef.reforgeGoldCost;
    if (goldCost > 0) {
      if (this.opts.balanceOf(check.charId) < goldCost) {
        this.sendNotice(player, false, "insufficient_gold", `insufficient gold (need ${goldCost})`, msg.opId);
        return;
      }
      if (!this.opts.spendGold(check.charId, goldCost, this.currentTick)) {
        this.sendNotice(player, false, "insufficient_gold", "gold deduction failed", msg.opId);
        return;
      }
    }

    let failureNotice: { code: string; message: string } | null = null;
    try {
      this.store.runImmediate(() => {
        const f = this.store.getFoundry(foundryDef.id);
        if (!f || !isFoundryMature(f, foundryDef)) {
          failureNotice = { code: "immature_foundry", message: `${foundryDef.name} is not mature` };
          return;
        }
        if (f.batchesRemaining <= 0 || (f.expiresAt !== null && t >= f.expiresAt)) {
          failureNotice = { code: "not_specialized", message: `${foundryDef.name} specialization expired` };
          return;
        }
        const txTrait = resolveReforgeTargetTrait(existingProv.traitId, f.activeTraitId, this.rules.traits);
        if (!txTrait.ok) {
          failureNotice = { code: txTrait.code, message: txTrait.message };
          return;
        }

        const nextBatches = f.batchesRemaining - 1;
        const updatedFoundry: StoredFoundry = {
          ...f,
          batchesRemaining: nextBatches,
          activeTraitId: nextBatches > 0 ? f.activeTraitId : "bog-standard",
          activeVeinBatchId: nextBatches > 0 ? f.activeVeinBatchId : null,
          expiresAt: nextBatches > 0 ? f.expiresAt : null,
          updatedAt: t,
        };
        this.store.saveFoundry(updatedFoundry);

        const bridge = foundryDef.requiresBridgeId
          ? this.store.getSite(foundryDef.requiresBridgeId)
          : this.store.listSites()[0];
        const reforgedProv = this.store.reforgeItemProvenance(msg.itemId, {
          veinBatchId: txTrait.usedActiveSpecialty
            ? (f.activeVeinBatchId ?? existingProv.veinBatchId)
            : existingProv.veinBatchId,
          traitId: txTrait.traitId,
          townId: foundryDef.id,
          crafterId: existingProv.crafterId,
          crafterName: existingProv.crafterName,
          eraTag: bridge?.eraTag ?? existingProv.eraTag,
          craftedAt: t,
        });

        const payload: Extract<CivicServerMessage, { op: "foundry_reforge" }> = {
          kind: "civic",
          op: "foundry_reforge",
          opId: msg.opId,
          townId: foundryDef.id,
          itemId: msg.itemId,
          provenance: reforgedProv,
          goldCost,
          foundry: toFoundryView(updatedFoundry, foundryDef, this.traitsById.get(updatedFoundry.activeTraitId)),
          replayed: false,
        };
        this.store.saveProcessedOp(opKey, JSON.stringify(payload), t);
      });
    } catch (err) {
      if (goldCost > 0) this.opts.grantGold(check.charId, goldCost, this.currentTick);
      this.sendNotice(player, false, "db_error", (err as Error).message, msg.opId);
      return;
    }

    if (failureNotice) {
      if (goldCost > 0) this.opts.grantGold(check.charId, goldCost, this.currentTick);
      const errNotice = failureNotice as { code: string; message: string };
      this.sendNotice(player, false, errNotice.code, errNotice.message, msg.opId);
      return;
    }

    const storedPayload = JSON.parse(this.store.getProcessedOp(opKey)!) as Extract<CivicServerMessage, { op: "foundry_reforge" }>;
    player.refreshInventory();
    player.send(storedPayload);
    this.sendState(player, 0);
  }

  private handleCraftRepairKit(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "craft_repair_kit" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:craft_repair_kit:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "craft_repair_kit" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    const foundryDef = this.foundriesById.get(msg.townId);
    if (!foundryDef) {
      this.sendNotice(player, false, "unknown_foundry", `unknown settlement foundry "${msg.townId}"`, msg.opId);
      return;
    }
    if (!this.withinRadius(check.eid, foundryDef.x, foundryDef.z, foundryDef.interactRadiusM)) {
      this.sendNotice(player, false, "out_of_range", `move closer to ${foundryDef.name}`, msg.opId);
      return;
    }

    const t = this.now();
    this.expireDueFoundries(t);
    const foundry = this.store.getFoundry(foundryDef.id);
    if (!foundry || !isFoundryMature(foundry, foundryDef)) {
      this.sendNotice(
        player,
        false,
        "immature_foundry",
        `${foundryDef.name} has not reached maturity to craft repair kits`,
        msg.opId,
      );
      return;
    }
    if (!this.opts.hasMaterialRoom(check.charId, REPAIR_KIT_MATERIAL_ID, 1)) {
      this.sendNotice(player, false, "pouch_full", "your pouch holds no more repair kits", msg.opId);
      return;
    }

    const costEntries = Object.entries(foundryDef.repairKitCost).filter(([, qty]) => qty > 0);
    for (const [mat, qty] of costEntries) {
      if (this.opts.countMaterial(check.charId, mat) < qty) {
        this.sendNotice(player, false, "insufficient_materials", `insufficient ${mat} (need ${qty})`, msg.opId);
        return;
      }
    }

    const debited: Array<[string, number]> = [];
    for (const [mat, qty] of costEntries) {
      if (!this.opts.takeMaterial(check.charId, mat, qty)) {
        for (const [rmat, rqty] of debited) this.opts.grantMaterial(check.charId, rmat, rqty);
        this.sendNotice(player, false, "insufficient_materials", "material deduction failed", msg.opId);
        return;
      }
      debited.push([mat, qty]);
    }

    if (!this.opts.grantMaterial(check.charId, REPAIR_KIT_MATERIAL_ID, 1)) {
      for (const [rmat, rqty] of debited) this.opts.grantMaterial(check.charId, rmat, rqty);
      this.sendNotice(player, false, "pouch_full", "your pouch holds no more repair kits", msg.opId);
      return;
    }

    const consumedMaterials: Record<string, number> = {};
    for (const [mat, qty] of debited) consumedMaterials[mat] = qty;

    const payload: Extract<CivicServerMessage, { op: "craft_repair_kit" }> = {
      kind: "civic",
      op: "craft_repair_kit",
      opId: msg.opId,
      townId: foundryDef.id,
      qty: 1,
      consumedMaterials,
      foundry: toFoundryView(foundry, foundryDef, this.traitsById.get(foundry.activeTraitId)),
      replayed: false,
    };
    this.store.saveProcessedOp(opKey, JSON.stringify(payload), t);
    player.refreshInventory();
    player.send(payload);
    this.sendState(player, 0);
  }

  private evaluateCaravanEscort(
    charId: number,
    siteId: string,
    x: number,
    z: number,
    qty: number,
    nowMs: number,
  ): number {
    if (qty <= this.escort.heavyHaulThreshold) return 0;
    const rawEscorts = this.opts.nearbyEscortCount
      ? this.opts.nearbyEscortCount(charId, x, z, this.escort.escortRadiusM)
      : countNearbyEscorts(
          charId,
          x,
          z,
          this.escort.escortRadiusM,
          this.enteredPlayers.values(),
          Transform.px,
          Transform.pz,
          (eid) => this.isAlive(this.lastSim, eid),
          this.escort.maxEscortHelpers,
        );
    const res = this.escort.evaluate({
      charId,
      siteId,
      x,
      z,
      qty,
      nearbyEscortCount: rawEscorts,
      nowMs,
    });
    if (res.escortBonusGold > 0 && !this.opts.grantGold(charId, res.escortBonusGold, this.currentTick)) {
      this.store.addPendingCredits(charId, res.escortBonusGold, nowMs);
    }
    return res.escortBonusGold;
  }

  // ---- Domain 4: Escrow Frontier Contracts ----

  private handleContractPost(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "contract_post" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:contract_post:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "contract_update" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    if (msg.targetKind === "site" && !this.sitesById.has(msg.targetId)) {
      this.sendNotice(player, false, "unknown_site", `unknown target site "${msg.targetId}"`, msg.opId);
      return;
    }
    if (msg.targetKind === "foundry" && !this.foundriesById.has(msg.targetId)) {
      this.sendNotice(player, false, "unknown_foundry", `unknown target foundry "${msg.targetId}"`, msg.opId);
      return;
    }
    if (msg.qty > this.rules.contracts.maxLotSize) {
      this.sendNotice(player, false, "lot_too_large", `contract quantity exceeds max lot size (${this.rules.contracts.maxLotSize})`, msg.opId);
      return;
    }
    if (msg.rewardPerUnit > this.rules.contracts.maxRewardPerUnit) {
      this.sendNotice(player, false, "reward_too_high", "reward per unit exceeds cap", msg.opId);
      return;
    }
    if (this.store.openContractCountFor(check.charId) >= this.rules.contracts.maxOpenPerCharacter) {
      this.sendNotice(player, false, "contract_cap", "maximum open contracts reached", msg.opId);
      return;
    }

    const totals = computeContractTotals(msg.qty, msg.rewardPerUnit, this.rules.contracts.escrowFeeRate);
    if (!totals.ok) {
      this.sendNotice(player, false, "invalid_escrow", totals.error, msg.opId);
      return;
    }
    if (this.opts.balanceOf(check.charId) < totals.totalLock) {
      this.sendNotice(player, false, "insufficient_gold", `need ${totals.totalLock} gold (incl. escrow fee)`, msg.opId);
      return;
    }

    if (!this.opts.spendGold(check.charId, totals.totalLock, this.currentTick)) {
      this.sendNotice(player, false, "insufficient_gold", "escrow hold failed", msg.opId);
      return;
    }

    const t = this.now();
    const hours = Math.min(this.rules.contracts.maxDurationHours, msg.ttlHours ?? this.rules.contracts.defaultDurationHours);
    let created: StoredContract;
    try {
      created = this.store.runImmediate(() => {
        const rec = this.store.insertContract({
          posterId: check.charId,
          posterName: player.name,
          targetKind: msg.targetKind,
          targetId: msg.targetId,
          material: msg.material,
          totalQty: msg.qty,
          deliveredQty: 0,
          rewardPerUnit: msg.rewardPerUnit,
          escrowTotal: totals.subtotal,
          escrowRemaining: totals.subtotal,
          feePaid: totals.fee,
          status: "open",
          createdAt: t,
          expiresAt: t + hours * 3_600_000,
          updatedAt: t,
        });
        const payload: Extract<CivicServerMessage, { op: "contract_update" }> = {
          kind: "civic",
          op: "contract_update",
          opId: msg.opId,
          action: "posted",
          contract: toContractView(rec),
          replayed: false,
        };
        this.store.saveProcessedOp(opKey, JSON.stringify(payload), t);
        return rec;
      });
    } catch (err) {
      // Never swallow escrowed gold if SQLite persistence failed!
      this.opts.grantGold(check.charId, totals.totalLock, this.currentTick);
      this.sendNotice(player, false, "db_error", (err as Error).message, msg.opId);
      return;
    }

    player.refreshInventory();
    player.send({
      kind: "civic",
      op: "contract_update",
      opId: msg.opId,
      action: "posted",
      contract: toContractView(created),
      replayed: false,
    } satisfies CivicServerMessage);
    this.sendState(player, 0);
  }

  private handleContractDeliver(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "contract_deliver" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:contract_deliver:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "contract_update" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    const contractId = Number(msg.contractId);
    const t = this.now();
    this.store.expireDueContracts(t);
    const existing = Number.isInteger(contractId) ? this.store.getContract(contractId) : undefined;
    if (!existing) {
      this.sendNotice(player, false, "unknown_contract", `unknown contract #${msg.contractId}`, msg.opId);
      return;
    }
    if (existing.status !== "open" || existing.expiresAt <= t) {
      this.sendNotice(player, false, "contract_closed", `contract #${msg.contractId} is ${existing.status}`, msg.opId);
      return;
    }

    // Proximity to target site or foundry required
    if (existing.targetKind === "site") {
      const def = this.sitesById.get(existing.targetId);
      if (!def || !this.withinRadius(check.eid, def.x, def.z, def.interactRadiusM)) {
        this.sendNotice(player, false, "out_of_range", "deliver directly at the civic site", msg.opId);
        return;
      }
    } else {
      const def = this.foundriesById.get(existing.targetId);
      if (!def || !this.withinRadius(check.eid, def.x, def.z, def.interactRadiusM)) {
        this.sendNotice(player, false, "out_of_range", "deliver directly at the destination foundry", msg.opId);
        return;
      }
      if (def.requiresBridgeId) {
        const b = this.store.getSite(def.requiresBridgeId);
        if (!b || b.stage < 1 || b.damaged) {
          this.sendNotice(player, false, "crossing_blocked", "bridge route to foundry is blocked", msg.opId);
          return;
        }
      }
    }

    const acceptedQty = Math.min(msg.qty, existing.totalQty - existing.deliveredQty);
    if (acceptedQty <= 0) {
      this.sendNotice(player, false, "already_filled", "contract is already fulfilled", msg.opId);
      return;
    }
    if (this.opts.countMaterial(check.charId, existing.material) < acceptedQty) {
      this.sendNotice(player, false, "insufficient_materials", `insufficient ${existing.material} (need ${acceptedQty})`, msg.opId);
      return;
    }
    if (!this.opts.takeMaterial(check.charId, existing.material, acceptedQty)) {
      this.sendNotice(player, false, "insufficient_materials", "material deduction failed", msg.opId);
      return;
    }

    let payoutGold = 0;
    let outcome: StoredContract | null = null;
    try {
      outcome = this.store.runImmediate(() => {
        const row = this.store.getContract(existing.id);
        if (!row || row.status !== "open" || row.expiresAt <= t) return null;
        const clamped = Math.min(acceptedQty, row.totalQty - row.deliveredQty);
        if (clamped <= 0) return null;
        payoutGold = clamped * row.rewardPerUnit;
        if (payoutGold > row.escrowRemaining) return null;

        const nextDelivered = row.deliveredQty + clamped;
        const nextEscrow = row.escrowRemaining - payoutGold;
        const nextStatus = nextDelivered >= row.totalQty ? "filled" : "open";
        const res = this.store.db
          .prepare(
            `UPDATE civic_contracts
             SET delivered_qty = ?, escrow_remaining = ?, status = ?, updated_at = ?
             WHERE id = ? AND status = 'open' AND escrow_remaining >= ?`,
          )
          .run(nextDelivered, nextEscrow, nextStatus, t, row.id, payoutGold);
        if (res.changes !== 1) return null;

        const updated: StoredContract = {
          ...row,
          deliveredQty: nextDelivered,
          escrowRemaining: nextEscrow,
          status: nextStatus,
          updatedAt: t,
        };

        // Route delivered materials into destination site or foundry buffer
        if (row.targetKind === "site") {
          const site = this.store.getSite(row.targetId);
          if (site) {
            const p = { ...site.progress };
            p[row.material] = (p[row.material] ?? 0) + clamped;
            this.store.saveSite({ ...site, progress: p, updatedAt: t });
          }
        } else {
          const foundry = this.store.getFoundry(row.targetId);
          if (foundry) {
            const buf = { ...foundry.oreBuffer };
            buf[row.material] = (buf[row.material] ?? 0) + clamped;
            this.store.saveFoundry({ ...foundry, oreBuffer: buf, updatedAt: t });
          }
        }

        const msgOut: Extract<CivicServerMessage, { op: "contract_update" }> = {
          kind: "civic",
          op: "contract_update",
          opId: msg.opId,
          action: "delivered",
          contract: toContractView(updated),
          acceptedQty: clamped,
          payoutGold,
          replayed: false,
        };
        this.store.saveProcessedOp(opKey, JSON.stringify(msgOut), t);
        return updated;
      });
    } catch {
      outcome = null;
    }

    if (!outcome) {
      // Atomic race lost or validation failed -> full material refund!
      this.opts.grantMaterial(check.charId, existing.material, acceptedQty);
      this.sendNotice(player, false, "contract_race", "contract closed before delivery committed", msg.opId);
      return;
    }

    if (payoutGold > 0 && !this.opts.grantGold(check.charId, payoutGold, this.currentTick)) {
      this.store.addPendingCredits(check.charId, payoutGold, t);
    }

    const resPayload = JSON.parse(this.store.getProcessedOp(opKey)!) as Extract<CivicServerMessage, { op: "contract_update" }>;
    const deliveredUnits = resPayload.acceptedQty ?? 0;
    if (deliveredUnits > this.escort.heavyHaulThreshold) {
      let siteId = outcome.targetId;
      let tx = 0;
      let tz = 0;
      if (outcome.targetKind === "site") {
        const sDef = this.sitesById.get(outcome.targetId);
        if (sDef) {
          tx = sDef.x;
          tz = sDef.z;
        }
      } else {
        const fDef = this.foundriesById.get(outcome.targetId);
        if (fDef) {
          siteId = fDef.requiresBridgeId ?? fDef.id;
          tx = fDef.x;
          tz = fDef.z;
        }
      }
      const escortBonusGold = this.evaluateCaravanEscort(check.charId, siteId, tx, tz, deliveredUnits, t);
      if (escortBonusGold > 0) {
        resPayload.escortBonusGold = escortBonusGold;
        this.store.db
          .prepare(`UPDATE civic_processed_ops SET result_json = ? WHERE op_key = ?`)
          .run(JSON.stringify(resPayload), opKey);
      }
    }

    player.refreshInventory();
    player.send(resPayload);
    this.sendState(player, 0);
  }

  private handleContractCancel(player: ExtensionPlayer, msg: Extract<CivicClientMessage, { op: "contract_cancel" }>): void {
    const check = this.checkAlive(player);
    if (!check.ok) {
      this.sendNotice(player, false, check.code, check.error, msg.opId);
      return;
    }
    const opKey = `${check.charId}:contract_cancel:${msg.opId}`;
    const replayed = this.store.getProcessedOp(opKey);
    if (replayed) {
      const payload = JSON.parse(replayed) as Extract<CivicServerMessage, { op: "contract_update" }>;
      player.send({ ...payload, replayed: true });
      return;
    }

    const contractId = Number(msg.contractId);
    const t = this.now();
    this.store.expireDueContracts(t);

    let refund = 0;
    let cancelled: StoredContract | null = null;
    let failureCode: string | null = null;

    this.store.runImmediate(() => {
      const row = Number.isInteger(contractId) ? this.store.getContract(contractId) : undefined;
      if (!row) {
        failureCode = "unknown_contract";
        return;
      }
      if (row.posterId !== check.charId) {
        failureCode = "not_owner";
        return;
      }
      if (row.status !== "open") {
        failureCode = "not_open";
        return;
      }
      refund = row.escrowRemaining;
      const res = this.store.db
        .prepare(
          `UPDATE civic_contracts
           SET status = 'cancelled', escrow_remaining = 0, updated_at = ?
           WHERE id = ? AND poster_id = ? AND status = 'open'`,
        )
        .run(t, row.id, check.charId);
      if (res.changes !== 1) {
        failureCode = "contract_race";
        return;
      }
      cancelled = { ...row, status: "cancelled", escrowRemaining: 0, updatedAt: t };
      const msgOut: Extract<CivicServerMessage, { op: "contract_update" }> = {
        kind: "civic",
        op: "contract_update",
        opId: msg.opId,
        action: "cancelled",
        contract: toContractView(cancelled),
        refundedGold: refund,
        replayed: false,
      };
      this.store.saveProcessedOp(opKey, JSON.stringify(msgOut), t);
    });

    if (failureCode || !cancelled) {
      this.sendNotice(player, false, failureCode ?? "cancel_failed", `cannot cancel contract #${msg.contractId}`, msg.opId);
      return;
    }

    if (refund > 0 && !this.opts.grantGold(check.charId, refund, this.currentTick)) {
      this.store.addPendingCredits(check.charId, refund, t);
    }

    const resPayload = JSON.parse(this.store.getProcessedOp(opKey)!) as Extract<CivicServerMessage, { op: "contract_update" }>;
    player.refreshInventory();
    player.send(resPayload);
    this.sendState(player, 0);
  }
}
