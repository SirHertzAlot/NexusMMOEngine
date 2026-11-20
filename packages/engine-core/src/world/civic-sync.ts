/**
 * CivicWorldSync — Track B4: Multi-Region Snapshot Export & Atomic Recall
 * for the Redwater Crossing Living Regional Provenance & Civic Logistics SQLite store.
 *
 * Exports and atomically imports all 10 persistent civic tables inside
 * `store.runImmediate(...)`:
 *   - civic_sites
 *   - civic_contributors
 *   - civic_history
 *   - civic_veins
 *   - civic_foundries
 *   - civic_foundry_char_weights
 *   - civic_contracts
 *   - civic_pending_credits
 *   - civic_provenance
 *   - civic_item_provenance
 *
 * Validation runs strictly via Zod BEFORE opening any SQLite write transaction,
 * so malformed, partial, negative-escrow, or oversized snapshots are rejected
 * cleanly without partially mutating the database.
 */

import { z } from "zod";
import type {
  CivicHistoryEventType,
  SqliteCivicStore,
  StoredContractStatus,
} from "../civic/civic-store.js";

export const CIVIC_SNAPSHOT_VERSION = 1 as const;
/** Size ceiling for serialized civic snapshot JSON payloads (2 MiB, fits within world shard payload). */
export const MAX_CIVIC_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const nonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const finiteNum = z.number().finite();
const nonNegFinite = z.number().finite().min(0);
const slugStr = z.string().min(1).max(64);
const batchIdStr = z.string().min(1).max(128);

const intMapSchema = z
  .record(z.string().min(1).max(64), nonNegInt)
  .refine((m) => Object.keys(m).length <= 128, {
    message: "resource map exceeds 128 keys",
  });

export const CivicSiteSnapshotRowSchema = z.strictObject({
  id: slugStr,
  stage: z.number().int().min(0).max(100),
  progress: intMapSchema,
  goldProgress: nonNegInt,
  repairProgress: intMapSchema,
  repairGoldProgress: nonNegInt,
  wear: nonNegInt,
  damaged: z.boolean(),
  eraTag: z.string().min(1).max(64),
  updatedAt: nonNegInt,
});

export const CivicContributorSnapshotRowSchema = z.strictObject({
  siteId: slugStr,
  charId: nonNegInt,
  name: z.string().min(1).max(64),
  rawScore: nonNegInt,
  effectiveWeight: nonNegFinite,
  todayDay: nonNegInt,
  todayRaw: nonNegInt,
  updatedAt: nonNegInt,
});

export const CivicHistorySnapshotRowSchema = z.strictObject({
  seq: positiveInt,
  siteId: slugStr,
  eventType: z.enum([
    "contributed",
    "stage_advanced",
    "damaged",
    "repaired",
    "foundry_specialized",
    "era_shift",
    "admin_override",
  ]),
  actorId: nonNegInt,
  actorName: z.string().min(1).max(64),
  eraTag: z.string().min(1).max(64),
  detail: z.string().min(1).max(512),
  createdAt: nonNegInt,
});

export const CivicVeinSnapshotRowSchema = z
  .strictObject({
    veinBatchId: batchIdStr,
    templateId: slugStr,
    traitId: slugStr,
    material: slugStr,
    x: finiteNum,
    z: finiteNum,
    anchorIndex: nonNegInt,
    stock: nonNegInt,
    maxStock: positiveInt,
    discoveredByCharId: nonNegInt.nullable(),
    discoveredByName: z.string().min(1).max(64).nullable(),
    discoveredAt: nonNegInt.nullable(),
    respawnAt: nonNegInt.nullable(),
    createdAt: nonNegInt,
  })
  .refine((v) => v.stock <= v.maxStock, {
    message: "vein stock cannot exceed maxStock",
    path: ["stock"],
  });

export const CivicFoundrySnapshotRowSchema = z.strictObject({
  id: slugStr,
  oreBuffer: intMapSchema,
  activeVeinBatchId: batchIdStr.nullable(),
  activeTraitId: slugStr,
  batchesRemaining: nonNegInt,
  expiresAt: nonNegInt.nullable(),
  depletedPermille: z.number().int().min(0).max(1000),
  updatedAt: nonNegInt,
});

export const CivicFoundryCharWeightSnapshotRowSchema = z.strictObject({
  foundryId: slugStr,
  charId: nonNegInt,
  name: z.string().min(1).max(64),
  weight: nonNegFinite,
  todayDay: nonNegInt,
  todayWeight: nonNegFinite,
});

export const CivicContractSnapshotRowSchema = z
  .strictObject({
    id: positiveInt,
    posterId: nonNegInt,
    posterName: z.string().min(1).max(64),
    targetKind: z.enum(["site", "foundry"]),
    targetId: slugStr,
    material: slugStr,
    totalQty: positiveInt,
    deliveredQty: nonNegInt,
    rewardPerUnit: positiveInt,
    escrowTotal: nonNegInt,
    escrowRemaining: nonNegInt,
    feePaid: nonNegInt,
    status: z.enum(["open", "filled", "cancelled", "expired"]),
    createdAt: nonNegInt,
    expiresAt: nonNegInt,
    updatedAt: nonNegInt,
  })
  .refine((c) => c.deliveredQty <= c.totalQty, {
    message: "deliveredQty cannot exceed totalQty",
    path: ["deliveredQty"],
  })
  .refine((c) => c.escrowRemaining <= c.escrowTotal, {
    message: "escrowRemaining cannot exceed escrowTotal",
    path: ["escrowRemaining"],
  });

export const CivicPendingCreditSnapshotRowSchema = z.strictObject({
  charId: nonNegInt,
  amount: nonNegInt,
  updatedAt: nonNegInt,
});

export const CivicProvenanceSnapshotRowSchema = z.strictObject({
  provenanceId: positiveInt,
  veinBatchId: batchIdStr,
  traitId: slugStr,
  townId: slugStr,
  crafterId: nonNegInt,
  crafterName: z.string().min(1).max(64),
  eraTag: z.string().min(1).max(64),
  craftedAt: nonNegInt,
});

export const CivicItemProvenanceSnapshotRowSchema = z.strictObject({
  itemId: positiveInt,
  provenanceId: positiveInt,
});

export const CivicWorldSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(CIVIC_SNAPSHOT_VERSION),
    exportedAt: nonNegInt.optional(),
    civic_sites: z.array(CivicSiteSnapshotRowSchema).max(4096),
    civic_contributors: z.array(CivicContributorSnapshotRowSchema).max(20_000),
    civic_history: z.array(CivicHistorySnapshotRowSchema).max(20_000),
    civic_veins: z.array(CivicVeinSnapshotRowSchema).max(4096),
    civic_foundries: z.array(CivicFoundrySnapshotRowSchema).max(4096),
    civic_foundry_char_weights: z.array(CivicFoundryCharWeightSnapshotRowSchema).max(20_000),
    civic_contracts: z.array(CivicContractSnapshotRowSchema).max(20_000),
    civic_pending_credits: z.array(CivicPendingCreditSnapshotRowSchema).max(20_000),
    civic_provenance: z.array(CivicProvenanceSnapshotRowSchema).max(50_000),
    civic_item_provenance: z.array(CivicItemProvenanceSnapshotRowSchema).max(50_000),
  })
  .refine((snap) => Buffer.byteLength(JSON.stringify(snap)) <= MAX_CIVIC_SNAPSHOT_BYTES, {
    message: `civic snapshot exceeds ${MAX_CIVIC_SNAPSHOT_BYTES} bytes`,
  });

export type CivicWorldSnapshot = z.infer<typeof CivicWorldSnapshotSchema>;

export interface ImportCivicSnapshotOptions {
  /**
   * When true, snapshot rows unconditionally overwrite conflicting primary keys
   * (authoritative fleet recall). When false (default), monotonic timestamps /
   * sequence guards preserve newer local state and skip older rows.
   */
  authoritative?: boolean;
}

export interface CivicSnapshotImportResult {
  authoritative: boolean;
  totalRows: number;
  appliedRows: number;
  tables: {
    civic_sites: number;
    civic_contributors: number;
    civic_history: number;
    civic_veins: number;
    civic_foundries: number;
    civic_foundry_char_weights: number;
    civic_contracts: number;
    civic_pending_credits: number;
    civic_provenance: number;
    civic_item_provenance: number;
  };
}

function parseNonNegIntMap(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k.length > 0 && typeof v === "number" && Number.isFinite(v) && v >= 0) {
        out[k] = Math.trunc(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Export a consistent point-in-time snapshot of all 10 civic tables inside
 * a single `store.runImmediate(...)` transaction.
 */
export function exportCivicSnapshot(
  store: SqliteCivicStore,
  nowMs: number = Date.now(),
): CivicWorldSnapshot {
  const snapshot = store.runImmediate((): CivicWorldSnapshot => {
    const sites = (
      store.db
        .prepare(
          `SELECT id, stage, progress, gold_progress, repair_progress, repair_gold_progress,
                  wear, damaged, era_tag, updated_at
           FROM civic_sites ORDER BY id ASC`,
        )
        .all() as Array<{
        id: string;
        stage: number;
        progress: string;
        gold_progress: number;
        repair_progress: string;
        repair_gold_progress: number;
        wear: number;
        damaged: number;
        era_tag: string;
        updated_at: number;
      }>
    ).map((r) => ({
      id: r.id,
      stage: r.stage,
      progress: parseNonNegIntMap(r.progress),
      goldProgress: r.gold_progress,
      repairProgress: parseNonNegIntMap(r.repair_progress),
      repairGoldProgress: r.repair_gold_progress,
      wear: r.wear,
      damaged: r.damaged !== 0,
      eraTag: r.era_tag,
      updatedAt: r.updated_at,
    }));

    const contributors = (
      store.db
        .prepare(
          `SELECT site_id, char_id, name, raw_score, effective_weight, today_day, today_raw, updated_at
           FROM civic_contributors ORDER BY site_id ASC, char_id ASC`,
        )
        .all() as Array<{
        site_id: string;
        char_id: number;
        name: string;
        raw_score: number;
        effective_weight: number;
        today_day: number;
        today_raw: number;
        updated_at: number;
      }>
    ).map((r) => ({
      siteId: r.site_id,
      charId: r.char_id,
      name: r.name,
      rawScore: r.raw_score,
      effectiveWeight: r.effective_weight,
      todayDay: r.today_day,
      todayRaw: r.today_raw,
      updatedAt: r.updated_at,
    }));

    const history = (
      store.db
        .prepare(
          `SELECT seq, site_id, event_type, actor_id, actor_name, era_tag, detail, created_at
           FROM civic_history ORDER BY seq ASC`,
        )
        .all() as Array<{
        seq: number;
        site_id: string;
        event_type: CivicHistoryEventType;
        actor_id: number;
        actor_name: string;
        era_tag: string;
        detail: string;
        created_at: number;
      }>
    ).map((r) => ({
      seq: r.seq,
      siteId: r.site_id,
      eventType: r.event_type,
      actorId: r.actor_id,
      actorName: r.actor_name,
      eraTag: r.era_tag,
      detail: r.detail,
      createdAt: r.created_at,
    }));

    const veins = (
      store.db
        .prepare(
          `SELECT vein_batch_id, template_id, trait_id, material, x, z, anchor_index,
                  stock, max_stock, discovered_by_char_id, discovered_by_name,
                  discovered_at, respawn_at, created_at
           FROM civic_veins ORDER BY created_at ASC, vein_batch_id ASC`,
        )
        .all() as Array<{
        vein_batch_id: string;
        template_id: string;
        trait_id: string;
        material: string;
        x: number;
        z: number;
        anchor_index: number;
        stock: number;
        max_stock: number;
        discovered_by_char_id: number | null;
        discovered_by_name: string | null;
        discovered_at: number | null;
        respawn_at: number | null;
        created_at: number;
      }>
    ).map((r) => ({
      veinBatchId: r.vein_batch_id,
      templateId: r.template_id,
      traitId: r.trait_id,
      material: r.material,
      x: r.x,
      z: r.z,
      anchorIndex: r.anchor_index,
      stock: r.stock,
      maxStock: r.max_stock,
      discoveredByCharId: r.discovered_by_char_id,
      discoveredByName: r.discovered_by_name,
      discoveredAt: r.discovered_at,
      respawnAt: r.respawn_at,
      createdAt: r.created_at,
    }));

    const foundries = (
      store.db
        .prepare(
          `SELECT id, ore_buffer, active_vein_batch_id, active_trait_id, batches_remaining,
                  expires_at, depleted_permille, updated_at
           FROM civic_foundries ORDER BY id ASC`,
        )
        .all() as Array<{
        id: string;
        ore_buffer: string;
        active_vein_batch_id: string | null;
        active_trait_id: string;
        batches_remaining: number;
        expires_at: number | null;
        depleted_permille: number;
        updated_at: number;
      }>
    ).map((r) => ({
      id: r.id,
      oreBuffer: parseNonNegIntMap(r.ore_buffer),
      activeVeinBatchId: r.active_vein_batch_id,
      activeTraitId: r.active_trait_id,
      batchesRemaining: r.batches_remaining,
      expiresAt: r.expires_at,
      depletedPermille: r.depleted_permille,
      updatedAt: r.updated_at,
    }));

    const foundryCharWeights = (
      store.db
        .prepare(
          `SELECT foundry_id, char_id, name, weight, today_day, today_weight
           FROM civic_foundry_char_weights ORDER BY foundry_id ASC, char_id ASC`,
        )
        .all() as Array<{
        foundry_id: string;
        char_id: number;
        name: string;
        weight: number;
        today_day: number;
        today_weight: number;
      }>
    ).map((r) => ({
      foundryId: r.foundry_id,
      charId: r.char_id,
      name: r.name,
      weight: r.weight,
      todayDay: r.today_day,
      todayWeight: r.today_weight,
    }));

    const contracts = (
      store.db
        .prepare(
          `SELECT id, poster_id, poster_name, target_kind, target_id, material,
                  total_qty, delivered_qty, reward_per_unit, escrow_total, escrow_remaining,
                  fee_paid, status, created_at, expires_at, updated_at
           FROM civic_contracts ORDER BY id ASC`,
        )
        .all() as Array<{
        id: number;
        poster_id: number;
        poster_name: string;
        target_kind: "site" | "foundry";
        target_id: string;
        material: string;
        total_qty: number;
        delivered_qty: number;
        reward_per_unit: number;
        escrow_total: number;
        escrow_remaining: number;
        fee_paid: number;
        status: StoredContractStatus;
        created_at: number;
        expires_at: number;
        updated_at: number;
      }>
    ).map((r) => ({
      id: r.id,
      posterId: r.poster_id,
      posterName: r.poster_name,
      targetKind: r.target_kind,
      targetId: r.target_id,
      material: r.material,
      totalQty: r.total_qty,
      deliveredQty: r.delivered_qty,
      rewardPerUnit: r.reward_per_unit,
      escrowTotal: r.escrow_total,
      escrowRemaining: r.escrow_remaining,
      feePaid: r.fee_paid,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      updatedAt: r.updated_at,
    }));

    const pendingCredits = (
      store.db
        .prepare(
          `SELECT char_id, amount, updated_at
           FROM civic_pending_credits ORDER BY char_id ASC`,
        )
        .all() as Array<{ char_id: number; amount: number; updated_at: number }>
    ).map((r) => ({
      charId: r.char_id,
      amount: r.amount,
      updatedAt: r.updated_at,
    }));

    const provenance = (
      store.db
        .prepare(
          `SELECT provenance_id, vein_batch_id, trait_id, town_id, crafter_id,
                  crafter_name, era_tag, crafted_at
           FROM civic_provenance ORDER BY provenance_id ASC`,
        )
        .all() as Array<{
        provenance_id: number;
        vein_batch_id: string;
        trait_id: string;
        town_id: string;
        crafter_id: number;
        crafter_name: string;
        era_tag: string;
        crafted_at: number;
      }>
    ).map((r) => ({
      provenanceId: r.provenance_id,
      veinBatchId: r.vein_batch_id,
      traitId: r.trait_id,
      townId: r.town_id,
      crafterId: r.crafter_id,
      crafterName: r.crafter_name,
      eraTag: r.era_tag,
      craftedAt: r.crafted_at,
    }));

    const itemProvenance = (
      store.db
        .prepare(
          `SELECT item_id, provenance_id
           FROM civic_item_provenance ORDER BY item_id ASC`,
        )
        .all() as Array<{ item_id: number; provenance_id: number }>
    ).map((r) => ({
      itemId: r.item_id,
      provenanceId: r.provenance_id,
    }));

    return {
      schemaVersion: CIVIC_SNAPSHOT_VERSION,
      exportedAt: Math.max(0, Math.trunc(nowMs)),
      civic_sites: sites,
      civic_contributors: contributors,
      civic_history: history,
      civic_veins: veins,
      civic_foundries: foundries,
      civic_foundry_char_weights: foundryCharWeights,
      civic_contracts: contracts,
      civic_pending_credits: pendingCredits,
      civic_provenance: provenance,
      civic_item_provenance: itemProvenance,
    };
  });

  return CivicWorldSnapshotSchema.parse(snapshot);
}

/**
 * Validate `rawSnapshot` via `CivicWorldSnapshotSchema` and atomically import
 * all 10 civic tables inside `store.runImmediate(...)`.
 *
 * Invalid/partial/negative-escrow/oversized payloads throw `z.ZodError` before
 * any SQLite transaction begins, leaving the database untouched.
 */
export function importCivicSnapshot(
  store: SqliteCivicStore,
  rawSnapshot: unknown,
  opts: ImportCivicSnapshotOptions = {},
): CivicSnapshotImportResult {
  const snap = CivicWorldSnapshotSchema.parse(rawSnapshot);
  const authoritative = opts.authoritative === true;

  const tables = store.runImmediate(() => {
    const db = store.db;
    const counts = {
      civic_sites: 0,
      civic_contributors: 0,
      civic_history: 0,
      civic_veins: 0,
      civic_foundries: 0,
      civic_foundry_char_weights: 0,
      civic_contracts: 0,
      civic_pending_credits: 0,
      civic_provenance: 0,
      civic_item_provenance: 0,
    };

    const siteStmt = db.prepare(
      `INSERT INTO civic_sites (
         id, stage, progress, gold_progress, repair_progress, repair_gold_progress,
         wear, damaged, era_tag, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         stage = excluded.stage,
         progress = excluded.progress,
         gold_progress = excluded.gold_progress,
         repair_progress = excluded.repair_progress,
         repair_gold_progress = excluded.repair_gold_progress,
         wear = excluded.wear,
         damaged = excluded.damaged,
         era_tag = excluded.era_tag,
         updated_at = excluded.updated_at${
           authoritative ? "" : " WHERE excluded.updated_at >= civic_sites.updated_at"
         }`,
    );
    for (const s of snap.civic_sites) {
      counts.civic_sites += siteStmt.run(
        s.id,
        s.stage,
        JSON.stringify(s.progress),
        s.goldProgress,
        JSON.stringify(s.repairProgress),
        s.repairGoldProgress,
        s.wear,
        s.damaged ? 1 : 0,
        s.eraTag,
        s.updatedAt,
      ).changes;
    }

    const contribStmt = db.prepare(
      `INSERT INTO civic_contributors (
         site_id, char_id, name, raw_score, effective_weight, today_day, today_raw, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, char_id) DO UPDATE SET
         name = excluded.name,
         raw_score = excluded.raw_score,
         effective_weight = excluded.effective_weight,
         today_day = excluded.today_day,
         today_raw = excluded.today_raw,
         updated_at = excluded.updated_at${
           authoritative ? "" : " WHERE excluded.updated_at >= civic_contributors.updated_at"
         }`,
    );
    for (const c of snap.civic_contributors) {
      counts.civic_contributors += contribStmt.run(
        c.siteId,
        c.charId,
        c.name,
        c.rawScore,
        c.effectiveWeight,
        c.todayDay,
        c.todayRaw,
        c.updatedAt,
      ).changes;
    }

    const historyStmt = db.prepare(
      authoritative
        ? `INSERT INTO civic_history (
             seq, site_id, event_type, actor_id, actor_name, era_tag, detail, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(seq) DO UPDATE SET
             site_id = excluded.site_id,
             event_type = excluded.event_type,
             actor_id = excluded.actor_id,
             actor_name = excluded.actor_name,
             era_tag = excluded.era_tag,
             detail = excluded.detail,
             created_at = excluded.created_at`
        : `INSERT INTO civic_history (
             seq, site_id, event_type, actor_id, actor_name, era_tag, detail, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(seq) DO NOTHING`,
    );
    for (const h of snap.civic_history) {
      counts.civic_history += historyStmt.run(
        h.seq,
        h.siteId,
        h.eventType,
        h.actorId,
        h.actorName,
        h.eraTag,
        h.detail,
        h.createdAt,
      ).changes;
    }

    const veinStmt = db.prepare(
      `INSERT INTO civic_veins (
         vein_batch_id, template_id, trait_id, material, x, z, anchor_index,
         stock, max_stock, discovered_by_char_id, discovered_by_name,
         discovered_at, respawn_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vein_batch_id) DO UPDATE SET
         template_id = excluded.template_id,
         trait_id = excluded.trait_id,
         material = excluded.material,
         x = excluded.x,
         z = excluded.z,
         anchor_index = excluded.anchor_index,
         stock = excluded.stock,
         max_stock = excluded.max_stock,
         discovered_by_char_id = excluded.discovered_by_char_id,
         discovered_by_name = excluded.discovered_by_name,
         discovered_at = excluded.discovered_at,
         respawn_at = excluded.respawn_at,
         created_at = excluded.created_at${
           authoritative
             ? ""
             : ` WHERE excluded.created_at > civic_veins.created_at
                 OR (
                   excluded.created_at = civic_veins.created_at
                   AND excluded.stock <= civic_veins.stock
                   AND (excluded.discovered_at IS NOT NULL OR civic_veins.discovered_at IS NULL)
                 )`
         }`,
    );
    for (const v of snap.civic_veins) {
      counts.civic_veins += veinStmt.run(
        v.veinBatchId,
        v.templateId,
        v.traitId,
        v.material,
        v.x,
        v.z,
        v.anchorIndex,
        v.stock,
        v.maxStock,
        v.discoveredByCharId,
        v.discoveredByName,
        v.discoveredAt,
        v.respawnAt,
        v.createdAt,
      ).changes;
    }

    const foundryStmt = db.prepare(
      `INSERT INTO civic_foundries (
         id, ore_buffer, active_vein_batch_id, active_trait_id, batches_remaining,
         expires_at, depleted_permille, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ore_buffer = excluded.ore_buffer,
         active_vein_batch_id = excluded.active_vein_batch_id,
         active_trait_id = excluded.active_trait_id,
         batches_remaining = excluded.batches_remaining,
         expires_at = excluded.expires_at,
         depleted_permille = excluded.depleted_permille,
         updated_at = excluded.updated_at${
           authoritative ? "" : " WHERE excluded.updated_at >= civic_foundries.updated_at"
         }`,
    );
    for (const f of snap.civic_foundries) {
      counts.civic_foundries += foundryStmt.run(
        f.id,
        JSON.stringify(f.oreBuffer),
        f.activeVeinBatchId,
        f.activeTraitId,
        f.batchesRemaining,
        f.expiresAt,
        f.depletedPermille,
        f.updatedAt,
      ).changes;
    }

    const weightStmt = db.prepare(
      `INSERT INTO civic_foundry_char_weights (
         foundry_id, char_id, name, weight, today_day, today_weight
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(foundry_id, char_id) DO UPDATE SET
         name = excluded.name,
         weight = excluded.weight,
         today_day = excluded.today_day,
         today_weight = excluded.today_weight${
           authoritative
             ? ""
             : ` WHERE excluded.today_day > civic_foundry_char_weights.today_day
                 OR (
                   excluded.today_day = civic_foundry_char_weights.today_day
                   AND excluded.weight >= civic_foundry_char_weights.weight
                 )`
         }`,
    );
    for (const w of snap.civic_foundry_char_weights) {
      counts.civic_foundry_char_weights += weightStmt.run(
        w.foundryId,
        w.charId,
        w.name,
        w.weight,
        w.todayDay,
        w.todayWeight,
      ).changes;
    }

    const contractStmt = db.prepare(
      `INSERT INTO civic_contracts (
         id, poster_id, poster_name, target_kind, target_id, material,
         total_qty, delivered_qty, reward_per_unit, escrow_total, escrow_remaining,
         fee_paid, status, created_at, expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         poster_id = excluded.poster_id,
         poster_name = excluded.poster_name,
         target_kind = excluded.target_kind,
         target_id = excluded.target_id,
         material = excluded.material,
         total_qty = excluded.total_qty,
         delivered_qty = excluded.delivered_qty,
         reward_per_unit = excluded.reward_per_unit,
         escrow_total = excluded.escrow_total,
         escrow_remaining = excluded.escrow_remaining,
         fee_paid = excluded.fee_paid,
         status = excluded.status,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at${
           authoritative ? "" : " WHERE excluded.updated_at >= civic_contracts.updated_at"
         }`,
    );
    for (const c of snap.civic_contracts) {
      counts.civic_contracts += contractStmt.run(
        c.id,
        c.posterId,
        c.posterName,
        c.targetKind,
        c.targetId,
        c.material,
        c.totalQty,
        c.deliveredQty,
        c.rewardPerUnit,
        c.escrowTotal,
        c.escrowRemaining,
        c.feePaid,
        c.status,
        c.createdAt,
        c.expiresAt,
        c.updatedAt,
      ).changes;
    }

    const creditStmt = db.prepare(
      `INSERT INTO civic_pending_credits (char_id, amount, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(char_id) DO UPDATE SET
         amount = excluded.amount,
         updated_at = excluded.updated_at${
           authoritative ? "" : " WHERE excluded.updated_at >= civic_pending_credits.updated_at"
         }`,
    );
    for (const cr of snap.civic_pending_credits) {
      counts.civic_pending_credits += creditStmt.run(
        cr.charId,
        cr.amount,
        cr.updatedAt,
      ).changes;
    }

    const provStmt = db.prepare(
      authoritative
        ? `INSERT INTO civic_provenance (
             provenance_id, vein_batch_id, trait_id, town_id, crafter_id,
             crafter_name, era_tag, crafted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provenance_id) DO UPDATE SET
             vein_batch_id = excluded.vein_batch_id,
             trait_id = excluded.trait_id,
             town_id = excluded.town_id,
             crafter_id = excluded.crafter_id,
             crafter_name = excluded.crafter_name,
             era_tag = excluded.era_tag,
             crafted_at = excluded.crafted_at`
        : `INSERT INTO civic_provenance (
             provenance_id, vein_batch_id, trait_id, town_id, crafter_id,
             crafter_name, era_tag, crafted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provenance_id) DO NOTHING`,
    );
    for (const p of snap.civic_provenance) {
      counts.civic_provenance += provStmt.run(
        p.provenanceId,
        p.veinBatchId,
        p.traitId,
        p.townId,
        p.crafterId,
        p.crafterName,
        p.eraTag,
        p.craftedAt,
      ).changes;
    }

    const itemProvStmt = db.prepare(
      `INSERT INTO civic_item_provenance (item_id, provenance_id)
       VALUES (?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         provenance_id = excluded.provenance_id${
           authoritative
             ? ""
             : " WHERE excluded.provenance_id >= civic_item_provenance.provenance_id"
         }`,
    );
    for (const ip of snap.civic_item_provenance) {
      counts.civic_item_provenance += itemProvStmt.run(ip.itemId, ip.provenanceId).changes;
    }

    return counts;
  });

  const totalRows =
    snap.civic_sites.length +
    snap.civic_contributors.length +
    snap.civic_history.length +
    snap.civic_veins.length +
    snap.civic_foundries.length +
    snap.civic_foundry_char_weights.length +
    snap.civic_contracts.length +
    snap.civic_pending_credits.length +
    snap.civic_provenance.length +
    snap.civic_item_provenance.length;

  const appliedRows =
    tables.civic_sites +
    tables.civic_contributors +
    tables.civic_history +
    tables.civic_veins +
    tables.civic_foundries +
    tables.civic_foundry_char_weights +
    tables.civic_contracts +
    tables.civic_pending_credits +
    tables.civic_provenance +
    tables.civic_item_provenance;

  return {
    authoritative,
    totalRows,
    appliedRows,
    tables,
  };
}
