/**
 * ShardStateShipper — persistence P2: region write-through to the world
 * store (PERSISTENCE-LAYER-SPEC, tiers 1+2).
 *
 * Rides the server's existing 1 s save timer, after the local flush —
 * never the tick loop, never blocking it. Two streams:
 *
 * Tier 1 (ledger): flushed ItemLedger rows are read back by their own
 * `seq` (the item_events PRIMARY KEY — no parallel counter) and shipped
 * uphill in capped batches. The world acks a contiguous head seq; the
 * shipper tracks it and retries any unacked tail on the next cycle
 * (outbox semantics, mirroring dungeon-run reports: an event counts as
 * shipped only when the world confirms it). The world dedups on
 * (rangeKey, seq), so retries are idempotent.
 *
 * Tier 2 (snapshots): each 300-tick checkpoint is offered here and
 * uploaded at a per-range phase offset inside the checkpoint interval,
 * so a fleet's shards don't stampede the world on the same boundary.
 * A fresher checkpoint supersedes a pending older one — stale bytes
 * are never uploaded after newer ones. At upload time a real content
 * hash (sha256 of the serialized bytes — not the telemetry digest) is
 * compared against the last hash the world acked for this range; an
 * unchanged snapshot uploads nothing at all.
 *
 * A world outage or rejection never throws and never touches local
 * durability: acked state simply stays put and the next cycle retries.
 * Standalone mode has no shipper at all (the server only constructs
 * one when a WorldClient exists), so behaviour there is unchanged.
 */

import * as crypto from "node:crypto";
import type { LedgerEvent } from "@mmo-engine/world-server";
import type { ItemLedger, LedgerEventRow } from "../persist/item-ledger.js";

/**
 * Per-request ledger caps. The world schema (P1) rejects batches over
 * 1024 events or 1 MiB of JSON; these sit at half of both, and one
 * capped request ships per save cycle — the remainder continues on the
 * next cycle via the ack head, so a catch-up backlog drains gradually
 * instead of arriving as one giant request.
 */
export const LEDGER_BATCH_MAX_EVENTS = 512;
export const LEDGER_BATCH_MAX_BYTES = 512 * 1024;

/** The slice of WorldClient the shipper needs (tests substitute a fake). */
export interface StatePlaneClient {
  readonly rangeKey: string;
  appendLedgerEvents(
    events: readonly LedgerEvent[],
  ): Promise<number | null>;
  putShardSnapshot(snapshot: {
    tick: number;
    digest: string;
    payload: unknown;
  }): Promise<boolean>;
}

export interface ShardStateShipperOptions {
  client: StatePlaneClient;
  ledger: ItemLedger;
  /** Checkpoint cadence in ticks (the store's saveEveryTicks). */
  snapshotIntervalTicks: number;
  log?: (line: string) => void;
}

/** A checkpoint waiting for its phase-offset upload slot. */
interface PendingSnapshot {
  tick: number;
  /** The telemetry digest, carried to the world record verbatim. */
  digest: string;
  /** The exact bytes the local save persisted. */
  bytes: Uint8Array;
  /** sha256 of `bytes` — the skip comparison and payload provenance. */
  contentHash: string;
  /** First tick at which this snapshot may be uploaded. */
  dueTick: number;
}

function toLedgerEvent(row: LedgerEventRow): LedgerEvent {
  return {
    seq: row.seq,
    tick: row.tick,
    payload: {
      itemId: row.itemId,
      kind: row.kind,
      def: row.def,
      owner: row.owner,
      slot: row.slot,
      durability: row.durability,
      x: row.x,
      z: row.z,
      committedAt: row.committedAt,
    },
  };
}

export class ShardStateShipper {
  private readonly client: StatePlaneClient;
  private readonly ledger: ItemLedger;
  private readonly snapshotIntervalTicks: number;
  private readonly log: (line: string) => void;
  /** Deterministic in [0, snapshotIntervalTicks): hash of the rangeKey. */
  private readonly phaseOffsetTicks: number;

  /** Contiguous head seq the world has acked; the tail retries. */
  private ackedSeq = 0;
  /** An upload is running: further pumps coalesce (no pile-up). */
  private inFlight = false;
  private pendingSnapshot: PendingSnapshot | null = null;
  /** Content hash of the newest snapshot the world has acked. */
  private lastAckedSnapshotHash: string | null = null;

  constructor(opts: ShardStateShipperOptions) {
    this.client = opts.client;
    this.ledger = opts.ledger;
    this.snapshotIntervalTicks = Math.max(1, opts.snapshotIntervalTicks);
    this.log = opts.log ?? (() => {});
    const h = crypto.createHash("sha256").update(this.client.rangeKey).digest();
    this.phaseOffsetTicks = h.readUInt32BE(0) % this.snapshotIntervalTicks;
  }

  /** The world's contiguous acked ledger head for this range. */
  get worldAckedSeq(): number {
    return this.ackedSeq;
  }

  /** This range's deterministic snapshot-upload phase, in ticks. */
  get snapshotPhaseOffsetTicks(): number {
    return this.phaseOffsetTicks;
  }

  /** True while a capped upload (ledger or snapshot) is in flight. */
  get uploadInFlight(): boolean {
    return this.inFlight;
  }

  /**
   * Offer the checkpoint the local store just saved. It uploads at
   * `tick + phaseOffset` (the next pump at or past that tick), and an
   * offer with a newer tick supersedes a pending older one. An offer
   * that isn't newer than the pending (or last-acked) snapshot is a
   * re-offer and ignored.
   */
  offerSnapshot(tick: number, digest: string, bytes: Uint8Array): void {
    if (this.pendingSnapshot && tick <= this.pendingSnapshot.tick) return;
    this.pendingSnapshot = {
      tick,
      digest,
      bytes,
      contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
      dueTick: tick + this.phaseOffsetTicks,
    };
  }

  /**
   * One save-cycle pump: ship one capped ledger batch, then the
   * pending snapshot if its phase slot has arrived. Never throws.
   * Skipped entirely while a previous pump's upload is still running.
   */
  async pump(currentTick: number): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.shipLedgerBatch();
      await this.shipDueSnapshot(currentTick);
    } finally {
      this.inFlight = false;
    }
  }

  private async shipLedgerBatch(): Promise<void> {
    // The batch is read from the local ledger itself: rows with seq
    // past the acked head are the outbox. One row past the cap is read
    // so a full window is used even when the cap trims it.
    const rows = this.ledger.eventsAfter(
      this.ackedSeq,
      LEDGER_BATCH_MAX_EVENTS + 1,
    );
    if (rows.length === 0) return;
    const events: LedgerEvent[] = [];
    let bytes = 2; // the JSON array brackets
    for (const row of rows) {
      const ev = toLedgerEvent(row);
      bytes += JSON.stringify(ev).length + 1; // + the comma
      if (
        events.length > 0 &&
        (events.length >= LEDGER_BATCH_MAX_EVENTS ||
          bytes > LEDGER_BATCH_MAX_BYTES)
      ) {
        break;
      }
      events.push(ev);
    }
    const acked = await this.client.appendLedgerEvents(events);
    if (acked === null) return; // outage/rejection: tail retries next cycle
    if (acked > this.ackedSeq) {
      this.ackedSeq = acked;
      this.log(
        `world ledger acked seq ${acked} (${events.length} event(s) shipped)`,
      );
    }
  }

  private async shipDueSnapshot(currentTick: number): Promise<void> {
    const pending = this.pendingSnapshot;
    if (!pending || currentTick < pending.dueTick) return;
    if (pending.contentHash === this.lastAckedSnapshotHash) {
      // Unchanged world: the world already holds these exact bytes.
      this.pendingSnapshot = null;
      this.log(
        `world snapshot tick ${pending.tick} skipped (content unchanged)`,
      );
      return;
    }
    const stored = await this.client.putShardSnapshot({
      tick: pending.tick,
      digest: pending.digest,
      payload: {
        format: "flatbuffers-base64",
        contentHash: pending.contentHash,
        data: Buffer.from(pending.bytes).toString("base64"),
      },
    });
    if (!stored) return; // stays pending; retried until superseded
    this.lastAckedSnapshotHash = pending.contentHash;
    if (this.pendingSnapshot === pending) this.pendingSnapshot = null;
    this.log(`world snapshot tick ${pending.tick} uploaded`);
  }
}
