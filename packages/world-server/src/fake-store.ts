/**
 * In-memory WorldStore. Used by unit tests and by `WORLD_DB_URL=mem:`
 * dev runs. Production uses SurrealWorldStore (src/surreal-store.ts).
 */
import type {
  CharacterSessionLock,
  CharacterStateRecord,
  HostResourceReport,
  LedgerEvent,
  MigrationRecord,
  MigrationState,
  RegionRecord,
  ShardSnapshotRecord,
  StoredDungeonRun,
  StoredLedgerEvent,
  WorldStore,
} from "./types.js";

export class MemoryWorldStore implements WorldStore {
  private regions = new Map<string, RegionRecord>();
  private ops = new Map<string, unknown>();
  private registryVersion = 0;
  private migrations = new Map<string, MigrationRecord>();

  async upsertRegion(r: RegionRecord): Promise<void> {
    this.regions.set(r.regionId, { ...r });
  }

  async getRegion(regionId: string): Promise<RegionRecord | null> {
    const r = this.regions.get(regionId);
    return r ? { ...r } : null;
  }

  async getRegionByTokenHash(tokenHash: string): Promise<RegionRecord | null> {
    for (const r of this.regions.values()) {
      if (r.tokenHash === tokenHash) return { ...r };
    }
    return null;
  }

  async listRegions(): Promise<RegionRecord[]> {
    return [...this.regions.values()].map((r) => ({ ...r }));
  }

  async deleteRegion(regionId: string): Promise<void> {
    this.regions.delete(regionId);
  }

  async reapStaleRegions(cutoffMs: number): Promise<string[]> {
    const reaped: string[] = [];
    for (const [id, r] of this.regions) {
      if (r.lastHeartbeat < cutoffMs) {
        this.regions.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  async getOpResult(opId: string): Promise<unknown | null> {
    return this.ops.has(opId) ? this.ops.get(opId) : null;
  }

  async storeOpResult(opId: string, result: unknown): Promise<void> {
    this.ops.set(opId, result);
  }

  async getRegistryVersion(): Promise<number> {
    return this.registryVersion;
  }

  async bumpRegistryVersion(): Promise<void> {
    this.registryVersion += 1;
  }

  async createMigration(m: MigrationRecord): Promise<void> {
    this.migrations.set(m.migrationId, { ...m });
  }

  async getMigration(migrationId: string): Promise<MigrationRecord | null> {
    const m = this.migrations.get(migrationId);
    return m ? { ...m } : null;
  }

  async getBegunMigrationForEntity(entityId: string): Promise<MigrationRecord | null> {
    for (const m of this.migrations.values()) {
      if (m.entityId === entityId && m.state === "begun") return { ...m };
    }
    return null;
  }

  async resolveMigration(migrationId: string, to: Exclude<MigrationState, "begun">, reason: string, now: number): Promise<MigrationRecord | null> {
    const m = this.migrations.get(migrationId);
    if (!m || m.state !== "begun") return null;
    m.state = to;
    m.reason = reason;
    m.updatedAt = now;
    return { ...m };
  }

  async listMigrationsForRegion(regionId: string, sinceMs: number): Promise<MigrationRecord[]> {
    return [...this.migrations.values()]
      .filter((m) => (m.fromRegion === regionId || m.toRegion === regionId) && (m.state === "begun" || m.updatedAt >= sinceMs))
      .map((m) => ({ ...m }));
  }

  async listBegunBefore(cutoffMs: number): Promise<string[]> {
    return [...this.migrations.values()].filter((m) => m.state === "begun" && m.createdAt < cutoffMs).map((m) => m.migrationId);
  }

  async pruneMigrations(cutoffMs: number): Promise<number> {
    let n = 0;
    for (const [id, m] of this.migrations) {
      if (m.state !== "begun" && m.updatedAt < cutoffMs) { this.migrations.delete(id); n++; }
    }
    return n;
  }

  private dungeonRuns = new Map<string, StoredDungeonRun>();

  async recordDungeonRun(run: StoredDungeonRun): Promise<boolean> {
    if (this.dungeonRuns.has(run.instance)) return false;
    this.dungeonRuns.set(run.instance, { ...run });
    return true;
  }

  async listDungeonRuns(regionId?: string): Promise<StoredDungeonRun[]> {
    return [...this.dungeonRuns.values()]
      .filter((r) => regionId === undefined || r.regionId === regionId)
      .map((r) => ({ ...r }));
  }

  private presence = new Map<string, Set<string>>();

  async setPresence(regionId: string, names: string[]): Promise<void> {
    this.presence.set(regionId, new Set(names));
  }

  async queryPresence(names: string[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string>();
    for (const [regionId, online] of this.presence) {
      for (const n of names) if (online.has(n) && !found.has(n)) found.set(n, regionId);
    }
    return new Map(names.map((n) => [n, found.get(n) ?? null]));
  }

  // -- state plane (persistence P1) --

  private rangeEpochs = new Map<string, number>();
  private shardSnapshots = new Map<string, ShardSnapshotRecord>();
  private ledger = new Map<string, Map<number, StoredLedgerEvent>>();
  private ledgerHeads = new Map<string, number>();
  private characterStates = new Map<number, CharacterStateRecord>();
  private characterLocks = new Map<number, CharacterSessionLock>();
  private characterLockEpochs = new Map<number, number>();

  async issueRangeEpoch(rangeKey: string): Promise<number> {
    const next = (this.rangeEpochs.get(rangeKey) ?? 0) + 1;
    this.rangeEpochs.set(rangeKey, next);
    return next;
  }

  async getRangeEpoch(rangeKey: string): Promise<number> {
    return this.rangeEpochs.get(rangeKey) ?? 0;
  }

  async putShardSnapshot(s: ShardSnapshotRecord): Promise<void> {
    this.shardSnapshots.set(s.rangeKey, { ...s });
  }

  async getLatestShardSnapshot(rangeKey: string): Promise<ShardSnapshotRecord | null> {
    const s = this.shardSnapshots.get(rangeKey);
    return s ? { ...s } : null;
  }

  async appendLedgerEvents(rangeKey: string, events: LedgerEvent[]): Promise<number> {
    let stream = this.ledger.get(rangeKey);
    if (!stream) {
      stream = new Map();
      this.ledger.set(rangeKey, stream);
    }
    for (const e of events) {
      // Idempotent on (rangeKey, seq): the first-written event wins.
      if (!stream.has(e.seq)) stream.set(e.seq, { ...e, rangeKey });
    }
    let head = this.ledgerHeads.get(rangeKey) ?? 0;
    while (stream.has(head + 1)) head += 1;
    this.ledgerHeads.set(rangeKey, head);
    return head;
  }

  async getLedgerEvents(rangeKey: string, afterSeq: number): Promise<StoredLedgerEvent[]> {
    const stream = this.ledger.get(rangeKey);
    if (!stream) return [];
    return [...stream.values()]
      .filter((e) => e.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({ ...e }));
  }

  async getLedgerHead(rangeKey: string): Promise<number> {
    return this.ledgerHeads.get(rangeKey) ?? 0;
  }

  async getCharacterState(characterId: number): Promise<CharacterStateRecord | null> {
    const r = this.characterStates.get(characterId);
    return r ? { ...r } : null;
  }

  async putCharacterState(r: CharacterStateRecord): Promise<void> {
    this.characterStates.set(r.characterId, { ...r });
  }

  async getCharacterLock(characterId: number): Promise<CharacterSessionLock | null> {
    const l = this.characterLocks.get(characterId);
    return l ? { ...l } : null;
  }

  async putCharacterLock(l: CharacterSessionLock): Promise<void> {
    this.characterLocks.set(l.characterId, { ...l });
  }

  async deleteCharacterLock(characterId: number): Promise<void> {
    this.characterLocks.delete(characterId);
  }

  async issueCharacterLockEpoch(characterId: number): Promise<number> {
    const next = (this.characterLockEpochs.get(characterId) ?? 0) + 1;
    this.characterLockEpochs.set(characterId, next);
    return next;
  }

  // -- host reports (persistence P5) --

  private hostReports = new Map<string, HostResourceReport>();

  async upsertHostReport(r: HostResourceReport): Promise<void> {
    this.hostReports.set(r.hostId, { ...r });
  }

  async getHostReport(hostId: string): Promise<HostResourceReport | null> {
    const r = this.hostReports.get(hostId);
    return r ? { ...r } : null;
  }

  async listHostReports(): Promise<HostResourceReport[]> {
    return [...this.hostReports.values()].map((r) => ({ ...r }));
  }

  async reapStaleHostReports(cutoffMs: number): Promise<string[]> {
    const reaped: string[] = [];
    for (const [id, r] of this.hostReports) {
      if (r.reportedAt < cutoffMs) {
        this.hostReports.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }
}
