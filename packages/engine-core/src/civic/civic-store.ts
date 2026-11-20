/**
 * SqliteCivicStore — durable SQLite (WAL) persistence for the Redwater Crossing
 * Living Regional Provenance & Civic Logistics slice:
 *
 * - Civic restoration sites (stage, partial materials & gold, traffic wear,
 *   damaged state, repair progress, anti-whale contributors, append-only plaques)
 * - Dynamic finite ore veins (hidden pre-discovery coordinates, stock, trait, respawn anchor rotation)
 * - Settlement foundries (ore buffer, vein-batch specialization + TTL, depletion permille)
 * - Escrow frontier work-order contracts + offline auto-refund pending credits
 * - Immutable item provenance ledger (survives bag moves, equips, trades, restarts)
 * - Scoped `${characterId}:${opId}` idempotency log
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CivicContractView,
  CivicContributorView,
  CivicFoundryView,
  CivicHistoryEntryView,
  CivicSiteView,
  CivicVeinView,
  ItemProvenanceView,
} from "@mmo-engine/protocol";
import type { CivicFoundryDef, CivicRules, CivicSiteDef, VeinTraitDef } from "@mmo-engine/rules";

export const CIVIC_SCHEMA_VERSION = 1;

export type CivicHistoryEventType =
  | "contributed"
  | "stage_advanced"
  | "damaged"
  | "repaired"
  | "foundry_specialized"
  | "era_shift"
  | "admin_override";

export type StoredContractStatus = "open" | "filled" | "cancelled" | "expired";

const DDL = `
CREATE TABLE IF NOT EXISTS civic_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_sites (
  id TEXT PRIMARY KEY,
  stage INTEGER NOT NULL,
  progress TEXT NOT NULL,
  gold_progress INTEGER NOT NULL DEFAULT 0,
  repair_progress TEXT NOT NULL DEFAULT '{}',
  repair_gold_progress INTEGER NOT NULL DEFAULT 0,
  wear INTEGER NOT NULL DEFAULT 0,
  damaged INTEGER NOT NULL DEFAULT 0,
  era_tag TEXT NOT NULL DEFAULT 'Stage 0',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_contributors (
  site_id TEXT NOT NULL,
  char_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  raw_score INTEGER NOT NULL,
  effective_weight REAL NOT NULL,
  today_day INTEGER NOT NULL,
  today_raw INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, char_id)
);

CREATE TABLE IF NOT EXISTS civic_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  era_tag TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_veins (
  vein_batch_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  trait_id TEXT NOT NULL,
  material TEXT NOT NULL,
  x REAL NOT NULL,
  z REAL NOT NULL,
  anchor_index INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL,
  max_stock INTEGER NOT NULL,
  discovered_by_char_id INTEGER,
  discovered_by_name TEXT,
  discovered_at INTEGER,
  respawn_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_foundries (
  id TEXT PRIMARY KEY,
  ore_buffer TEXT NOT NULL DEFAULT '{}',
  active_vein_batch_id TEXT,
  active_trait_id TEXT NOT NULL DEFAULT 'bog-standard',
  batches_remaining INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  depleted_permille INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_foundry_char_weights (
  foundry_id TEXT NOT NULL,
  char_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  weight REAL NOT NULL,
  today_day INTEGER NOT NULL,
  today_weight REAL NOT NULL,
  PRIMARY KEY (foundry_id, char_id)
);

CREATE TABLE IF NOT EXISTS civic_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poster_id INTEGER NOT NULL,
  poster_name TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  material TEXT NOT NULL,
  total_qty INTEGER NOT NULL,
  delivered_qty INTEGER NOT NULL,
  reward_per_unit INTEGER NOT NULL,
  escrow_total INTEGER NOT NULL,
  escrow_remaining INTEGER NOT NULL,
  fee_paid INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_civic_contracts_status_exp
  ON civic_contracts (status, expires_at);

CREATE TABLE IF NOT EXISTS civic_pending_credits (
  char_id INTEGER PRIMARY KEY,
  amount INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_provenance (
  provenance_id INTEGER PRIMARY KEY AUTOINCREMENT,
  vein_batch_id TEXT NOT NULL,
  trait_id TEXT NOT NULL,
  town_id TEXT NOT NULL,
  crafter_id INTEGER NOT NULL,
  crafter_name TEXT NOT NULL,
  era_tag TEXT NOT NULL,
  crafted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_item_provenance (
  item_id INTEGER PRIMARY KEY,
  provenance_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS civic_processed_ops (
  op_key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface StoredSite {
  id: string;
  stage: number;
  progress: Record<string, number>;
  goldProgress: number;
  repairProgress: Record<string, number>;
  repairGoldProgress: number;
  wear: number;
  damaged: boolean;
  eraTag: string;
  updatedAt: number;
}

export interface StoredVein {
  veinBatchId: string;
  templateId: string;
  traitId: string;
  material: string;
  x: number;
  z: number;
  anchorIndex: number;
  stock: number;
  maxStock: number;
  discoveredByCharId: number | null;
  discoveredByName: string | null;
  discoveredAt: number | null;
  respawnAt: number | null;
  createdAt: number;
}

export interface StoredFoundry {
  id: string;
  oreBuffer: Record<string, number>;
  activeVeinBatchId: string | null;
  activeTraitId: string;
  batchesRemaining: number;
  expiresAt: number | null;
  depletedPermille: number;
  updatedAt: number;
}

export interface StoredContract {
  id: number;
  posterId: number;
  posterName: string;
  targetKind: "site" | "foundry";
  targetId: string;
  material: string;
  totalQty: number;
  deliveredQty: number;
  rewardPerUnit: number;
  escrowTotal: number;
  escrowRemaining: number;
  feePaid: number;
  status: StoredContractStatus;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export interface StoredContributor {
  siteId: string;
  charId: number;
  name: string;
  rawScore: number;
  effectiveWeight: number;
  todayDay: number;
  todayRaw: number;
  updatedAt: number;
}

export interface ProvenanceMintInput {
  veinBatchId: string;
  traitId: string;
  townId: string;
  crafterId: number;
  crafterName: string;
  eraTag: string;
  craftedAt: number;
}

function parseIntMapJson(raw: string): Record<string, number> {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        out[k] = Math.trunc(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export class SqliteCivicStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.ensureSchema();
  }

  /** Idempotent DDL + forward-compatible additive column migrations. */
  private ensureSchema(): void {
    this.db.exec(DDL);
    const hasColumn = (table: string, col: string): boolean => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === col);
    };
    if (!hasColumn("civic_sites", "repair_progress")) {
      this.db.exec(`ALTER TABLE civic_sites ADD COLUMN repair_progress TEXT NOT NULL DEFAULT '{}'`);
    }
    if (!hasColumn("civic_sites", "repair_gold_progress")) {
      this.db.exec(`ALTER TABLE civic_sites ADD COLUMN repair_gold_progress INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hasColumn("civic_sites", "era_tag")) {
      this.db.exec(`ALTER TABLE civic_sites ADD COLUMN era_tag TEXT NOT NULL DEFAULT 'Stage 0'`);
    }
    const row = this.db.prepare(`SELECT value FROM civic_meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.db.prepare(`INSERT INTO civic_meta (key, value) VALUES ('schema_version', ?)`).run(
        String(CIVIC_SCHEMA_VERSION),
      );
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare(`SELECT value FROM civic_meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  runImmediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  seedDefaults(rules: CivicRules, nowMs: number): void {
    this.runImmediate(() => {
      const checkSite = this.db.prepare(`SELECT id FROM civic_sites WHERE id = ?`);
      const insSite = this.db.prepare(
        `INSERT INTO civic_sites (id, stage, progress, gold_progress, repair_progress, repair_gold_progress, wear, damaged, era_tag, updated_at)
         VALUES (?, 0, '{}', 0, '{}', 0, 0, 0, ?, ?)`,
      );
      for (const s of rules.sites) {
        if (!checkSite.get(s.id)) {
          insSite.run(s.id, s.stages[0]?.label ?? "Ruined Crossing", nowMs);
        }
      }

      const checkFoundry = this.db.prepare(`SELECT id FROM civic_foundries WHERE id = ?`);
      const insFoundry = this.db.prepare(
        `INSERT INTO civic_foundries (id, ore_buffer, active_vein_batch_id, active_trait_id, batches_remaining, expires_at, depleted_permille, updated_at)
         VALUES (?, '{}', NULL, 'bog-standard', 0, NULL, 0, ?)`,
      );
      for (const f of rules.foundries) {
        if (!checkFoundry.get(f.id)) insFoundry.run(f.id, nowMs);
      }
    });
  }

  // ---- Idempotency ----

  getProcessedOp(opKey: string): string | null {
    const row = this.db.prepare(`SELECT result_json FROM civic_processed_ops WHERE op_key = ?`).get(opKey) as
      | { result_json: string }
      | undefined;
    return row ? row.result_json : null;
  }

  saveProcessedOp(opKey: string, resultJson: string, nowMs: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO civic_processed_ops (op_key, result_json, created_at) VALUES (?, ?, ?)`)
      .run(opKey, resultJson, nowMs);
  }

  // ---- Sites & Contributors ----

  getSite(id: string): StoredSite | undefined {
    const r = this.db
      .prepare(
        `SELECT id, stage, progress, gold_progress, repair_progress, repair_gold_progress, wear, damaged, era_tag, updated_at
         FROM civic_sites WHERE id = ?`,
      )
      .get(id) as
      | {
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
        }
      | undefined;
    return r ? this.mapSite(r) : undefined;
  }

  listSites(): StoredSite[] {
    const rows = this.db
      .prepare(
        `SELECT id, stage, progress, gold_progress, repair_progress, repair_gold_progress, wear, damaged, era_tag, updated_at
         FROM civic_sites ORDER BY id`,
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
    }>;
    return rows.map((r) => this.mapSite(r));
  }

  saveSite(site: StoredSite): void {
    this.db
      .prepare(
        `INSERT INTO civic_sites (id, stage, progress, gold_progress, repair_progress, repair_gold_progress, wear, damaged, era_tag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           stage = excluded.stage,
           progress = excluded.progress,
           gold_progress = excluded.gold_progress,
           repair_progress = excluded.repair_progress,
           repair_gold_progress = excluded.repair_gold_progress,
           wear = excluded.wear,
           damaged = excluded.damaged,
           era_tag = excluded.era_tag,
           updated_at = excluded.updated_at`,
      )
      .run(
        site.id,
        site.stage,
        JSON.stringify(site.progress),
        site.goldProgress,
        JSON.stringify(site.repairProgress),
        site.repairGoldProgress,
        site.wear,
        site.damaged ? 1 : 0,
        site.eraTag,
        site.updatedAt,
      );
  }

  private mapSite(r: {
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
  }): StoredSite {
    return {
      id: r.id,
      stage: r.stage,
      progress: parseIntMapJson(r.progress),
      goldProgress: r.gold_progress,
      repairProgress: parseIntMapJson(r.repair_progress),
      repairGoldProgress: r.repair_gold_progress,
      wear: r.wear,
      damaged: r.damaged !== 0,
      eraTag: r.era_tag,
      updatedAt: r.updated_at,
    };
  }

  getContributor(siteId: string, charId: number): StoredContributor | undefined {
    const r = this.db
      .prepare(
        `SELECT site_id, char_id, name, raw_score, effective_weight, today_day, today_raw, updated_at
         FROM civic_contributors WHERE site_id = ? AND char_id = ?`,
      )
      .get(siteId, charId) as
      | {
          site_id: string;
          char_id: number;
          name: string;
          raw_score: number;
          effective_weight: number;
          today_day: number;
          today_raw: number;
          updated_at: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      siteId: r.site_id,
      charId: r.char_id,
      name: r.name,
      rawScore: r.raw_score,
      effectiveWeight: r.effective_weight,
      todayDay: r.today_day,
      todayRaw: r.today_raw,
      updatedAt: r.updated_at,
    };
  }

  saveContributor(c: StoredContributor): void {
    this.db
      .prepare(
        `INSERT INTO civic_contributors (site_id, char_id, name, raw_score, effective_weight, today_day, today_raw, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, char_id) DO UPDATE SET
           name = excluded.name,
           raw_score = excluded.raw_score,
           effective_weight = excluded.effective_weight,
           today_day = excluded.today_day,
           today_raw = excluded.today_raw,
           updated_at = excluded.updated_at`,
      )
      .run(c.siteId, c.charId, c.name, c.rawScore, c.effectiveWeight, c.todayDay, c.todayRaw, c.updatedAt);
  }

  countContributors(siteId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM civic_contributors WHERE site_id = ?`)
      .get(siteId) as { n: number };
    return r.n;
  }

  listContributors(siteId: string, limit = 10, offset = 0): CivicContributorView[] {
    const rows = this.db
      .prepare(
        `SELECT char_id, name, raw_score, effective_weight
         FROM civic_contributors WHERE site_id = ?
         ORDER BY effective_weight DESC, updated_at ASC LIMIT ? OFFSET ?`,
      )
      .all(siteId, limit, offset) as Array<{
      char_id: number;
      name: string;
      raw_score: number;
      effective_weight: number;
    }>;
    return rows.map((r) => ({
      characterId: r.char_id,
      characterName: r.name,
      rawScore: r.raw_score,
      effectiveWeight: r.effective_weight,
    }));
  }

  // ---- History ----

  appendHistory(entry: {
    siteId: string;
    eventType: CivicHistoryEventType;
    actorId: number;
    actorName: string;
    eraTag: string;
    detail: string;
    createdAt: number;
  }): CivicHistoryEntryView {
    const res = this.db
      .prepare(
        `INSERT INTO civic_history (site_id, event_type, actor_id, actor_name, era_tag, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.siteId,
        entry.eventType,
        entry.actorId,
        entry.actorName,
        entry.eraTag,
        entry.detail,
        entry.createdAt,
      );
    return { seq: Number(res.lastInsertRowid), ...entry };
  }

  countHistory(siteId?: string): number {
    const row = (siteId
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM civic_history WHERE site_id = ?`).get(siteId)
      : this.db.prepare(`SELECT COUNT(*) AS n FROM civic_history`).get()) as { n: number };
    return row.n;
  }

  listHistory(siteId?: string, limit = 25, offset = 0): CivicHistoryEntryView[] {
    const rows = (siteId
      ? this.db
          .prepare(
            `SELECT seq, site_id, event_type, actor_id, actor_name, era_tag, detail, created_at
             FROM civic_history WHERE site_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
          )
          .all(siteId, limit, offset)
      : this.db
          .prepare(
            `SELECT seq, site_id, event_type, actor_id, actor_name, era_tag, detail, created_at
             FROM civic_history ORDER BY seq DESC LIMIT ? OFFSET ?`,
          )
          .all(limit, offset)) as Array<{
      seq: number;
      site_id: string;
      event_type: CivicHistoryEventType;
      actor_id: number;
      actor_name: string;
      era_tag: string;
      detail: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      siteId: r.site_id,
      eventType: r.event_type,
      actorId: r.actor_id,
      actorName: r.actor_name,
      eraTag: r.era_tag,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  // ---- Veins ----

  getVein(veinBatchId: string): StoredVein | undefined {
    const row = this.db
      .prepare(
        `SELECT vein_batch_id, template_id, trait_id, material, x, z, anchor_index, stock, max_stock,
                discovered_by_char_id, discovered_by_name, discovered_at, respawn_at, created_at
         FROM civic_veins WHERE vein_batch_id = ?`,
      )
      .get(veinBatchId) as
      | {
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
        }
      | undefined;
    return row ? this.mapVein(row) : undefined;
  }

  listVeins(includeDepleted = true): StoredVein[] {
    const sql = includeDepleted
      ? `SELECT vein_batch_id, template_id, trait_id, material, x, z, anchor_index, stock, max_stock,
                discovered_by_char_id, discovered_by_name, discovered_at, respawn_at, created_at
         FROM civic_veins ORDER BY created_at ASC`
      : `SELECT vein_batch_id, template_id, trait_id, material, x, z, anchor_index, stock, max_stock,
                discovered_by_char_id, discovered_by_name, discovered_at, respawn_at, created_at
         FROM civic_veins WHERE stock > 0 ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all() as Array<{
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
    }>;
    return rows.map((r) => this.mapVein(r));
  }

  upsertVein(v: StoredVein): void {
    this.db
      .prepare(
        `INSERT INTO civic_veins (vein_batch_id, template_id, trait_id, material, x, z, anchor_index, stock, max_stock,
                                  discovered_by_char_id, discovered_by_name, discovered_at, respawn_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           respawn_at = excluded.respawn_at`,
      )
      .run(
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
      );
  }

  /** Atomic multi-unit vein extraction guard: never decrements stock below zero. */
  atomicExtractFromVein(
    veinBatchId: string,
    wantQty: number,
    respawnDelayMs: number,
    nowMs: number,
  ): { vein: StoredVein; extracted: number } | null {
    return this.runImmediate(() => {
      const existing = this.getVein(veinBatchId);
      if (!existing || existing.stock <= 0 || wantQty <= 0) return null;
      const take = Math.min(wantQty, existing.stock);
      const nextStock = existing.stock - take;
      const respawnAt = nextStock === 0 ? nowMs + respawnDelayMs : existing.respawnAt;
      const res = this.db
        .prepare(`UPDATE civic_veins SET stock = ?, respawn_at = ? WHERE vein_batch_id = ? AND stock >= ?`)
        .run(nextStock, respawnAt, veinBatchId, take);
      if (res.changes !== 1) return null;
      return {
        vein: { ...existing, stock: nextStock, respawnAt },
        extracted: take,
      };
    });
  }

  private mapVein(r: {
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
  }): StoredVein {
    return {
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
    };
  }

  // ---- Foundries ----

  getFoundry(id: string): StoredFoundry | undefined {
    const r = this.db
      .prepare(
        `SELECT id, ore_buffer, active_vein_batch_id, active_trait_id, batches_remaining, expires_at, depleted_permille, updated_at
         FROM civic_foundries WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          ore_buffer: string;
          active_vein_batch_id: string | null;
          active_trait_id: string;
          batches_remaining: number;
          expires_at: number | null;
          depleted_permille: number;
          updated_at: number;
        }
      | undefined;
    return r ? this.mapFoundry(r) : undefined;
  }

  listFoundries(): StoredFoundry[] {
    const rows = this.db
      .prepare(
        `SELECT id, ore_buffer, active_vein_batch_id, active_trait_id, batches_remaining, expires_at, depleted_permille, updated_at
         FROM civic_foundries ORDER BY id`,
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
    }>;
    return rows.map((r) => this.mapFoundry(r));
  }

  saveFoundry(f: StoredFoundry): void {
    this.db
      .prepare(
        `INSERT INTO civic_foundries (id, ore_buffer, active_vein_batch_id, active_trait_id, batches_remaining, expires_at, depleted_permille, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ore_buffer = excluded.ore_buffer,
           active_vein_batch_id = excluded.active_vein_batch_id,
           active_trait_id = excluded.active_trait_id,
           batches_remaining = excluded.batches_remaining,
           expires_at = excluded.expires_at,
           depleted_permille = excluded.depleted_permille,
           updated_at = excluded.updated_at`,
      )
      .run(
        f.id,
        JSON.stringify(f.oreBuffer),
        f.activeVeinBatchId,
        f.activeTraitId,
        f.batchesRemaining,
        f.expiresAt,
        f.depletedPermille,
        f.updatedAt,
      );
  }

  private mapFoundry(r: {
    id: string;
    ore_buffer: string;
    active_vein_batch_id: string | null;
    active_trait_id: string;
    batches_remaining: number;
    expires_at: number | null;
    depleted_permille: number;
    updated_at: number;
  }): StoredFoundry {
    return {
      id: r.id,
      oreBuffer: parseIntMapJson(r.ore_buffer),
      activeVeinBatchId: r.active_vein_batch_id,
      activeTraitId: r.active_trait_id,
      batchesRemaining: r.batches_remaining,
      expiresAt: r.expires_at,
      depletedPermille: r.depleted_permille,
      updatedAt: r.updated_at,
    };
  }

  getFoundryCharWeight(foundryId: string, charId: number): { todayDay: number; todayWeight: number; weight: number } | undefined {
    const r = this.db
      .prepare(`SELECT today_day, today_weight, weight FROM civic_foundry_char_weights WHERE foundry_id = ? AND char_id = ?`)
      .get(foundryId, charId) as { today_day: number; today_weight: number; weight: number } | undefined;
    return r ? { todayDay: r.today_day, todayWeight: r.today_weight, weight: r.weight } : undefined;
  }

  saveFoundryCharWeight(foundryId: string, charId: number, name: string, weight: number, todayDay: number, todayWeight: number): void {
    this.db
      .prepare(
        `INSERT INTO civic_foundry_char_weights (foundry_id, char_id, name, weight, today_day, today_weight)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(foundry_id, char_id) DO UPDATE SET
           name = excluded.name,
           weight = excluded.weight,
           today_day = excluded.today_day,
           today_weight = excluded.today_weight`,
      )
      .run(foundryId, charId, name, weight, todayDay, todayWeight);
  }

  // ---- Contracts & Pending Credits ----

  openContractCountFor(posterId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM civic_contracts WHERE poster_id = ? AND status = 'open'`)
      .get(posterId) as { n: number };
    return row.n;
  }

  getContract(id: number): StoredContract | undefined {
    const r = this.db
      .prepare(
        `SELECT id, poster_id, poster_name, target_kind, target_id, material, total_qty, delivered_qty,
                reward_per_unit, escrow_total, escrow_remaining, fee_paid, status, created_at, expires_at, updated_at
         FROM civic_contracts WHERE id = ?`,
      )
      .get(id) as
      | {
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
        }
      | undefined;
    return r ? this.mapContract(r) : undefined;
  }

  listContracts(statusFilter?: StoredContractStatus): StoredContract[] {
    const rows = (statusFilter
      ? this.db
          .prepare(
            `SELECT id, poster_id, poster_name, target_kind, target_id, material, total_qty, delivered_qty,
                    reward_per_unit, escrow_total, escrow_remaining, fee_paid, status, created_at, expires_at, updated_at
             FROM civic_contracts WHERE status = ? ORDER BY id DESC LIMIT 100`,
          )
          .all(statusFilter)
      : this.db
          .prepare(
            `SELECT id, poster_id, poster_name, target_kind, target_id, material, total_qty, delivered_qty,
                    reward_per_unit, escrow_total, escrow_remaining, fee_paid, status, created_at, expires_at, updated_at
             FROM civic_contracts ORDER BY id DESC LIMIT 100`,
          )
          .all()) as Array<{
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
    }>;
    return rows.map((r) => this.mapContract(r));
  }

  insertContract(c: Omit<StoredContract, "id">): StoredContract {
    const res = this.db
      .prepare(
        `INSERT INTO civic_contracts (poster_id, poster_name, target_kind, target_id, material, total_qty, delivered_qty,
                                      reward_per_unit, escrow_total, escrow_remaining, fee_paid, status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return { id: Number(res.lastInsertRowid), ...c };
  }

  getPendingCredits(charId: number): number {
    const r = this.db.prepare(`SELECT amount FROM civic_pending_credits WHERE char_id = ?`).get(charId) as
      | { amount: number }
      | undefined;
    return r ? r.amount : 0;
  }

  addPendingCredits(charId: number, amount: number, nowMs: number): void {
    if (amount <= 0) return;
    this.db
      .prepare(
        `INSERT INTO civic_pending_credits (char_id, amount, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(char_id) DO UPDATE SET
           amount = amount + excluded.amount,
           updated_at = excluded.updated_at`,
      )
      .run(charId, amount, nowMs);
  }

  claimPendingCredits(charId: number, nowMs: number): number {
    return this.runImmediate(() => {
      const r = this.db.prepare(`SELECT amount FROM civic_pending_credits WHERE char_id = ?`).get(charId) as
        | { amount: number }
        | undefined;
      if (!r || r.amount <= 0) return 0;
      this.db.prepare(`UPDATE civic_pending_credits SET amount = 0, updated_at = ? WHERE char_id = ?`).run(nowMs, charId);
      return r.amount;
    });
  }

  /** Atomically expires open contracts past `nowMs` and queues unfulfilled escrow into pending credits. */
  expireDueContracts(nowMs: number): Array<{ contractId: number; posterId: number; refunded: number }> {
    return this.runImmediate(() => {
      const due = this.db
        .prepare(
          `SELECT id, poster_id, escrow_remaining
           FROM civic_contracts WHERE status = 'open' AND expires_at <= ?`,
        )
        .all(nowMs) as Array<{ id: number; poster_id: number; escrow_remaining: number }>;
      const out: Array<{ contractId: number; posterId: number; refunded: number }> = [];
      for (const row of due) {
        const res = this.db
          .prepare(`UPDATE civic_contracts SET status = 'expired', escrow_remaining = 0, updated_at = ? WHERE id = ? AND status = 'open'`)
          .run(nowMs, row.id);
        if (res.changes === 1) {
          if (row.escrow_remaining > 0) {
            this.addPendingCredits(row.poster_id, row.escrow_remaining, nowMs);
          }
          out.push({ contractId: row.id, posterId: row.poster_id, refunded: row.escrow_remaining });
        }
      }
      return out;
    });
  }

  private mapContract(r: {
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
  }): StoredContract {
    return {
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
    };
  }

  // ---- Provenance ----

  mintProvenance(input: ProvenanceMintInput): ItemProvenanceView {
    const res = this.db
      .prepare(
        `INSERT INTO civic_provenance (vein_batch_id, trait_id, town_id, crafter_id, crafter_name, era_tag, crafted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.veinBatchId,
        input.traitId,
        input.townId,
        input.crafterId,
        input.crafterName,
        input.eraTag,
        input.craftedAt,
      );
    return {
      provenanceId: Number(res.lastInsertRowid),
      ...input,
    };
  }

  bindItemProvenance(itemId: number, provenanceId: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO civic_item_provenance (item_id, provenance_id) VALUES (?, ?)`)
      .run(itemId, provenanceId);
  }

  /**
   * Mint a new immutable provenance record for a reforged item and re-point
   * `civic_item_provenance` to it cleanly inside the caller's transaction.
   */
  reforgeItemProvenance(itemId: number, input: ProvenanceMintInput): ItemProvenanceView {
    const minted = this.mintProvenance(input);
    this.bindItemProvenance(itemId, minted.provenanceId);
    return minted;
  }

  getProvenanceByItemId(itemId: number): ItemProvenanceView | undefined {
    const r = this.db
      .prepare(
        `SELECT p.provenance_id, p.vein_batch_id, p.trait_id, p.town_id, p.crafter_id, p.crafter_name, p.era_tag, p.crafted_at
         FROM civic_item_provenance ip
         JOIN civic_provenance p ON p.provenance_id = ip.provenance_id
         WHERE ip.item_id = ?`,
      )
      .get(itemId) as
      | {
          provenance_id: number;
          vein_batch_id: string;
          trait_id: string;
          town_id: string;
          crafter_id: number;
          crafter_name: string;
          era_tag: string;
          crafted_at: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      provenanceId: r.provenance_id,
      veinBatchId: r.vein_batch_id,
      traitId: r.trait_id,
      townId: r.town_id,
      crafterId: r.crafter_id,
      crafterName: r.crafter_name,
      eraTag: r.era_tag,
      craftedAt: r.crafted_at,
    };
  }
}

export function computeRepairCost(site: StoredSite, def: CivicSiteDef): { materials: Record<string, number>; gold: number } {
  if (!site.damaged) return { materials: {}, gold: 0 };
  const units = Math.max(1, Math.ceil(site.wear / 100));
  const materials: Record<string, number> = {};
  for (const [k, per100] of Object.entries(def.repairCostPer100Wear)) {
    const need = per100 * units - (site.repairProgress[k] ?? 0);
    if (need > 0) materials[k] = need;
  }
  const gold = Math.max(0, def.repairGoldPer100Wear * units - site.repairGoldProgress);
  return { materials, gold };
}

export function formatTraitBonusSummary(trait: VeinTraitDef | undefined): string {
  if (!trait) return "Baseline";
  const parts: string[] = [];
  if (trait.powerBonusPct !== 0) parts.push(`${trait.powerBonusPct > 0 ? "+" : ""}${trait.powerBonusPct}% power`);
  if (trait.durabilityBonusPct !== 0) parts.push(`${trait.durabilityBonusPct > 0 ? "+" : ""}${trait.durabilityBonusPct}% dur`);
  if (trait.staminaReductionPct !== 0) parts.push(`-${trait.staminaReductionPct}% stam`);
  if (trait.armourPenetrationPct !== 0) parts.push(`+${trait.armourPenetrationPct}% pen`);
  return parts.length > 0 ? `${trait.craftTag} (${parts.join(", ")})` : trait.craftTag;
}

export function toSiteView(site: StoredSite, def: CivicSiteDef, totalContributors: number): CivicSiteView {
  const nextStage = def.stages[site.stage + 1];
  const repair = computeRepairCost(site, def);
  return {
    siteId: site.id,
    name: def.name,
    kind: def.kind,
    x: def.x,
    z: def.z,
    stage: site.stage,
    maxStage: def.stages.length - 1,
    damaged: site.damaged,
    wear: site.wear,
    wearMax: def.wearMax,
    eraTag: site.eraTag,
    progress: { ...site.progress },
    goldProgress: site.goldProgress,
    nextRequirements: nextStage ? { ...nextStage.requirements } : {},
    nextGoldCost: nextStage ? nextStage.goldCost : 0,
    repairRequirements: repair.materials,
    repairGoldCost: repair.gold,
    heavyHaulAllowed: !site.damaged && site.stage >= def.heavyHaulMinStage,
    totalContributors,
  };
}

export function toVeinView(v: StoredVein, trait: VeinTraitDef | undefined): CivicVeinView {
  return {
    veinBatchId: v.veinBatchId,
    templateId: v.templateId,
    traitId: v.traitId,
    traitName: trait?.name ?? v.traitId,
    material: v.material,
    x: v.x,
    z: v.z,
    stock: v.stock,
    maxStock: v.maxStock,
    discoveredAt: v.discoveredAt ?? v.createdAt,
  };
}

export function toFoundryView(f: StoredFoundry, def: CivicFoundryDef, trait: VeinTraitDef | undefined): CivicFoundryView {
  return {
    townId: f.id,
    name: def.name,
    x: def.x,
    z: def.z,
    activeTraitId: f.activeTraitId,
    traitName: trait?.name ?? f.activeTraitId,
    activeVeinBatchId: f.activeVeinBatchId,
    batchesRemaining: f.batchesRemaining,
    expiresAt: f.expiresAt,
    oreBuffer: { ...f.oreBuffer },
    activationThreshold: def.activationOreThreshold,
    depletedPermille: f.depletedPermille,
    mature: f.depletedPermille >= def.maturityThresholdPermille,
    reforgeGoldCost: def.reforgeGoldCost,
    repairKitCost: { ...def.repairKitCost },
    craftBonusSummary: f.batchesRemaining > 0 ? formatTraitBonusSummary(trait) : "Baseline (no active specialty)",
  };
}

export function toContractView(c: StoredContract): CivicContractView {
  return {
    contractId: String(c.id),
    posterId: c.posterId,
    posterName: c.posterName,
    targetKind: c.targetKind,
    targetId: c.targetId,
    material: c.material,
    totalQty: c.totalQty,
    deliveredQty: c.deliveredQty,
    rewardPerUnit: c.rewardPerUnit,
    status: c.status,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
  };
}
