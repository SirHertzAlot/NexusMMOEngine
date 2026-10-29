/**
 * In-memory WorldStore. Used by unit tests and by `WORLD_DB_URL=mem:`
 * dev runs. Production uses SurrealWorldStore (src/surreal-store.ts).
 */
import {
  applyAuctionSettle,
  applyCraftExecute,
  applyInventoryMutate,
  applyLootGrant,
  applyTradeCommit,
  applyVendorTransact,
  type AtomicContext,
  type AtomicOutcome,
} from "./atomic.js";
import type {
  AtomicLedgerEntry,
  AtomicOpKind,
  AtomicOpResult,
  AuctionSettleInput,
  CharacterSessionLock,
  CharacterStateRecord,
  CraftExecuteInput,
  HostResourceReport,
  InventoryMutateInput,
  LedgerEvent,
  LootGrantInput,
  MigrationRecord,
  MigrationState,
  PendingCredit,
  RegionRecord,
  ShardSnapshotRecord,
  SocialKind,
  SocialRecord,
  StoredDungeonRun,
  StoredLedgerEvent,
  TradeCommitInput,
  VendorTransactInput,
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
  private socialRecords = new Map<string, SocialRecord>();
  private socialIds = new Map<string, number>();

  async getSocialRecord(kind: SocialKind, key: string): Promise<SocialRecord | null> {
    const r = this.socialRecords.get(`${kind}:${key}`);
    return r ? { ...r } : null;
  }

  async putSocialRecord(r: SocialRecord): Promise<void> {
    this.socialRecords.set(`${r.kind}:${r.key}`, { ...r });
  }

  async listSocialRecords(kind: SocialKind): Promise<SocialRecord[]> {
    return [...this.socialRecords.values()].filter((r) => r.kind === kind).map((r) => ({ ...r }));
  }

  async allocateSocialIds(kind: "guild" | "party", count: number): Promise<number[]> {
    const first = (this.socialIds.get(kind) ?? 0) + 1;
    this.socialIds.set(kind, first + count - 1);
    return Array.from({ length: count }, (_, i) => first + i);
  }

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

  async putCharacterStates(records: CharacterStateRecord[]): Promise<void> {
    for (const r of records) this.characterStates.set(r.characterId, { ...r });
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

  // -- atomic operations (slice A1) --

  private atomicLedgerEntries: AtomicLedgerEntry[] = [];
  private atomicSeq = 0;

  /**
   * One atomic operation as one critical section: this body contains
   * no awaits, so validation, the state change, and the ledger append
   * cannot interleave with any other operation on this store. The
   * semantics come from src/atomic.ts, shared with the Surreal store.
   */
  private runAtomic(
    op: AtomicOpKind,
    opId: string,
    regionId: string,
    participantIds: number[],
    apply: (ctx: AtomicContext) => AtomicOutcome,
  ): AtomicOpResult {
    const now = Date.now();
    const ctx: AtomicContext = {
      regionId,
      now,
      records: new Map(
        participantIds.map((id) => {
          const r = this.characterStates.get(id);
          return [id, r ? structuredClone(r) : null] as const;
        }),
      ),
      locks: new Map(
        participantIds.map((id) => {
          const l = this.characterLocks.get(id);
          return [id, l ? { ...l } : null] as const;
        }),
      ),
    };
    const outcome = apply(ctx);
    if (!outcome.ok) {
      return { ok: false, opId, op, rejection: outcome.rejection, message: outcome.message };
    }
    const entries: AtomicLedgerEntry[] = outcome.commit.ledger.map((d) => ({
      ...d,
      seq: ++this.atomicSeq,
      at: now,
    }));
    for (const r of outcome.commit.records) {
      this.characterStates.set(r.characterId, structuredClone(r));
    }
    for (const c of outcome.commit.pendingCredits ?? []) {
      this.pendingCredits.push({ ...c, createdAt: now });
    }
    this.atomicLedgerEntries.push(...entries);
    return {
      ok: true,
      opId,
      op,
      characters: outcome.commit.records.map((r) => structuredClone(r)),
      ledger: entries.map((e) => ({ ...e })),
    };
  }

  async tradeCommit(input: TradeCommitInput): Promise<AtomicOpResult> {
    return this.runAtomic("tradeCommit", input.opId, input.regionId, [input.a.characterId, input.b.characterId], (ctx) =>
      applyTradeCommit(ctx, input),
    );
  }

  async vendorTransact(input: VendorTransactInput): Promise<AtomicOpResult> {
    return this.runAtomic("vendorTransact", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyVendorTransact(ctx, input),
    );
  }

  async auctionSettle(input: AuctionSettleInput): Promise<AtomicOpResult> {
    return this.runAtomic(
      "auctionSettle",
      input.opId,
      input.regionId,
      [input.buyer.characterId, input.seller.characterId],
      (ctx) => applyAuctionSettle(ctx, input),
    );
  }

  async craftExecute(input: CraftExecuteInput): Promise<AtomicOpResult> {
    return this.runAtomic("craftExecute", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyCraftExecute(ctx, input),
    );
  }

  async lootGrant(input: LootGrantInput): Promise<AtomicOpResult> {
    return this.runAtomic("lootGrant", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyLootGrant(ctx, input),
    );
  }

  async inventoryMutate(input: InventoryMutateInput): Promise<AtomicOpResult> {
    return this.runAtomic("inventoryMutate", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyInventoryMutate(ctx, input),
    );
  }

  async getAtomicLedger(): Promise<AtomicLedgerEntry[]> {
    return this.atomicLedgerEntries.map((e) => ({ ...e }));
  }

  // -- pending credits (fleet auction parity) --

  private pendingCredits: PendingCredit[] = [];

  async listPendingCredits(characterId: number): Promise<PendingCredit[]> {
    return this.pendingCredits
      .filter((c) => c.characterId === characterId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0))
      .map((c) => ({ ...c }));
  }

  /**
   * The credit drain, as one synchronous fold (no awaits mid-fold,
   * mirroring runAtomic's critical section): every pending credit
   * for the character lands in its current record at once, or —
   * no record, no numeric gold, no credits — nothing is consumed.
   */
  async applyPendingCredits(
    characterId: number,
  ): Promise<{ total: number; record: CharacterStateRecord | null }> {
    const current = this.characterStates.get(characterId) ?? null;
    if (current === null) return { total: 0, record: null };
    const credits = this.pendingCredits.filter((c) => c.characterId === characterId);
    const state =
      current.state !== null && typeof current.state === "object" && !Array.isArray(current.state)
        ? (current.state as Record<string, unknown>)
        : null;
    const gold = state?.["gold"];
    if (credits.length === 0 || state === null || typeof gold !== "number" || !Number.isFinite(gold)) {
      return { total: 0, record: { ...current } };
    }
    const total = credits.reduce((sum, c) => sum + c.amount, 0);
    const updated: CharacterStateRecord = {
      ...current,
      state: { ...state, gold: gold + total },
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    this.characterStates.set(characterId, structuredClone(updated));
    this.pendingCredits = this.pendingCredits.filter((c) => c.characterId !== characterId);
    return { total, record: structuredClone(updated) };
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
