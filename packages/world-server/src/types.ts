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

export interface MigrationOutcome {
  migrationId: string;
  state: string;
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

/** Slice B. Declared now so the wire shape is stable. */
export interface BeginMigrationInput {
  opId: string;
  entityId: string;
  fromRegion: string;
  toRegion: string;
  entityState: unknown;
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
}

export interface WorldCoreOptions {
  store: WorldStore;
  /** How long a region may go without heartbeat before reaping. */
  heartbeatTimeoutMs: number;
  /** Heartbeat interval handed out in leases. */
  heartbeatIntervalMs: number;
}
