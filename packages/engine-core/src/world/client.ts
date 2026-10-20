/**
 * WorldClient: the region side of the region<->world contract.
 *
 * A region (engine instance) uses this to register with the world
 * server, heartbeat on a timer (off the tick loop), report snapshots,
 * and deregister on shutdown. The transport is swappable:
 * WebrpcWorldTransport (webrpc JSON over HTTP) now; queue or embedded
 * stub later — the client doesn't care.
 */
import {
  rangeKeyFor,
  type CharacterSessionLock,
  type CharacterStateRecord,
  type ChunkRange,
  type HeartbeatAck,
  type LedgerEvent,
  type MigrationRecord,
  type RegionInfo,
  type RegionLease,
  type ShardSnapshotRecord,
  type StoredLedgerEvent,
} from "@mmo-engine/world-server";
import type { InstanceResult } from "../dungeons/instance.js";

export interface WorldTransport {
  /**
   * Call a World service method. `args` are the named RIDL arguments
   * (e.g. { input: {...} }); returns the named outputs
   * (e.g. { lease: {...} }). Throws WorldTransportError on failure.
   */
  call(
    method: string,
    args: Record<string, unknown>,
    token?: string,
  ): Promise<Record<string, unknown>>;
}

export class WorldTransportError extends Error {
  readonly code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.name = "WorldTransportError";
    this.code = code;
  }
}

export interface WorldClientOptions {
  transport: WorldTransport;
  regionId: string;
  /**
   * The region's chunk range (explicit mode). Omit for assignment
   * mode (persistence P5): the client registers with `hostId`
   * instead, and the range arrives in the lease the world grants.
   */
  chunkRange?: ChunkRange;
  /**
   * Assignment mode (P5): the host this region runs on, whose
   * reported resources size the range the world assigns. Required
   * when `chunkRange` is omitted; ignored otherwise.
   */
  hostId?: string;
  /** Where this region's game gateway listens. */
  endpoint: string;
  capacity: number;
  /** Pre-shared bootstrap key (matches the world's WORLD_API_KEY). */
  apiKey: string;
  /** Fallback heartbeat interval if the lease is unreachable. */
  heartbeatIntervalMs?: number;
  /** Live stats sampled on each heartbeat (defaults to zeros). */
  getStats?: () => { load: number; tickJitterMs: number; entityCount: number };
  onError?: (err: unknown, context: string) => void;
  /** Every heartbeat ack from the timer (migration outcomes ride on it). */
  onAck?: (ack: HeartbeatAck) => void;
}

function newOpId(): string {
  return `op-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class WorldClient {
  private readonly transport: WorldTransport;
  private readonly opts: WorldClientOptions;
  /**
   * The region's effective chunk range: the configured range in
   * explicit mode; in assignment mode, the range from the granted
   * lease (null until the first registration lands).
   */
  private effectiveRange: ChunkRange | null;
  private lease: RegionLease | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts: WorldClientOptions) {
    this.transport = opts.transport;
    this.opts = opts;
    this.effectiveRange = opts.chunkRange ?? null;
  }

  get currentLease(): RegionLease | null {
    return this.lease;
  }

  /**
   * The chunk range this region owns: the explicit range, or the
   * world-assigned range once registered (P5). Null only for an
   * unassigned client that has not (yet) registered.
   */
  get chunkRange(): ChunkRange | null {
    return this.effectiveRange;
  }

  /**
   * The fencing epoch from the current lease (persistence P1); null
   * while unregistered. Every state-plane write carries it, and the
   * world rejects writes from a stale epoch — a re-register rotates it.
   */
  get epoch(): number | null {
    return this.lease?.epoch ?? null;
  }

  /**
   * The state-plane key (`rangeKeyFor(chunkRange)`) for this region.
   * In assignment mode it exists only after registration granted a
   * range; every state-plane caller runs post-registration, so a
   * throw here is a boot-ordering bug, never a runtime condition.
   */
  get rangeKey(): string {
    if (this.effectiveRange === null) {
      throw new WorldTransportError(
        0,
        "no chunk range yet: the world has not granted a lease (assignment mode)",
      );
    }
    return rangeKeyFor(this.effectiveRange);
  }

  get registered(): boolean {
    return this.lease !== null;
  }

  get regionId(): string {
    return this.opts.regionId;
  }

  private fail(err: unknown, context: string): void {
    if (this.opts.onError) this.opts.onError(err, context);
  }

  /** Register and start the heartbeat timer. Never throws. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.register();
    const interval = Math.max(
      1000,
      this.lease?.heartbeatIntervalMs ?? this.opts.heartbeatIntervalMs ?? 5000,
    );
    this.timer = setInterval(() => {
      void this.heartbeat()
        .then((ack) => { if (ack && this.opts.onAck) this.opts.onAck(ack); })
        .catch((err) => this.fail(err, "heartbeat"));
    }, interval);
    this.timer.unref();
  }

  private async register(): Promise<void> {
    try {
      // Explicit mode sends the fixed range; assignment mode (P5)
      // sends the hostId instead and adopts the range the world
      // grants in the lease — from here on the shipper, recall, and
      // character sync all key off that range through this client.
      const input: Record<string, unknown> = {
        regionId: this.opts.regionId,
        endpoint: this.opts.endpoint,
        capacity: this.opts.capacity,
        apiKey: this.opts.apiKey,
        opId: newOpId(),
      };
      if (this.opts.chunkRange !== undefined) {
        input["chunkRange"] = this.opts.chunkRange;
      } else {
        input["hostId"] = this.opts.hostId;
      }
      const res = await this.transport.call("RegisterRegion", { input });
      this.lease = res["lease"] as RegionLease;
      if (this.lease?.chunkRange) {
        this.effectiveRange = this.lease.chunkRange;
      }
    } catch (err) {
      this.fail(err, "register");
    }
  }

  /** One heartbeat. Re-registers if the world forgot us (unknown region
   *  or revoked token, e.g. the world restarted on a fresh store). */
  async heartbeat(): Promise<HeartbeatAck | null> {
    if (this.stopped || !this.lease) return null;
    const stats = this.opts.getStats?.() ?? {
      load: 0,
      tickJitterMs: 0,
      entityCount: 0,
    };
    try {
      const res = await this.transport.call(
        "Heartbeat",
        {
          input: {
            regionId: this.opts.regionId,
            load: stats.load,
            tickJitterMs: stats.tickJitterMs,
            entityCount: stats.entityCount,
          },
        },
        this.lease.token,
      );
      return res["ack"] as HeartbeatAck;
    } catch (err) {
      if (
        err instanceof WorldTransportError &&
        (err.code === 404 || err.code === 401)
      ) {
        // World restarted or reaped us: re-register for a fresh token.
        // (A genuinely wrong API key fails at register, not here, so a
        // 401 loop always converges to unregistered + warned.)
        this.lease = null;
        await this.register();
        return null;
      }
      throw err;
    }
  }

  /** Best-effort stats report; lossy-OK by design. */
  async reportSnapshot(
    tick: number,
    entityCount: number,
    digest: string,
  ): Promise<void> {
    if (this.stopped || !this.lease) return;
    try {
      await this.transport.call(
        "ReportSnapshot",
        {
          input: {
            regionId: this.opts.regionId,
            tick,
            entityCount,
            digest,
          },
        },
        this.lease.token,
      );
    } catch (err) {
      this.fail(err, "reportSnapshot");
    }
  }

  // -------------------------------------------- persistence P2: state plane
  // Tier 1 + Tier 2 uploads (PERSISTENCE-LAYER-SPEC). Like reportSnapshot
  // these are best-effort and never throw into the save cycle: a failure
  // surfaces through onError and the caller retries on its next cycle —
  // a dead world degrades durability, never simulation.

  /**
   * Stream one batch of ledger events uphill (Tier 1). Returns the
   * world's contiguous acked head seq, or null when the batch was not
   * acked (unregistered, stopped, empty, or the call failed) — the
   * caller keeps the events unshipped and retries them next cycle.
   * The world dedups on (rangeKey, seq), so a retried batch is safe.
   */
  async appendLedgerEvents(
    events: readonly LedgerEvent[],
  ): Promise<number | null> {
    if (this.stopped || !this.lease || events.length === 0) return null;
    try {
      const res = await this.transport.call(
        "AppendLedgerEvents",
        {
          input: {
            regionId: this.opts.regionId,
            rangeKey: this.rangeKey,
            epoch: this.lease.epoch,
            opId: newOpId(),
            events: [...events],
          },
        },
        this.lease.token,
      );
      return res["ackedSeq"] as number;
    } catch (err) {
      this.fail(err, "appendLedgerEvents");
      return null;
    }
  }

  /**
   * Upload one shard checkpoint (Tier 2): the snapshot payload under
   * {rangeKey, tick, epoch, digest}. Returns whether the world stored
   * it; false means retry on a later cycle (or drop it when a fresher
   * checkpoint has superseded it — the shipper decides).
   */
  async putShardSnapshot(snapshot: {
    tick: number;
    digest: string;
    payload: unknown;
  }): Promise<boolean> {
    if (this.stopped || !this.lease) return false;
    try {
      await this.transport.call(
        "PutShardSnapshot",
        {
          input: {
            regionId: this.opts.regionId,
            rangeKey: this.rangeKey,
            tick: snapshot.tick,
            epoch: this.lease.epoch,
            digest: snapshot.digest,
            payload: snapshot.payload,
            opId: newOpId(),
          },
        },
        this.lease.token,
      );
      return true;
    } catch (err) {
      this.fail(err, "putShardSnapshot");
      return false;
    }
  }

  // -------------------------------------------- persistence P3: recall reads
  // Boot-recall reads (PERSISTENCE-LAYER-SPEC, Recovery). The world
  // core leaves reads unfenced, but they still require an authenticated
  // known region — which is why fleet boot registers BEFORE recalling
  // (see state-recall.ts). Like the migration ops below these throw on
  // transport failure: the recall path decides what a failure means
  // (fall back to the local working cache, never block the boot).

  /** The range's latest world-tier checkpoint, payload included; null when the world holds none. */
  async getShardSnapshot(): Promise<ShardSnapshotRecord | null> {
    const res = await this.transport.call(
      "GetShardSnapshot",
      { input: { regionId: this.opts.regionId, rangeKey: this.rangeKey } },
      this.token(),
    );
    return (res["snapshot"] as ShardSnapshotRecord | null) ?? null;
  }

  /** Stored ledger events for this range with seq > afterSeq, in seq order. */
  async getLedgerEvents(afterSeq: number): Promise<StoredLedgerEvent[]> {
    const res = await this.transport.call(
      "GetLedgerEvents",
      {
        input: {
          regionId: this.opts.regionId,
          rangeKey: this.rangeKey,
          afterSeq,
        },
      },
      this.token(),
    );
    return res["events"] as StoredLedgerEvent[];
  }

  /** The world's contiguous acked ledger head seq for this range. */
  async getLedgerHead(): Promise<number> {
    const res = await this.transport.call(
      "GetLedgerHead",
      { input: { regionId: this.opts.regionId, rangeKey: this.rangeKey } },
      this.token(),
    );
    return res["ackedSeq"] as number;
  }

  // ---------------------------------------------------------- slice B
  // Unlike heartbeats these throw: the migration coordinator decides
  // what a failure means for the entity.

  private token(): string {
    if (!this.lease) throw new WorldTransportError(0, "not registered with the world");
    return this.lease.token;
  }

  async listRegions(): Promise<RegionInfo[]> {
    const res = await this.transport.call("ListRegions", {}, this.token());
    return res["regions"] as RegionInfo[];
  }

  /**
   * Report committed dungeon runs (roadmap D4): the region's
   * `InstanceResultStore.unreported()` batch. Throws on transport
   * failure (like the migration ops): the caller keeps the rows
   * unreported and retries later. The world ingests them idempotently
   * once `ReportDungeonResults` exists there (next slice; today the
   * world answers 501 and nothing is marked reported).
   */
  async reportDungeonResults(results: readonly InstanceResult[]): Promise<string[]> {
    const res = await this.transport.call(
      "ReportDungeonResults",
      { input: { regionId: this.opts.regionId, results } },
      this.token(),
    );
    return res["ingested"] as string[];
  }

  async beginMigration(entityId: string, toRegion: string, entityState: Record<string, unknown> | null): Promise<string> {
    const res = await this.transport.call(
      "BeginMigration",
      { input: { opId: newOpId(), entityId, fromRegion: this.opts.regionId, toRegion, entityState } },
      this.token(),
    );
    return res["migrationId"] as string;
  }

  async commitMigration(migrationId: string): Promise<void> {
    await this.transport.call("CommitMigration", { migrationId, opId: newOpId() }, this.token());
  }

  async abortMigration(migrationId: string, reason: string): Promise<void> {
    await this.transport.call("AbortMigration", { migrationId, opId: newOpId(), reason }, this.token());
  }

  async getMigration(migrationId: string): Promise<MigrationRecord> {
    const res = await this.transport.call("GetMigration", { migrationId }, this.token());
    return res["migration"] as MigrationRecord;
  }

  /**
   * Replace the region's online character names (roadmap S2 presence).
   * Best-effort like snapshots: a failure reports through onError and
   * the next login/logout retries. Throws nothing.
   */
  async reportPresence(names: string[]): Promise<void> {
    if (this.stopped || !this.lease) return;
    try {
      await this.transport.call(
        "SetPresence",
        { input: { regionId: this.opts.regionId, names } },
        this.lease.token,
      );
    } catch (err) {
      this.fail(err, "reportPresence");
    }
  }

  /**
   * Where queried names play, by region id (null: nowhere). Throws on
   * transport failure, like the migration ops: the caller keeps its
   * local presence until the world answers.
   */
  async queryPresence(names: string[]): Promise<Record<string, string | null>> {
    const res = await this.transport.call(
      "QueryPresence",
      { input: { regionId: this.opts.regionId, names } },
      this.token(),
    );
    return res["online"] as Record<string, string | null>;
  }

  // ------------------------------------- persistence P4 contract (world tier)
  // Thin mirrors of the P1 character ops; slice P4 wires their gateway
  // usage. Like the migration ops these throw on transport failure:
  // the caller (login/save path) decides what a failure means.

  /** A character's world-tier record, or null when none exists yet. */
  async getCharacterState(
    characterId: number,
  ): Promise<CharacterStateRecord | null> {
    const res = await this.transport.call(
      "GetCharacterState",
      { input: { regionId: this.opts.regionId, characterId } },
      this.token(),
    );
    return (res["character"] as CharacterStateRecord | null) ?? null;
  }

  /**
   * Write a character's state at the world tier. Fenced by the session
   * lock: `epoch` must be the epoch of the lock this region holds for
   * the character (see acquireCharacterLock).
   */
  async putCharacterState(
    characterId: number,
    epoch: number,
    state: unknown,
  ): Promise<CharacterStateRecord> {
    const res = await this.transport.call(
      "PutCharacterState",
      {
        input: {
          regionId: this.opts.regionId,
          characterId,
          epoch,
          state,
          opId: newOpId(),
        },
      },
      this.token(),
    );
    return res["character"] as CharacterStateRecord;
  }

  /**
   * Acquire a character's session lock (refused while another region
   * holds it unexpired; an expired lock is stolen with an epoch bump).
   */
  async acquireCharacterLock(
    characterId: number,
    ttlMs: number,
  ): Promise<CharacterSessionLock> {
    const res = await this.transport.call(
      "AcquireCharacterLock",
      {
        input: {
          regionId: this.opts.regionId,
          characterId,
          ttlMs,
          opId: newOpId(),
        },
      },
      this.token(),
    );
    return res["lock"] as CharacterSessionLock;
  }

  /** Release a character's session lock; `epoch` must match the held lock. */
  async releaseCharacterLock(characterId: number, epoch: number): Promise<void> {
    await this.transport.call(
      "ReleaseCharacterLock",
      {
        input: {
          regionId: this.opts.regionId,
          characterId,
          epoch,
          opId: newOpId(),
        },
      },
      this.token(),
    );
  }

  /** Stop heartbeats and best-effort deregister. Never throws. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lease) {
      try {
        await this.transport.call(
          "DeregisterRegion",
          { regionId: this.opts.regionId, opId: newOpId() },
          this.lease.token,
        );
      } catch (err) {
        this.fail(err, "deregister");
      }
      this.lease = null;
    }
  }
}
