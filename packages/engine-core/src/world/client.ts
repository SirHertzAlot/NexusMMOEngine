/**
 * WorldClient: the region side of the region<->world contract.
 *
 * A region (engine instance) uses this to register with the world
 * server, heartbeat on a timer (off the tick loop), report snapshots,
 * and deregister on shutdown. The transport is swappable:
 * WebrpcWorldTransport (webrpc JSON over HTTP) now; queue or embedded
 * stub later — the client doesn't care.
 */
import type {
  ChunkRange,
  HeartbeatAck,
  MigrationRecord,
  RegionInfo,
  RegionLease,
} from "@mmo-engine/world-server";

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
  chunkRange: ChunkRange;
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
  private lease: RegionLease | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts: WorldClientOptions) {
    this.transport = opts.transport;
    this.opts = opts;
  }

  get currentLease(): RegionLease | null {
    return this.lease;
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
      const res = await this.transport.call("RegisterRegion", {
        input: {
          regionId: this.opts.regionId,
          chunkRange: this.opts.chunkRange,
          endpoint: this.opts.endpoint,
          capacity: this.opts.capacity,
          apiKey: this.opts.apiKey,
          opId: newOpId(),
        },
      });
      this.lease = res["lease"] as RegionLease;
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
