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
  type ChunkRange,
  type HeartbeatAck,
  type HeartbeatInput,
  type RegionLease,
  type RegionRecord,
  type RegisterRegionInput,
  type SnapshotReportInput,
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

export class WorldCoreImpl implements WorldCore {
  private readonly store: WorldStore;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  /** argon2id hash of the bootstrap API key (null = registration disabled). */
  private readonly apiKeyHash: string | null;

  constructor(opts: WorldCoreOptions & { apiKeyHash?: string | null }) {
    this.store = opts.store;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs;
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
    const record: RegionRecord = {
      regionId: input.regionId,
      chunkRange: input.chunkRange,
      endpoint: input.endpoint,
      capacity: input.capacity,
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
    };
    return lease;
  }

  async heartbeat(input: HeartbeatInput): Promise<HeartbeatAck> {
    const r = await this.store.getRegion(input.regionId);
    if (r === null) throw new WorldError(404, "unknown region");
    r.load = input.load;
    r.tickJitterMs = input.tickJitterMs;
    r.entityCount = input.entityCount;
    r.lastHeartbeat = Date.now();
    await this.store.upsertRegion(r);
    return {
      ok: true,
      registryVersion: await this.store.getRegistryVersion(),
      migrations: [], // slice B
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
}
