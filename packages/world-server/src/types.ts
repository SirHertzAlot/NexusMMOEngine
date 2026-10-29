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

/**
 * The state-plane key for a chunk range (persistence layer spec):
 * state is keyed by rangeKey, never by regionId alone, so it survives
 * the replacement of the region process that wrote it.
 */
export function rangeKeyFor(range: ChunkRange): string {
  return `${range.x0}:${range.x1}:${range.z0}:${range.z1}`;
}

export interface RegisterRegionInput {
  regionId: string;
  /**
   * The region's chunk range (explicit mode). Omit for assignment
   * mode (persistence P5): the world core assigns a range sized by
   * the host's reported resources — supply `hostId` instead.
   */
  chunkRange?: ChunkRange;
  /**
   * Assignment mode (P5): the host this region runs on. The core
   * looks up the host's fresh resource report (see
   * ReportHostResources) and assigns a range via the assignment
   * policy. Ignored when `chunkRange` is present (explicit wins).
   */
  hostId?: string;
  endpoint: string;
  capacity: number;
  /** Pre-shared bootstrap key (never stored; compared against argon2 hash). */
  apiKey: string;
  /** Client-generated UUID for idempotent retries. */
  opId: string;
}

export interface RegionLease {
  regionId: string;
  /**
   * The chunk range this lease grants (persistence P5): the explicit
   * range in explicit mode, the policy-assigned range in assignment
   * mode. The shard learns its range from here in fleet boot.
   */
  chunkRange: ChunkRange;
  heartbeatIntervalMs: number;
  registryVersion: number;
  /** Opaque bearer token for subsequent calls. */
  token: string;
  /**
   * Fencing epoch for the region's chunk range (persistence P1):
   * issued by the world core at every grant, monotonically increasing
   * per range. State-plane writes must carry this epoch; a re-grant
   * (replacement region, re-register) bumps it and fences out every
   * earlier holder.
   */
  epoch: number;
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

/**
 * A committed dungeon run (roadmap D4): what a region's instance batch
 * carries, recorded once per `instance` (replays are idempotent).
 * Wire-compatible with engine-core's `InstanceResult`.
 */
export type DungeonRunOutcome = "cleared" | "timeout" | "abandoned";

export interface DungeonRunResult {
  instance: string;
  dungeon: string;
  entrance: string;
  outcome: DungeonRunOutcome;
  startedAt: number;
  endedAt: number;
  members: number[];
  kills: { characterId: number; kind: string; count: number }[];
  deaths: { characterId: number; count: number }[];
  loot: { characterId: number; def: number }[];
}

/** A run as stored: who reported it and when. */
export interface StoredDungeonRun extends DungeonRunResult {
  regionId: string;
  reportedAt: number; // epoch ms
}

export interface ReportDungeonResultsInput {
  regionId: string;
  results: DungeonRunResult[];
}

/** Character names playing on a region (slice S2 presence). */
export interface SetPresenceInput {
  regionId: string;
  names: string[];
}

export interface QueryPresenceInput {
  regionId: string;
  names: string[];
}

// ---------------------------------------------------------------------------
// State plane (persistence layer P1): shard snapshots, ledger stream,
// character records + session locks — all epoch-fenced
// ---------------------------------------------------------------------------

/** Upload one shard checkpoint (Tier 2) to the world store. */
export interface PutShardSnapshotInput {
  regionId: string;
  /** Key derived from the writer's chunk range (see rangeKeyFor). */
  rangeKey: string;
  tick: number;
  /** The writer's fencing epoch (from its lease). */
  epoch: number;
  digest: string;
  /** Opaque serialized snapshot payload, stored verbatim for recall. */
  payload: unknown;
  opId: string;
}

/** A shard checkpoint as stored at the world tier, payload included. */
export interface ShardSnapshotRecord {
  rangeKey: string;
  /** The region that wrote it (provenance; the key is the range). */
  regionId: string;
  tick: number;
  epoch: number;
  digest: string;
  payload: unknown;
  storedAt: number; // epoch ms
}

export interface GetShardSnapshotInput {
  regionId: string;
  rangeKey: string;
}

/**
 * One streamed ledger event (Tier 1). `seq` is the source ledger's
 * per-range sequence (starting at 1); `payload` is the opaque event
 * the region's ledger recorded, stored verbatim for replay.
 */
export interface LedgerEvent {
  seq: number;
  tick: number;
  payload: unknown;
}

/** A ledger event as stored: which range's stream it belongs to. */
export interface StoredLedgerEvent extends LedgerEvent {
  rangeKey: string;
}

export interface AppendLedgerEventsInput {
  regionId: string;
  rangeKey: string;
  /** The writer's fencing epoch (from its lease). */
  epoch: number;
  opId: string;
  events: LedgerEvent[];
}

export interface GetLedgerEventsInput {
  regionId: string;
  rangeKey: string;
  /** Return events with seq > afterSeq, in seq order. */
  afterSeq: number;
}

export interface GetLedgerHeadInput {
  regionId: string;
  rangeKey: string;
}

/** A character record as stored at the world tier (slice P4 contract). */
export interface CharacterStateRecord {
  characterId: number;
  /** Opaque serialized character state, stored verbatim. */
  state: unknown;
  /** Assigned by the world: 1 for the first put, +1 per accepted put. */
  version: number;
  /** The session-lock epoch the accepted write was fenced by. */
  epoch: number;
  /** The region that wrote this version. */
  regionId: string;
  updatedAt: number; // epoch ms
}

export interface PutCharacterStateInput {
  regionId: string;
  characterId: number;
  /** The caller's session-lock epoch (see AcquireCharacterLock). */
  epoch: number;
  state: unknown;
  opId: string;
}

/** One entry of a batched character-state write (regionId is batch-level). */
export interface PutCharacterStateItem {
  characterId: number;
  /** The caller's session-lock epoch (see AcquireCharacterLock). */
  epoch: number;
  state: unknown;
  opId: string;
}

/**
 * Per-record outcome of a batched character-state write. A record that
 * fails its fencing or validation checks reports its own code/message
 * (identical to what the single put would have thrown) without
 * sinking the rest of the batch.
 */
export type PutCharacterStateOutcome =
  | { characterId: number; ok: true; record: CharacterStateRecord }
  | { characterId: number; ok: false; code: number; message: string };

export interface GetCharacterStateInput {
  regionId: string;
  characterId: number;
}

/** PL3c: shared social state every region sees — a guild, a party, a friends list, a block list. */
export type SocialKind = "guild" | "party" | "friends" | "blocks";

/** One social record at the world tier. */
export interface SocialRecord {
  kind: SocialKind;
  /** The guild's or party's world id, or the owner's lowercase name (friends, blocks). */
  key: string;
  /** Opaque content, stored verbatim; null once deleted (a tombstone, so no region uploads it again). */
  doc: unknown;
  /** Assigned by the world: 1 for the first put, +1 per accepted put. */
  version: number;
  /** The region that wrote this version. */
  regionId: string;
  updatedAt: number; // epoch ms
}

export interface PutSocialRecordInput {
  regionId: string;
  kind: SocialKind;
  key: string;
  doc: unknown;
  /** The version the writer last saw (0: it believes the record is new); any other stored version is a 409. */
  expectedVersion: number;
  opId: string;
}

export interface GetSocialRecordsInput {
  regionId: string;
  kind: SocialKind;
}

export interface AllocateSocialIdsInput {
  regionId: string;
  kind: "guild" | "party";
  count: number;
  opId: string;
}

/**
 * A character session lock (slice P4 contract): while held and
 * unexpired no other region may acquire it; after expiry it may be
 * stolen, which bumps `epoch` and fences out the previous holder.
 */
export interface CharacterSessionLock {
  characterId: number;
  regionId: string;
  epoch: number;
  expiresAt: number; // epoch ms
}

export interface AcquireCharacterLockInput {
  regionId: string;
  characterId: number;
  /** Lock lifetime; the lock is stealable once this elapses. */
  ttlMs: number;
  opId: string;
}

export interface ReleaseCharacterLockInput {
  regionId: string;
  characterId: number;
  /** Must match the held lock's epoch. */
  epoch: number;
  opId: string;
}

export interface GetCharacterLockInput {
  regionId: string;
  characterId: number;
}

// ---------------------------------------------------------------------------
// Atomic operations (ATOMIC-OPERATIONS-SPEC, slice A1): the six
// value-moving exchanges as world-tier DB functions.
//
// Governing invariant: one operation = one WorldStore call = one DB
// transaction. Each operation below is a single WorldStore method;
// the Surreal implementation persists the state change and the item
// ledger entries in one transaction, the fake in one critical
// section. The world core never assembles an operation from
// sequential store calls.
//
// State shape: a character record's opaque `state` object carries
// `gold` (integer >= 0) and `inventory` (InventoryItem[]) for these
// operations; every other key is preserved verbatim. System
// counterparties (vendor, auction house, loot source) are world-tier
// identities ("vendor:<id>", a caller-supplied sourceId, ...), so an
// exchange with the game itself has the same transaction shape.
// ---------------------------------------------------------------------------

/** The typed business rejections of every atomic operation. */
export type AtomicRejectionCode =
  | "INSUFFICIENT_FUNDS"
  | "ITEM_NOT_PRESENT"
  | "VERSION_CONFLICT"
  | "LOCK_CONFLICT"
  | "EPOCH_STALE";

export type AtomicOpKind =
  | "tradeCommit"
  | "vendorTransact"
  | "auctionSettle"
  | "craftExecute"
  | "lootGrant"
  | "inventoryMutate";

/**
 * One participant's fence: the session-lock epoch the caller carries
 * for the character, plus the record version the caller read. A stale
 * epoch is EPOCH_STALE, a missing/expired lock LOCK_CONFLICT, a
 * version mismatch VERSION_CONFLICT — and the operation never
 * partially applies.
 */
export interface ParticipantFence {
  characterId: number;
  /** The character's current session-lock epoch, as held by the caller. */
  epoch: number;
  /** The character record version the caller's decision was based on. */
  expectedVersion: number;
}

/** One item stack in a character's world-tier inventory. */
export interface InventoryItem {
  /** Globally unique item instance id (never reused). */
  instanceId: string;
  /** Item definition id. */
  def: number;
  /** Inventory slot (bag / hand / armour position, by game rules). */
  slot: number;
  /** Stack size (>= 1). */
  count: number;
}

/**
 * One movement appended to the world item ledger inside the same
 * transaction as the state change it audits: the trail and the state
 * commit or fail together. Owners are `char:<characterId>` for
 * characters and world-tier system identities otherwise
 * (`vendor:<id>`, a loot `sourceId`, `system:craft`).
 */
export interface AtomicLedgerEntry {
  /** Store-assigned, from 1, contiguous across committed operations. */
  seq: number;
  opId: string;
  op: AtomicOpKind;
  kind: "item" | "gold";
  /** Item movements only: the instance that moved. */
  instanceId?: string;
  /** Item movements only: the instance's def. */
  def?: number;
  from: string;
  to: string;
  /** Gold movements only: the amount moved. */
  amount?: number;
  /** Item movements only: the stack size moved. */
  count?: number;
  /** inventoryMutate only: the slot the item left / arrived at. */
  fromSlot?: number;
  toSlot?: number;
  at: number; // epoch ms, stamped by the store at commit
}

/** `tradeCommit`: two characters exchange item sets and gold, both ways. */
export interface TradeCommitInput {
  regionId: string;
  opId: string;
  a: ParticipantFence;
  b: ParticipantFence;
  aGivesGold: number;
  bGivesGold: number;
  /** Instance ids moving a -> b (whole stacks). */
  aGivesItems: string[];
  /** Instance ids moving b -> a (whole stacks). */
  bGivesItems: string[];
}

/** `vendorTransact`: buy (gold -> item) or sell (item -> gold), one step. */
export interface VendorTransactInput {
  regionId: string;
  opId: string;
  participant: ParticipantFence;
  /** The vendor's world-tier identity suffix (`vendor:<vendorId>`). */
  vendorId: string;
  direction: "buy" | "sell";
  /** Buy: the def being bought. Sell: the def of the instance sold. */
  def: number;
  /** Buy: gold charged. Sell: gold paid out. */
  price: number;
  /** Buy: the new instance's id. Sell: the instance leaving the bag. */
  instanceId: string;
  /** Buy only: the slot to place the item in; lowest free when omitted. */
  slot?: number;
}

/**
 * A gold credit owed to a character that could not be paid into its
 * world record at settle time (fleet auction parity): the seller was
 * online on another region, so the proceeds wait here until the
 * character's own region next interacts with the world tier — its
 * next `putCharacterState` or `acquireCharacterLock` drains every
 * pending credit into the record in one store-level fold (see
 * WorldStore.applyPendingCredits). One row per settled operation
 * (opId is unique), consumed exactly once by the drain.
 */
export interface PendingCredit {
  opId: string;
  characterId: number;
  amount: number;
  createdAt: number; // epoch ms, stamped by the store at commit
}

/** The auction house's cut of every settled price (mirrors engine-core's AUCTION_FEE; parity-tested). */
export const AUCTION_HOUSE_CUT_RATE = 0.05;

/** The world-tier identity the auction house cut is ledgered to (a pure gold sink). */
export const AUCTION_HOUSE_SINK = "system:auction-house";

/** `auctionSettle`: buyer pays, seller receives, item moves buyer-ward. */
export interface AuctionSettleInput {
  regionId: string;
  opId: string;
  buyer: ParticipantFence;
  seller: ParticipantFence;
  instanceId: string;
  price: number;
}

export interface CraftConsume {
  instanceId: string;
  count: number;
}

export interface CraftOutput {
  instanceId: string;
  def: number;
  slot?: number;
  count?: number;
}

/** `craftExecute`: consume inputs (+ optional gold fee), produce outputs. */
export interface CraftExecuteInput {
  regionId: string;
  opId: string;
  participant: ParticipantFence;
  consumes: CraftConsume[];
  goldFee: number;
  outputs: CraftOutput[];
}

/** `lootGrant`: system -> character; creates and assigns the instance. */
export interface LootGrantInput {
  regionId: string;
  opId: string;
  participant: ParticipantFence;
  /** The granting system identity, recorded as the ledger source. */
  sourceId: string;
  instanceId: string;
  def: number;
  slot?: number;
  count?: number;
}

export type InventoryMutation =
  | { kind: "move"; instanceId: string; toSlot: number }
  | { kind: "swap"; aInstanceId: string; bInstanceId: string }
  | { kind: "merge"; fromInstanceId: string; intoInstanceId: string };

/** `inventoryMutate`: move / merge / swap within one character's inventory. */
export interface InventoryMutateInput {
  regionId: string;
  opId: string;
  participant: ParticipantFence;
  mutations: InventoryMutation[];
}

/**
 * The settled outcome of an atomic operation. On success the caller
 * applies `characters` (the new world records) to its live session
 * state — the world's version is truth. On rejection nothing applied,
 * anywhere: every participating record and the ledger are exactly as
 * they were before the call.
 */
export type AtomicOpResult =
  | {
      ok: true;
      opId: string;
      op: AtomicOpKind;
      /** The participating characters' records after the commit. */
      characters: CharacterStateRecord[];
      /** The ledger entries this operation appended, in order. */
      ledger: AtomicLedgerEntry[];
    }
  | {
      ok: false;
      opId: string;
      op: AtomicOpKind;
      rejection: AtomicRejectionCode;
      message: string;
    };

/**
 * A host resource report as stored (persistence P5): one per host,
 * replaced on every report, TTL'd like heartbeats and reaped when
 * stale. `reportedAt` is stamped by the world core at ingestion
 * (server clock, like a region's lastHeartbeat) — never trusted from
 * the reporter.
 */
export interface HostResourceReport {
  hostId: string;
  cpuCores: number;
  ramTotalBytes: number;
  ramFreeBytes: number;
  /** Co-located shard load when the sidecar can measure it; absent otherwise. */
  shardLoad?: number;
  reportedAt: number; // epoch ms, server-stamped
}

/**
 * Report a host's resources (the sidecar's periodic upsert, P5).
 * Auth rides the bootstrap apiKey, exactly like RegisterRegion: the
 * sidecar is not a region and holds no lease token. State, not an
 * event — like presence/heartbeats this takes no opId: a re-report
 * simply replaces the stored report.
 */
export interface ReportHostResourcesInput {
  hostId: string;
  cpuCores: number;
  ramTotalBytes: number;
  ramFreeBytes: number;
  shardLoad?: number;
  /** Pre-shared bootstrap key (never stored; compared against argon2 hash). */
  apiKey: string;
}

/** A chunk range held by a live lease (the assignment policy's view). */
export interface LiveLeaseRange {
  regionId: string;
  chunkRange: ChunkRange;
}

/**
 * The assignment policy's inputs, exactly (persistence spec, P5):
 * host reports + the total world chunk space + live leases. The
 * requesting shard is identified by the hostId passed alongside.
 */
export interface AssignmentPolicyInput {
  hostReports: HostResourceReport[];
  totalWorldChunkSpace: ChunkRange;
  liveLeases: LiveLeaseRange[];
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
  /** Fencing epoch issued at the latest grant of this record's range. */
  epoch: number;
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
  /** Batched getOpResult: stored results by opId, absent key = none. */
  getOpResults(opIds: string[]): Promise<Map<string, unknown>>;
  /** Batched storeOpResult: one round trip per chunk where possible. */
  storeOpResults(entries: ReadonlyArray<{ opId: string; result: unknown }>): Promise<void>;
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

  // -- dungeon runs (slice D4) --
  /**
   * Record one run. Returns true when stored, false when `instance` was
   * already recorded (a retried batch): the caller still counts it
   * ingested, so a replay never stores a run twice.
   */
  recordDungeonRun(run: StoredDungeonRun): Promise<boolean>;
  /** Runs on record, oldest first; filtered by reporting region when given. */
  listDungeonRuns(regionId?: string): Promise<StoredDungeonRun[]>;

  // -- presence (slice S2) --
  /** Replace the region's online character names. */
  setPresence(regionId: string, names: string[]): Promise<void>;
  /** Region per name for characters online now; null when nowhere. */
  queryPresence(names: string[]): Promise<Map<string, string | null>>;

  // -- state plane (persistence P1) --
  /**
   * Issue the next fencing epoch for a range: strictly greater than
   * every epoch issued for it before (the store remembers across
   * region records, deregistration included).
   */
  issueRangeEpoch(rangeKey: string): Promise<number>;
  /** The latest epoch issued for a range; 0 when never issued. */
  getRangeEpoch(rangeKey: string): Promise<number>;
  /** Store a shard checkpoint as the range's latest (one per rangeKey). */
  putShardSnapshot(s: ShardSnapshotRecord): Promise<void>;
  getLatestShardSnapshot(rangeKey: string): Promise<ShardSnapshotRecord | null>;
  /**
   * Append events to a range's ledger stream, idempotent on
   * (rangeKey, seq): an already-stored seq keeps its first-written
   * event and is never duplicated. Returns the contiguous acked head:
   * the greatest seq N such that 1..N are all stored.
   */
  appendLedgerEvents(rangeKey: string, events: LedgerEvent[]): Promise<number>;
  /** Stored events with seq > afterSeq, in ascending seq order. */
  getLedgerEvents(rangeKey: string, afterSeq: number): Promise<StoredLedgerEvent[]>;
  /** The contiguous acked head seq for a range; 0 when none. */
  getLedgerHead(rangeKey: string): Promise<number>;
  getCharacterState(characterId: number): Promise<CharacterStateRecord | null>;
  /** Store a character record verbatim (the core assigns its version). */
  putCharacterState(r: CharacterStateRecord): Promise<void>;
  /**
   * Batched form of putCharacterState: many records in as few store
   * round trips as the implementation can manage, with identical
   * per-record semantics (each record is stored verbatim, overwriting
   * any prior record for its character). The save-sweep write path.
   */
  putCharacterStates(records: CharacterStateRecord[]): Promise<void>;
  /** Batched getCharacterState: records by characterId, absent key = none. */
  getCharacterStates(characterIds: number[]): Promise<Map<number, CharacterStateRecord>>;
  /** The character's session lock as stored, or null when unheld. */
  getCharacterLock(characterId: number): Promise<CharacterSessionLock | null>;
  /** Batched getCharacterLock: locks by characterId, absent key = unheld. */
  getCharacterLocks(characterIds: number[]): Promise<Map<number, CharacterSessionLock>>;
  putCharacterLock(l: CharacterSessionLock): Promise<void>;
  deleteCharacterLock(characterId: number): Promise<void>;
  /**
   * Issue the next session-lock epoch for a character. Never reused,
   * even after a release, so a previous session's writes stay fenced.
   */
  issueCharacterLockEpoch(characterId: number): Promise<number>;

  // -- social records (PL3c) --
  getSocialRecord(kind: SocialKind, key: string): Promise<SocialRecord | null>;
  /** Store a record verbatim (the core assigns its version). */
  putSocialRecord(r: SocialRecord): Promise<void>;
  /** Every record of a kind, tombstones included. */
  listSocialRecords(kind: SocialKind): Promise<SocialRecord[]>;
  /** `count` fresh ids for a kind, never issued before (a world-wide counter per kind). */
  allocateSocialIds(kind: "guild" | "party", count: number): Promise<number[]>;

  // -- atomic operations (slice A1) --
  // Each method IS the operation: validation, the state change, and
  // the item-ledger append happen inside it as one transaction /
  // critical section. Business failures are returned as typed
  // rejections (AtomicOpResult), never thrown, and commit nothing.
  tradeCommit(input: TradeCommitInput): Promise<AtomicOpResult>;
  vendorTransact(input: VendorTransactInput): Promise<AtomicOpResult>;
  auctionSettle(input: AuctionSettleInput): Promise<AtomicOpResult>;
  craftExecute(input: CraftExecuteInput): Promise<AtomicOpResult>;
  lootGrant(input: LootGrantInput): Promise<AtomicOpResult>;
  inventoryMutate(input: InventoryMutateInput): Promise<AtomicOpResult>;
  /** The world item ledger written by atomic operations, in seq order. */
  getAtomicLedger(): Promise<AtomicLedgerEntry[]>;
  /** A character's unconsumed pending credits, oldest first. */
  listPendingCredits(characterId: number): Promise<PendingCredit[]>;
  /**
   * Fold ALL pending credits for the character into its CURRENT world
   * record in one store-level operation: gold += total, version + 1,
   * updatedAt = now, the credit rows are consumed, and the updated
   * record is returned. When there is no record, or the record's state
   * carries no numeric `gold`, or there are no credits: consume
   * NOTHING and return `{ total: 0, record: <current or null> }`.
   */
  applyPendingCredits(characterId: number): Promise<{ total: number; record: CharacterStateRecord | null }>;

  // -- host reports (persistence P5) --
  /** Store a host's latest resource report (one per hostId, replaced). */
  upsertHostReport(r: HostResourceReport): Promise<void>;
  getHostReport(hostId: string): Promise<HostResourceReport | null>;
  listHostReports(): Promise<HostResourceReport[]>;
  /** Delete reports older than cutoffMs (reportedAt < cutoff); return hostIds. */
  reapStaleHostReports(cutoffMs: number): Promise<string[]>;
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
  /**
   * Ingest a region's committed dungeon runs (slice D4). `caller` is the
   * authenticated region id and must match `input.regionId`. Idempotent
   * on `instance`: every input id is returned ingested, but a replayed
   * run is stored only once.
   */
  reportDungeonResults(caller: string, input: ReportDungeonResultsInput): Promise<{ ingested: string[] }>;
  /**
   * Replace the region's online character names (slice S2 presence).
   * `caller` must match `input.regionId`. State, not events: repeats are
   * harmless, and logging out is an empty report.
   */
  setPresence(caller: string, input: SetPresenceInput): Promise<void>;
  /**
   * Where queried names play, by region (slice S2 presence). Absent or
   * offline names map to null. `caller` must be a known region.
   */
  queryPresence(caller: string, input: QueryPresenceInput): Promise<{ online: Record<string, string | null> }>;

  // -- persistence P1: state plane (`caller` must match input.regionId) --
  /**
   * Store a shard checkpoint at the world tier (Tier 2). Fenced: the
   * caller's lease epoch must be the range's current epoch, and the
   * rangeKey must be the caller's registered range. Idempotent on opId.
   */
  putShardSnapshot(caller: string, input: PutShardSnapshotInput): Promise<ShardSnapshotRecord>;
  /** The range's latest stored checkpoint, payload included; null when none. Reads are unfenced (boot recall). */
  getShardSnapshot(caller: string, rangeKey: string): Promise<ShardSnapshotRecord | null>;
  /**
   * Stream ledger events uphill (Tier 1). Fenced like snapshots and
   * idempotent on both opId and (rangeKey, seq). Returns the
   * contiguous acked head seq the region may mark flushed.
   */
  appendLedgerEvents(caller: string, input: AppendLedgerEventsInput): Promise<{ ackedSeq: number }>;
  /** Stored ledger events after `afterSeq` (recall/replay reads). */
  getLedgerEvents(caller: string, input: GetLedgerEventsInput): Promise<{ events: StoredLedgerEvent[] }>;
  /** The contiguous acked head seq for a range. */
  getLedgerHead(caller: string, input: GetLedgerHeadInput): Promise<{ ackedSeq: number }>;
  /**
   * Write a character's state (slice P4 contract). Fenced by the
   * session lock: the caller must hold the character's unexpired lock
   * and carry its epoch. Idempotent on opId.
   */
  putCharacterState(caller: string, input: PutCharacterStateInput): Promise<CharacterStateRecord>;
  /**
   * Batched form of putCharacterState: the whole batch's reads ride a
   * constant number of store round trips and its writes land in one
   * batched store call. Per-record ceremony (dedup, fencing, credits
   * drain, version assignment) matches the single put exactly; a
   * record's failure is reported in its outcome, not thrown.
   */
  putCharacterStates(
    caller: string,
    regionId: string,
    items: PutCharacterStateItem[],
  ): Promise<PutCharacterStateOutcome[]>;
  /** A character's stored record, version included; null when none. */
  getCharacterState(caller: string, input: GetCharacterStateInput): Promise<CharacterStateRecord | null>;
  /**
   * Acquire a character's session lock. Refused (409) while a lock is
   * held and unexpired; after expiry the lock is stolen with its epoch
   * bumped. Idempotent on opId.
   */
  acquireCharacterLock(caller: string, input: AcquireCharacterLockInput): Promise<CharacterSessionLock>;
  /**
   * Release a character's session lock: only the holder, carrying the
   * lock's epoch. Idempotent on opId.
   */
  releaseCharacterLock(caller: string, input: ReleaseCharacterLockInput): Promise<void>;
  /** A character's current session lock; null when unheld. */
  getCharacterLock(caller: string, input: GetCharacterLockInput): Promise<CharacterSessionLock | null>;

  // -- social records (PL3c): guilds, parties, friends and blocks every region shares --
  /**
   * Write a social record. Version-guarded: `expectedVersion` must be the stored version (0 for a new
   * record), else 409 and the writer rereads. Idempotent on opId.
   */
  putSocialRecord(caller: string, input: PutSocialRecordInput): Promise<SocialRecord>;
  /** Every record of a kind, tombstones included (a region's boot and periodic refresh). */
  getSocialRecords(caller: string, input: GetSocialRecordsInput): Promise<SocialRecord[]>;
  /** World-wide fresh guild or party ids. Idempotent on opId. */
  allocateSocialIds(caller: string, input: AllocateSocialIdsInput): Promise<number[]>;

  // -- atomic operations (slice A1) --
  // Each core op is idempotent on opId (a replay returns the stored
  // outcome, success or rejection, and never re-applies) and delegates
  // the exchange itself to exactly ONE WorldStore call — the store
  // executes it as one transaction. Rejections are outcomes, returned
  // in the result, not thrown: nothing partially applies, ever.
  tradeCommit(caller: string, input: TradeCommitInput): Promise<AtomicOpResult>;
  vendorTransact(caller: string, input: VendorTransactInput): Promise<AtomicOpResult>;
  auctionSettle(caller: string, input: AuctionSettleInput): Promise<AtomicOpResult>;
  craftExecute(caller: string, input: CraftExecuteInput): Promise<AtomicOpResult>;
  lootGrant(caller: string, input: LootGrantInput): Promise<AtomicOpResult>;
  inventoryMutate(caller: string, input: InventoryMutateInput): Promise<AtomicOpResult>;

  // -- persistence P5: host reports + resource-aware assignment --
  /**
   * Ingest a host resource report (the sidecar's periodic upsert).
   * Bootstrap-authenticated by the apiKey in the input, like
   * registration. Returns the stored report (server-stamped
   * reportedAt included). No opId: state, not an event — mirrors
   * presence/heartbeat semantics.
   */
  reportHostResources(input: ReportHostResourcesInput): Promise<HostResourceReport>;
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
  /**
   * The total world chunk space assignments are carved from
   * (persistence P5). Default: the engine's long-standing world
   * extent {x0: 0, x1: 4096, z0: 0, z1: 4096}.
   */
  totalWorldChunkSpace?: ChunkRange;
  /** How long a host report stays fresh for assignment (default: heartbeatTimeoutMs). */
  hostReportTimeoutMs?: number;
  /**
   * The chunk-assignment policy (persistence P5): a pure, swappable
   * function behind this interface (see assignment.ts). Default:
   * DefaultChunkAssignmentPolicy.
   */
  assignmentPolicy?: import("./assignment.js").ChunkAssignmentPolicy;
}
