/**
 * The region's half of the border hand-off (WORLD-SERVER-SPEC §6, slice B).
 *
 * Source side: `observe` sees an entity standing in a chunk another live
 * region owns, serializes it and begins a migration with the world, then
 * asks the host to send the entity's client to that region. The source
 * keeps simulating the entity (it keeps authority) until a heartbeat ack
 * says the migration committed; then it drops it. An aborted or expired
 * migration leaves the entity where it was. An entity that walks back
 * before the commit has its migration aborted.
 *
 * Target side: `accept` (the client arrived, or the source died) reads the
 * entity state from the world, instantiates it, and commits. A commit the
 * world refuses (the migration expired first) drops the copy again, so
 * authority is never duplicated.
 *
 * Nothing here runs in the tick: call `observe` and feed acks from timers.
 * The host owns the ECS side (serialize, instantiate, drop, redirect).
 */
import type { ChunkRange, HeartbeatAck, MigrationOutcome, MigrationRecord, RegionInfo } from "@mmo-engine/world-server";
import { WorldTransportError } from "./client.js";

/** What the coordinator needs from the world (WorldClient provides it). */
export interface MigrationWorldApi {
  readonly regionId: string;
  listRegions(): Promise<RegionInfo[]>;
  beginMigration(entityId: string, toRegion: string, entityState: Record<string, unknown> | null): Promise<string>;
  commitMigration(migrationId: string): Promise<void>;
  abortMigration(migrationId: string, reason: string): Promise<void>;
  getMigration(migrationId: string): Promise<MigrationRecord>;
}

/** The ECS side of a hand-off, supplied by the region. */
export interface MigrationHost {
  /** The entity's state to hand over (JSON-safe), or null if it is gone. */
  serialize(entityId: string): Record<string, unknown> | null;
  /** Spawn the entity from a handed-over state (target side). */
  instantiate(entityId: string, state: Record<string, unknown> | null, migrationId: string): void;
  /** Remove the entity: another region has authority now. */
  drop(entityId: string): void;
  /** Whether this region currently simulates the entity. */
  has(entityId: string): boolean;
  /** Tell the entity's client to reconnect to `endpoint` with `migrationId`. */
  redirect?(entityId: string, endpoint: string, migrationId: string): void;
}

export interface MigrationCoordinatorOptions {
  world: MigrationWorldApi;
  host: MigrationHost;
  chunkRange: ChunkRange;
  /** World units per chunk side. */
  chunkSize: number;
  /** After a failed or refused hand-off, wait this long before trying the entity again (default 5000). */
  retryAfterMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** A position the coordinator checks, in world units. */
export interface EntityPosition { entityId: string; x: number; z: number; }

export type MigrationEvent =
  | { kind: "begun"; entityId: string; migrationId: string; toRegion: string }
  | { kind: "walked_back"; entityId: string; migrationId: string }
  | { kind: "handed_off"; entityId: string; migrationId: string }
  | { kind: "kept"; entityId: string; migrationId: string; state: "aborted" | "expired" }
  | { kind: "accepted"; entityId: string; migrationId: string; backstop: boolean }
  | { kind: "refused"; entityId: string; migrationId: string; reason: string };

function inRange(r: ChunkRange, cx: number, cz: number): boolean {
  return cx >= r.x0 && cx < r.x1 && cz >= r.z0 && cz < r.z1;
}

export class MigrationCoordinator {
  private readonly opts: MigrationCoordinatorOptions;
  private readonly now: () => number;
  private regions: RegionInfo[] = [];
  private registryVersion = -1;
  /** entityId -> its open outgoing migration. */
  private readonly outgoing = new Map<string, { migrationId: string; toRegion: string }>();
  /** Entities with a begin call in flight. */
  private readonly beginning = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  /** Incoming migrations taken; `committed` once the world confirmed it. */
  private readonly accepted = new Map<string, { entityId: string; committed: boolean }>();
  private readonly listeners: Array<(e: MigrationEvent) => void> = [];

  constructor(opts: MigrationCoordinatorOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  onEvent(cb: (e: MigrationEvent) => void): void { this.listeners.push(cb); }

  /** Open outgoing migrations, for stats and tests. */
  get pendingOutgoing(): ReadonlyMap<string, { migrationId: string; toRegion: string }> { return this.outgoing; }

  async refreshRegistry(): Promise<void> {
    this.regions = await this.opts.world.listRegions();
  }

  /** The live region (other than this one) that owns world position (x, z). */
  regionAt(x: number, z: number): RegionInfo | null {
    const cx = Math.floor(x / this.opts.chunkSize);
    const cz = Math.floor(z / this.opts.chunkSize);
    if (inRange(this.opts.chunkRange, cx, cz)) return null;
    for (const r of this.regions) {
      if (r.live && r.regionId !== this.opts.world.regionId && inRange(r.chunkRange, cx, cz)) return r;
    }
    return null;
  }

  /**
   * Check entity positions: begin a hand-off for each entity standing in
   * another live region's chunks, abort the open hand-off of each entity
   * back inside this region. Entities in chunks nobody owns stay here.
   */
  async observe(positions: Iterable<EntityPosition>): Promise<void> {
    const work: Promise<void>[] = [];
    for (const p of positions) {
      const open = this.outgoing.get(p.entityId);
      const cx = Math.floor(p.x / this.opts.chunkSize);
      const cz = Math.floor(p.z / this.opts.chunkSize);
      if (inRange(this.opts.chunkRange, cx, cz)) {
        if (open) work.push(this.walkBack(p.entityId, open.migrationId));
        continue;
      }
      if (open || this.beginning.has(p.entityId)) continue;
      if ((this.retryAt.get(p.entityId) ?? 0) > this.now()) continue;
      const target = this.regionAt(p.x, p.z);
      if (target) work.push(this.begin(p.entityId, target));
    }
    await Promise.all(work);
  }

  private async begin(entityId: string, target: RegionInfo): Promise<void> {
    const state = this.opts.host.serialize(entityId);
    if (state === null && !this.opts.host.has(entityId)) return;
    this.beginning.add(entityId);
    try {
      const migrationId = await this.opts.world.beginMigration(entityId, target.regionId, state);
      this.outgoing.set(entityId, { migrationId, toRegion: target.regionId });
      this.emit({ kind: "begun", entityId, migrationId, toRegion: target.regionId });
      this.opts.host.redirect?.(entityId, target.endpoint, migrationId);
    } catch (err) {
      // Target not live, entity already migrating, world unreachable:
      // the entity stays here; try again later.
      this.retryAt.set(entityId, this.now() + (this.opts.retryAfterMs ?? 5000));
      this.log(`[migration] begin ${entityId} -> ${target.regionId} failed: ${(err as Error).message}`);
    } finally {
      this.beginning.delete(entityId);
    }
  }

  private async walkBack(entityId: string, migrationId: string): Promise<void> {
    try {
      await this.opts.world.abortMigration(migrationId, "entity walked back");
      this.outgoing.delete(entityId);
      this.emit({ kind: "walked_back", entityId, migrationId });
    } catch (err) {
      // 409: the target committed first. The ack will hand the entity off.
      this.log(`[migration] abort ${migrationId} failed: ${(err as Error).message}`);
    }
  }

  /** Act on a heartbeat ack: registry changes and migration outcomes. */
  async onAck(ack: HeartbeatAck): Promise<void> {
    if (ack.registryVersion !== this.registryVersion) {
      await this.refreshRegistry();
      this.registryVersion = ack.registryVersion;
    }
    const me = this.opts.world.regionId;
    const work: Promise<unknown>[] = [];
    for (const o of ack.migrations as MigrationOutcome[]) {
      if (o.fromRegion === me) this.outcomeAsSource(o);
      else if (o.toRegion === me) {
        const mine = this.accepted.get(o.migrationId);
        if (o.state === "begun" && mine) work.push(this.commit(o.migrationId, mine.entityId, false)); // an unconfirmed commit: retry
        else if (o.state === "begun" && !this.sourceLive(o.fromRegion)) work.push(this.accept(o.migrationId, true));
        else if (o.state === "committed" && mine) mine.committed = true;
        else if ((o.state === "aborted" || o.state === "expired") && mine) {
          // We took it but the world says it never became ours.
          this.dropIncoming(o.migrationId, o.entityId, o.state);
        }
      }
    }
    await Promise.all(work);
  }

  private outcomeAsSource(o: MigrationOutcome): void {
    const open = this.outgoing.get(o.entityId);
    if (!open || open.migrationId !== o.migrationId) return;
    if (o.state === "committed") {
      this.outgoing.delete(o.entityId);
      this.opts.host.drop(o.entityId);
      this.emit({ kind: "handed_off", entityId: o.entityId, migrationId: o.migrationId });
    } else if (o.state === "aborted" || o.state === "expired") {
      this.outgoing.delete(o.entityId);
      this.retryAt.set(o.entityId, this.now() + (this.opts.retryAfterMs ?? 5000));
      this.emit({ kind: "kept", entityId: o.entityId, migrationId: o.migrationId, state: o.state });
    }
  }

  private sourceLive(regionId: string): boolean {
    return this.regions.some((r) => r.regionId === regionId && r.live);
  }

  /**
   * Target side: take the entity. Called when its client arrives with the
   * migration id, or from an ack when the source has died. Returns whether
   * this region now has authority. `verify` sees the record before
   * anything is instantiated (the client's hand-off ticket, say); a record
   * it rejects is refused and left to expire.
   */
  async accept(migrationId: string, backstop = false, verify?: (m: MigrationRecord) => boolean): Promise<boolean> {
    const taken = this.accepted.get(migrationId);
    if (taken) return taken.committed || this.commit(migrationId, taken.entityId, backstop);
    let m: MigrationRecord;
    try {
      m = await this.opts.world.getMigration(migrationId);
    } catch (err) {
      this.log(`[migration] read ${migrationId} failed: ${(err as Error).message}`);
      return false;
    }
    if (m.toRegion !== this.opts.world.regionId) return false;
    if (m.state === "committed") return this.opts.host.has(m.entityId);
    if (m.state !== "begun") {
      this.emit({ kind: "refused", entityId: m.entityId, migrationId, reason: m.state });
      return false;
    }
    if (verify && !verify(m)) {
      this.emit({ kind: "refused", entityId: m.entityId, migrationId, reason: "not verified" });
      return false;
    }
    this.accepted.set(migrationId, { entityId: m.entityId, committed: false });
    if (!this.opts.host.has(m.entityId)) this.opts.host.instantiate(m.entityId, m.entityState as Record<string, unknown> | null, migrationId);
    return this.commit(migrationId, m.entityId, backstop);
  }

  private async commit(migrationId: string, entityId: string, backstop: boolean): Promise<boolean> {
    const taken = this.accepted.get(migrationId);
    if (!taken) return false;
    try {
      await this.opts.world.commitMigration(migrationId);
    } catch (err) {
      const code = err instanceof WorldTransportError ? err.code : 0;
      if (code === 409 || code === 404) {
        // Expired or aborted before we committed: the source still has it.
        this.dropIncoming(migrationId, entityId, (err as Error).message);
        return false;
      }
      // Unknown outcome (world unreachable): keep the copy; the next ack
      // retries the commit (still begun), confirms it, or drops the copy.
      this.log(`[migration] commit ${migrationId} unconfirmed: ${(err as Error).message}`);
      return false;
    }
    if (!taken.committed) {
      taken.committed = true;
      this.emit({ kind: "accepted", entityId, migrationId, backstop });
    }
    return true;
  }

  private dropIncoming(migrationId: string, entityId: string, reason: string): void {
    this.accepted.delete(migrationId);
    if (this.opts.host.has(entityId)) this.opts.host.drop(entityId);
    this.emit({ kind: "refused", entityId, migrationId, reason });
  }

  private emit(e: MigrationEvent): void { for (const l of this.listeners) l(e); }
  private log(line: string): void { (this.opts.log ?? ((l: string) => console.warn(l)))(line); }
}
