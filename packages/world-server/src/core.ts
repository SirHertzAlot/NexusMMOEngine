/**
 * WorldCore implementation: region registry, liveness, snapshots.
 *
 * Transport-agnostic by construction: this module knows nothing about
 * Express, webrpc, or queues. Adapters authenticate the caller (Bearer
 * token -> regionId) and validate the payload (Zod) before calling in.
 */
import * as argon2 from "argon2";
import * as crypto from "node:crypto";
import {
  WorldCore,
  WorldCoreOptions,
  WorldError,
  WorldStore,
  rangeKeyFor,
  type AbortMigrationInput,
  type AcquireCharacterLockInput,
  type AppendLedgerEventsInput,
  type BeginMigrationInput,
  type CharacterSessionLock,
  type CharacterStateRecord,
  type ChunkRange,
  type CommitMigrationInput,
  type GetCharacterLockInput,
  type GetCharacterStateInput,
  type GetLedgerEventsInput,
  type GetLedgerHeadInput,
  type MigrationRecord,
  type PutCharacterStateInput,
  type PutShardSnapshotInput,
  type RegionInfo,
  type HeartbeatAck,
  type HeartbeatInput,
  type QueryPresenceInput,
  type RegionLease,
  type RegionRecord,
  type RegisterRegionInput,
  type ReleaseCharacterLockInput,
  type ReportDungeonResultsInput,
  type SetPresenceInput,
  type ShardSnapshotRecord,
  type SnapshotReportInput,
  type StoredLedgerEvent,
} from "./types.js";

function rangesOverlap(a: ChunkRange, b: ChunkRange): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Final migrations are kept this long for lookups, then pruned. */
const MIGRATION_HISTORY_MS = 24 * 60 * 60 * 1000;

export class WorldCoreImpl implements WorldCore {
  private readonly store: WorldStore;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly migrationTimeoutMs: number;
  private readonly outcomeRetentionMs: number;
  /** argon2id hash of the bootstrap API key (null = registration disabled). */
  private readonly apiKeyHash: string | null;

  constructor(opts: WorldCoreOptions & { apiKeyHash?: string | null }) {
    this.store = opts.store;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs;
    this.migrationTimeoutMs = opts.migrationTimeoutMs ?? 10_000;
    this.outcomeRetentionMs = opts.outcomeRetentionMs ?? 60_000;
    this.apiKeyHash = opts.apiKeyHash ?? null;
  }

  /** Resolve a bearer token to its region id (used by adapters). */
  async authenticate(token: string): Promise<string | null> {
    const hash = sha256Hex(token);
    const r = await this.store.getRegionByTokenHash(hash);
    if (r === null || r.tokenHash === null) return null;
    // Constant-time compare even though the store already matched:
    // defends against stores whose lookup isn't exact-equality.
    const a = Buffer.from(r.tokenHash);
    const b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return r.regionId;
  }

  async registerRegion(input: RegisterRegionInput): Promise<RegionLease> {
    // Registration is naturally idempotent: upsert by regionId. A
    // retried register (client timed out, server already processed)
    // simply rotates the bearer token — the client never saw the old
    // one, so the fresh token is the correct one. opId dedup matters
    // for the queue adapter's at-least-once delivery (slice B+ ops),
    // not here.
    if (this.apiKeyHash === null) {
      throw new WorldError(403, "registration disabled");
    }
    let keyOk = false;
    try {
      keyOk = await argon2.verify(this.apiKeyHash, input.apiKey);
    } catch {
      keyOk = false;
    }
    if (!keyOk) throw new WorldError(401, "invalid api key");

    const now = Date.now();
    const live = await this.store.listRegions();
    for (const r of live) {
      if (
        r.regionId !== input.regionId &&
        now - r.lastHeartbeat < this.heartbeatTimeoutMs &&
        rangesOverlap(r.chunkRange, input.chunkRange)
      ) {
        throw new WorldError(
          409,
          `chunk range overlaps live region ${r.regionId}`,
        );
      }
    }

    const token = randomToken();
    const existing = await this.store.getRegion(input.regionId);
    // Every grant of a range issues its next fencing epoch (persistence
    // P1): re-registering rotates the token AND bumps the epoch, so a
    // previous holder's state-plane writes are fenced out from here on.
    const epoch = await this.store.issueRangeEpoch(rangeKeyFor(input.chunkRange));
    const record: RegionRecord = {
      regionId: input.regionId,
      chunkRange: input.chunkRange,
      endpoint: input.endpoint,
      capacity: input.capacity,
      epoch,
      load: existing?.load ?? 0,
      tickJitterMs: existing?.tickJitterMs ?? 0,
      entityCount: existing?.entityCount ?? 0,
      lastTick: existing?.lastTick ?? 0,
      lastHeartbeat: now,
      apiKeyHash: this.apiKeyHash,
      tokenHash: sha256Hex(token),
      tokenIssuedAt: now,
    };
    await this.store.upsertRegion(record);
    await this.store.bumpRegistryVersion();
    const lease: RegionLease = {
      regionId: input.regionId,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      registryVersion: await this.store.getRegistryVersion(),
      token,
      epoch,
    };
    return lease;
  }

  async heartbeat(input: HeartbeatInput): Promise<HeartbeatAck> {
    const r = await this.store.getRegion(input.regionId);
    if (r === null) throw new WorldError(404, "unknown region");
    r.load = input.load;
    r.tickJitterMs = input.tickJitterMs;
    r.entityCount = input.entityCount;
    const now = Date.now();
    r.lastHeartbeat = now;
    await this.store.upsertRegion(r);
    // Every migration naming this region that is still begun or resolved
    // recently. Repeats are harmless: regions act on each outcome once.
    const migrations = (await this.store.listMigrationsForRegion(r.regionId, now - this.outcomeRetentionMs)).map((m) => ({
      migrationId: m.migrationId,
      entityId: m.entityId,
      fromRegion: m.fromRegion,
      toRegion: m.toRegion,
      state: m.state,
    }));
    return {
      ok: true,
      registryVersion: await this.store.getRegistryVersion(),
      migrations,
    };
  }

  async deregisterRegion(regionId: string, opId: string): Promise<void> {
    const prior = await this.store.getOpResult(opId);
    if (prior !== null) return;
    await this.store.deleteRegion(regionId);
    await this.store.bumpRegistryVersion();
    await this.store.storeOpResult(opId, { ok: true });
  }

  async reportSnapshot(input: SnapshotReportInput): Promise<void> {
    // Lossy-OK by design: never fail a region over a stats report.
    const r = await this.store.getRegion(input.regionId);
    if (r === null) return;
    r.lastTick = input.tick;
    r.entityCount = input.entityCount;
    await this.store.upsertRegion(r);
  }

  async reapStale(): Promise<string[]> {
    const reaped = await this.store.reapStaleRegions(
      Date.now() - this.heartbeatTimeoutMs,
    );
    if (reaped.length > 0) await this.store.bumpRegistryVersion();
    return reaped;
  }

  // ------------------------------------------------------------ slice B

  async listRegions(): Promise<RegionInfo[]> {
    const now = Date.now();
    return (await this.store.listRegions()).map((r) => ({
      regionId: r.regionId,
      chunkRange: r.chunkRange,
      endpoint: r.endpoint,
      live: now - r.lastHeartbeat < this.heartbeatTimeoutMs,
    }));
  }

  /**
   * Step 2 of the hand-off (spec §6): the source region records the
   * entity's state. The source keeps authority until the target commits.
   */
  async beginMigration(caller: string, input: BeginMigrationInput): Promise<{ migrationId: string }> {
    if (caller !== input.fromRegion) throw new WorldError(403, "only the source region may begin a migration");
    if (input.fromRegion === input.toRegion) throw new WorldError(400, "source and target are the same region");
    const prior = await this.store.getOpResult(input.opId);
    if (prior !== null) return prior as { migrationId: string };
    const now = Date.now();
    const target = await this.store.getRegion(input.toRegion);
    if (target === null || now - target.lastHeartbeat >= this.heartbeatTimeoutMs) {
      throw new WorldError(409, `target region ${input.toRegion} is not live`);
    }
    const open = await this.store.getBegunMigrationForEntity(input.entityId);
    if (open !== null) throw new WorldError(409, `entity already migrating (${open.migrationId})`);
    const record: MigrationRecord = {
      migrationId: "mig-" + crypto.randomBytes(12).toString("hex"),
      entityId: input.entityId,
      fromRegion: input.fromRegion,
      toRegion: input.toRegion,
      state: "begun",
      entityState: input.entityState,
      reason: "",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createMigration(record);
    const result = { migrationId: record.migrationId };
    await this.store.storeOpResult(input.opId, result);
    return result;
  }

  /**
   * Step 4: the target has instantiated the entity and takes authority.
   * Committing twice is fine; committing after expiry or abort is a 409,
   * and the target must then drop its copy.
   */
  async commitMigration(caller: string, input: CommitMigrationInput): Promise<void> {
    if ((await this.store.getOpResult(input.opId)) !== null) return;
    const m = await this.party(caller, input.migrationId);
    if (caller !== m.toRegion) throw new WorldError(403, "only the target region may commit");
    if (m.state === "begun") {
      const done = await this.store.resolveMigration(m.migrationId, "committed", "", Date.now());
      if (done === null) return this.commitMigration(caller, input); // raced with expiry or abort: report that
    } else if (m.state !== "committed") {
      throw new WorldError(409, `migration ${m.state}`);
    }
    await this.store.storeOpResult(input.opId, { ok: true });
  }

  /** Either party calls the hand-off off while it is begun; the source keeps authority. */
  async abortMigration(caller: string, input: AbortMigrationInput): Promise<void> {
    if ((await this.store.getOpResult(input.opId)) !== null) return;
    const m = await this.party(caller, input.migrationId);
    if (m.state === "begun") {
      const done = await this.store.resolveMigration(m.migrationId, "aborted", input.reason.slice(0, 200), Date.now());
      if (done === null) return this.abortMigration(caller, input);
    } else if (m.state === "committed") {
      throw new WorldError(409, "migration already committed");
    }
    // aborted or expired already: the outcome the caller wants
    await this.store.storeOpResult(input.opId, { ok: true });
  }

  async getMigration(caller: string, migrationId: string): Promise<MigrationRecord> {
    return this.party(caller, migrationId);
  }

  async expireMigrations(): Promise<string[]> {
    const now = Date.now();
    const expired: string[] = [];
    for (const id of await this.store.listBegunBefore(now - this.migrationTimeoutMs)) {
      if (await this.store.resolveMigration(id, "expired", "not committed in time", now)) expired.push(id);
    }
    await this.store.pruneMigrations(now - MIGRATION_HISTORY_MS);
    return expired;
  }

  /**
   * Ingest a region's committed dungeon runs (roadmap D4): one row per
   * run, idempotent on `instance`, so a retried batch (at-least-once
   * delivery) never records a run twice. The region marks its
   * `instances.db` rows reported for every id returned.
   */
  async reportDungeonResults(caller: string, input: ReportDungeonResultsInput): Promise<{ ingested: string[] }> {
    if (caller !== input.regionId) throw new WorldError(403, "regionId does not match token");
    const region = await this.store.getRegion(input.regionId);
    if (region === null) throw new WorldError(404, "unknown region");
    const now = Date.now();
    const ingested: string[] = [];
    for (const r of input.results) {
      await this.store.recordDungeonRun({ ...r, regionId: input.regionId, reportedAt: now });
      ingested.push(r.instance);
    }
    return { ingested };
  }

  /**
   * Replace the region's online character names (roadmap S2 presence):
   * the world directory behind cross-region friends lists. State, not
   * events: a re-report writes the same rows, and an empty report logs
   * the region's characters out.
   */
  async setPresence(caller: string, input: SetPresenceInput): Promise<void> {
    if (caller !== input.regionId) throw new WorldError(403, "regionId does not match token");
    if ((await this.store.getRegion(input.regionId)) === null) throw new WorldError(404, "unknown region");
    await this.store.setPresence(input.regionId, input.names);
  }

  /** Where queried names play, by region; unknown names map to null. */
  async queryPresence(caller: string, input: QueryPresenceInput): Promise<{ online: Record<string, string | null> }> {
    if (caller !== input.regionId) throw new WorldError(403, "regionId does not match token");
    if ((await this.store.getRegion(input.regionId)) === null) throw new WorldError(404, "unknown region");
    const online: Record<string, string | null> = {};
    for (const [name, region] of await this.store.queryPresence(input.names)) online[name] = region;
    return { online };
  }

  // ------------------------------------------------------------ persistence P1: state plane

  /**
   * Store a shard checkpoint at the world tier (Tier 2): keyed by
   * rangeKey, carrying the opaque payload a replacement shard recalls
   * from. The write is fenced by the range's current epoch.
   */
  async putShardSnapshot(caller: string, input: PutShardSnapshotInput): Promise<ShardSnapshotRecord> {
    const region = await this.knownRegion(caller, input.regionId);
    const prior = await this.store.getOpResult(input.opId);
    if (prior !== null) return prior as ShardSnapshotRecord;
    await this.fenceRangeWrite(region, input.rangeKey, input.epoch);
    const record: ShardSnapshotRecord = {
      rangeKey: input.rangeKey,
      regionId: input.regionId,
      tick: input.tick,
      epoch: input.epoch,
      digest: input.digest,
      payload: input.payload,
      storedAt: Date.now(),
    };
    await this.store.putShardSnapshot(record);
    await this.store.storeOpResult(input.opId, record);
    return record;
  }

  /** The range's latest checkpoint; reads are unfenced (boot recall precedes a fresh grant). */
  async getShardSnapshot(caller: string, rangeKey: string): Promise<ShardSnapshotRecord | null> {
    await this.knownRegion(caller, caller);
    return this.store.getLatestShardSnapshot(rangeKey);
  }

  /**
   * Stream ledger events uphill (Tier 1, outbox semantics): the region
   * retries unacked batches on its save cycle; the world acks only the
   * contiguous head, and a re-appended (rangeKey, seq) never stores
   * twice. Fenced by the range's current epoch.
   */
  async appendLedgerEvents(caller: string, input: AppendLedgerEventsInput): Promise<{ ackedSeq: number }> {
    const region = await this.knownRegion(caller, input.regionId);
    const prior = await this.store.getOpResult(input.opId);
    if (prior !== null) return prior as { ackedSeq: number };
    await this.fenceRangeWrite(region, input.rangeKey, input.epoch);
    const result = { ackedSeq: await this.store.appendLedgerEvents(input.rangeKey, input.events) };
    await this.store.storeOpResult(input.opId, result);
    return result;
  }

  async getLedgerEvents(caller: string, input: GetLedgerEventsInput): Promise<{ events: StoredLedgerEvent[] }> {
    await this.knownRegion(caller, input.regionId);
    return { events: await this.store.getLedgerEvents(input.rangeKey, input.afterSeq) };
  }

  async getLedgerHead(caller: string, input: GetLedgerHeadInput): Promise<{ ackedSeq: number }> {
    await this.knownRegion(caller, input.regionId);
    return { ackedSeq: await this.store.getLedgerHead(input.rangeKey) };
  }

  /**
   * Write a character's state at the world tier (P4 contract): the
   * caller must hold the character's session lock, unexpired, and
   * carry its epoch. The stored version increments per accepted put.
   */
  async putCharacterState(caller: string, input: PutCharacterStateInput): Promise<CharacterStateRecord> {
    await this.knownRegion(caller, input.regionId);
    const prior = await this.store.getOpResult(input.opId);
    if (prior !== null) return prior as CharacterStateRecord;
    const lock = await this.store.getCharacterLock(input.characterId);
    if (lock === null) {
      throw new WorldError(409, `character ${input.characterId} is not locked`);
    }
    if (lock.regionId !== caller) {
      throw new WorldError(403, `character ${input.characterId} is locked by region ${lock.regionId}`);
    }
    if (lock.epoch !== input.epoch) {
      throw new WorldError(409, `stale lock epoch ${input.epoch} for character ${input.characterId} (current ${lock.epoch})`);
    }
    if (lock.expiresAt <= Date.now()) {
      throw new WorldError(409, `character lock for ${input.characterId} has expired`);
    }
    const existing = await this.store.getCharacterState(input.characterId);
    const record: CharacterStateRecord = {
      characterId: input.characterId,
      state: input.state,
      version: (existing?.version ?? 0) + 1,
      epoch: input.epoch,
      regionId: caller,
      updatedAt: Date.now(),
    };
    await this.store.putCharacterState(record);
    await this.store.storeOpResult(input.opId, record);
    return record;
  }

  async getCharacterState(caller: string, input: GetCharacterStateInput): Promise<CharacterStateRecord | null> {
    await this.knownRegion(caller, input.regionId);
    return this.store.getCharacterState(input.characterId);
  }

  /**
   * Acquire a character's session lock: refused while a lock is held
   * and unexpired (whoever holds it); an expired lock is stolen and
   * its epoch bumped, fencing out the previous holder's writes.
   */
  async acquireCharacterLock(caller: string, input: AcquireCharacterLockInput): Promise<CharacterSessionLock> {
    await this.knownRegion(caller, input.regionId);
    const prior = await this.store.getOpResult(input.opId);
    if (prior !== null) return prior as CharacterSessionLock;
    const now = Date.now();
    const held = await this.store.getCharacterLock(input.characterId);
    if (held !== null && held.expiresAt > now) {
      throw new WorldError(409, `character ${input.characterId} is locked by region ${held.regionId}`);
    }
    const lock: CharacterSessionLock = {
      characterId: input.characterId,
      regionId: caller,
      epoch: await this.store.issueCharacterLockEpoch(input.characterId),
      expiresAt: now + input.ttlMs,
    };
    await this.store.putCharacterLock(lock);
    await this.store.storeOpResult(input.opId, lock);
    return lock;
  }

  /** Release a character's session lock: holder only, at the lock's epoch. */
  async releaseCharacterLock(caller: string, input: ReleaseCharacterLockInput): Promise<void> {
    await this.knownRegion(caller, input.regionId);
    if ((await this.store.getOpResult(input.opId)) !== null) return;
    const lock = await this.store.getCharacterLock(input.characterId);
    if (lock === null) throw new WorldError(404, `character ${input.characterId} is not locked`);
    if (lock.regionId !== caller) {
      throw new WorldError(403, `character ${input.characterId} is locked by region ${lock.regionId}`);
    }
    if (lock.epoch !== input.epoch) {
      throw new WorldError(409, `stale lock epoch ${input.epoch} for character ${input.characterId} (current ${lock.epoch})`);
    }
    await this.store.deleteCharacterLock(input.characterId);
    await this.store.storeOpResult(input.opId, { ok: true });
  }

  async getCharacterLock(caller: string, input: GetCharacterLockInput): Promise<CharacterSessionLock | null> {
    await this.knownRegion(caller, input.regionId);
    return this.store.getCharacterLock(input.characterId);
  }

  /** The caller's own region record: 403 on a foreign regionId, 404 when unknown. */
  private async knownRegion(caller: string, regionId: string): Promise<RegionRecord> {
    if (caller !== regionId) throw new WorldError(403, "regionId does not match token");
    const region = await this.store.getRegion(regionId);
    if (region === null) throw new WorldError(404, "unknown region");
    return region;
  }

  /**
   * The fencing check on every range-keyed state-plane write: the key
   * must be the writer's own registered range, and the carried epoch
   * must be the range's current epoch. Anything else — a zombie from
   * a previous grant, or an epoch never issued — is refused with 409
   * (the D2R rule: stale state never overwrites newer state).
   */
  private async fenceRangeWrite(region: RegionRecord, rangeKey: string, epoch: number): Promise<void> {
    if (rangeKeyFor(region.chunkRange) !== rangeKey) {
      throw new WorldError(400, `rangeKey ${rangeKey} is not region ${region.regionId}'s chunk range`);
    }
    const current = await this.store.getRangeEpoch(rangeKey);
    if (epoch !== current) {
      throw new WorldError(409, `stale epoch ${epoch} for range ${rangeKey} (current ${current})`);
    }
  }

  /** The migration, if `caller` is its source or target. */
  private async party(caller: string, migrationId: string): Promise<MigrationRecord> {
    const m = await this.store.getMigration(migrationId);
    if (m === null) throw new WorldError(404, "unknown migration");
    if (caller !== m.fromRegion && caller !== m.toRegion) throw new WorldError(403, "not a party to this migration");
    return m;
  }
}
