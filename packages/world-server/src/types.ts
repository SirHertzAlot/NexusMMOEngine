/**
 * World server domain types + the transport-agnostic core interfaces.
 *
 * WorldCore is the entire contract the world server fulfills. Transport
 * adapters (webrpc today, queue/embedded-stub later) translate their
 * medium into these calls and nothing else. Nothing in the core imports
 * Express, webrpc, or any queue client.
 *
 * WorldStore is the storage boundary behind the core: SurrealDB in
 * production, a fake in-memory store in tests.
 */

// ---------------------------------------------------------------------------
// Domain types (mirror world.ridl)
// ---------------------------------------------------------------------------

export interface ChunkRange {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface RegisterRegionInput {
  regionId: string;
  chunkRange: ChunkRange;
  endpoint: string;
  capacity: number;
  /** Pre-shared bootstrap key (never stored; compared against argon2 hash). */
  apiKey: string;
  /** Client-generated UUID for idempotent retries. */
  opId: string;
}

export interface RegionLease {
  regionId: string;
  heartbeatIntervalMs: number;
  registryVersion: number;
  /** Opaque bearer token for subsequent calls. */
  token: string;
}

export interface HeartbeatInput {
  regionId: string;
  load: number;
  tickJitterMs: number;
  entityCount: number;
}

/** begun -> committed | aborted | expired; the last three are final. */
export type MigrationState = "begun" | "committed" | "aborted" | "expired";

export interface MigrationOutcome {
  migrationId: string;
  entityId: string;
  fromRegion: string;
  toRegion: string;
  state: MigrationState;
}

export interface HeartbeatAck {
  ok: boolean;
  registryVersion: number;
  migrations: MigrationOutcome[];
}

export interface SnapshotReportInput {
  regionId: string;
  tick: number;
  entityCount: number;
  digest: string;
}

export interface BeginMigrationInput {
  opId: string;
  entityId: string;
  fromRegion: string;
  toRegion: string;
  /** Serialized ECS state; travels through the world in v1 (spec §6). */
  entityState: unknown;
}

export interface CommitMigrationInput { migrationId: string; opId: string; }
export interface AbortMigrationInput { migrationId: string; opId: string; reason: string; }

/** One migration as the world records it (spec §5 `migration` table). */
export interface MigrationRecord {
  migrationId: string;
  entityId: string;
  fromRegion: string;
  toRegion: string;
  state: MigrationState;
  entityState: unknown;
  /** Why it was aborted or expired; "" otherwise. */
  reason: string;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/** A region as other regions see it (ListRegions): no secrets. */
export interface RegionInfo {
  regionId: string;
  chunkRange: ChunkRange;
  endpoint: string;
  live: boolean;
}

/** Persistent region record. */
export interface RegionRecord {
  regionId: string;
  chunkRange: ChunkRange;
  endpoint: string;
  capacity: number;
  load: number;
  tickJitterMs: number;
  entityCount: number;
  lastTick: number;
  lastHeartbeat: number; // epoch ms
  apiKeyHash: string; // argon2id
  tokenHash: string | null; // sha256 of the current bearer token
  tokenIssuedAt: number | null;
}

/** webrpc-style error: { code, msg } over the wire. */
export class WorldError extends Error {
  readonly code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.name = "WorldError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// WorldStore: storage boundary (SurrealDB in prod, fake in tests)
// ---------------------------------------------------------------------------

export interface WorldStore {
  upsertRegion(r: RegionRecord): Promise<void>;
  getRegion(regionId: string): Promise<RegionRecord | null>;
  /** Indexed bearer-token lookup (tokenHash = sha256Hex(token)). */
  getRegionByTokenHash(tokenHash: string): Promise<RegionRecord | null>;
  listRegions(): Promise<RegionRecord[]>;
  deleteRegion(regionId: string): Promise<void>;
  /** Delete regions whose lastHeartbeat is older than cutoffMs; return ids. */
  reapStaleRegions(cutoffMs: number): Promise<string[]>;
  /** Idempotency: stored result for opId, or null. */
  getOpResult(opId: string): Promise<unknown | null>;
  storeOpResult(opId: string, result: unknown): Promise<void>;
  getRegistryVersion(): Promise<number>;
  bumpRegistryVersion(): Promise<void>;

  // -- migrations (slice B) --
  createMigration(m: MigrationRecord): Promise<void>;
  getMigration(migrationId: string): Promise<MigrationRecord | null>;
  /** The entity's migration in state `begun`, if any (at most one). */
  getBegunMigrationForEntity(entityId: string): Promise<MigrationRecord | null>;
  /**
   * Compare-and-set: move `migrationId` from `begun` to `to` (with reason
   * and updatedAt). Returns the updated record, or null if it was not
   * `begun` any more. This is what makes commit and expiry race-safe.
   */
  resolveMigration(migrationId: string, to: Exclude<MigrationState, "begun">, reason: string, now: number): Promise<MigrationRecord | null>;
  /** Migrations naming the region as source or target, begun or updated since `sinceMs`. */
  listMigrationsForRegion(regionId: string, sinceMs: number): Promise<MigrationRecord[]>;
  /** Ids of migrations still `begun` and created before `cutoffMs`. */
  listBegunBefore(cutoffMs: number): Promise<string[]>;
  /** Delete final migrations last updated before `cutoffMs` (housekeeping). */
  pruneMigrations(cutoffMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// WorldCore: the transport-agnostic core
// ---------------------------------------------------------------------------

export interface WorldCore {
  registerRegion(input: RegisterRegionInput): Promise<RegionLease>;
  heartbeat(input: HeartbeatInput): Promise<HeartbeatAck>;
  deregisterRegion(regionId: string, opId: string): Promise<void>;
  reportSnapshot(input: SnapshotReportInput): Promise<void>;
  /** Reap regions silent longer than the timeout. Returns reaped ids. */
  reapStale(): Promise<string[]>;

  // -- slice B: `caller` is the authenticated region id --
  listRegions(): Promise<RegionInfo[]>;
  beginMigration(caller: string, input: BeginMigrationInput): Promise<{ migrationId: string }>;
  commitMigration(caller: string, input: CommitMigrationInput): Promise<void>;
  abortMigration(caller: string, input: AbortMigrationInput): Promise<void>;
  /** The record, entity state included; source and target only (the backstop when the source dies). */
  getMigration(caller: string, migrationId: string): Promise<MigrationRecord>;
  /** Expire migrations begun longer ago than the timeout. Returns their ids. */
  expireMigrations(): Promise<string[]>;
}

export interface WorldCoreOptions {
  store: WorldStore;
  /** How long a region may go without heartbeat before reaping. */
  heartbeatTimeoutMs: number;
  /** Heartbeat interval handed out in leases. */
  heartbeatIntervalMs: number;
  /** A migration not committed within this expires; the source keeps authority (default 10000). */
  migrationTimeoutMs?: number;
  /** How long a resolved migration keeps appearing in heartbeat acks (default 60000). */
  outcomeRetentionMs?: number;
}
