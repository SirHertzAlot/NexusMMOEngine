/**
 * ShardStateRecall — persistence P3: boot recall + takeover
 * (PERSISTENCE-LAYER-SPEC, Recovery, as amended by "Single source of
 * truth & resource-aware assignment").
 *
 * Fleet mode (a WorldClient exists, i.e. WORLD_URL was set): hot-loading
 * state FROM the world store is the NORMAL boot path, not a recovery
 * branch. The world DB is the single source of truth; the local
 * SnapshotStore + ItemLedger are a working cache. Recall therefore
 * SEEDS the local stores from the world copies before the ordinary
 * boot restore runs, and the existing local restore paths do the rest
 * unchanged:
 *
 *   - SnapshotStore.restoreInto(sim) loads the seeded snapshot bytes
 *     (the exact FlatBuffers bytes P2 uploaded, unwrapped from their
 *     {format: "flatbuffers-base64", contentHash, data} payload).
 *   - The items module restores items from ItemLedger.load(), which
 *     now collapses the imported world events — no parallel item
 *     restore implementation exists or is needed.
 *
 * Boot ordering (the invariant, and how registration interleaves):
 * P1 state-plane reads are unfenced but require an authenticated known
 * region, and the original spec's "recall, then register" order cannot
 * satisfy that — there is no token to read with before a grant. So
 * fleet boot registers FIRST: registration issues the shard's fresh
 * fencing epoch and bearer token, recall reads run under that lease,
 * the local stores are seeded, and only then does the existing boot
 * restore + simulation resume. The shipper (constructed after recall)
 * reads its epoch from the client's current lease on every write, so
 * every post-boot state-plane write carries the post-boot epoch.
 *
 * Divergence safety: the (epoch, tick) comparison against the local
 * store is NOT routine arbitration — in fleet mode the world copy wins
 * by definition, ties included. The one exception is a genuinely newer
 * local snapshot (local tick > world tick: the shard ran standalone or
 * through a world outage with unshipped checkpoints); that safety
 * valve keeps the local state. Whichever side loses a divergence is
 * surfaced through the log — never silently discarded.
 *
 * Ledger fetch: the world snapshot record carries no ledger seq, and
 * the snapshot bytes are ECS-only — items live solely in the ledger,
 * whose every row carries the item's whole state. The stream is
 * therefore fetched from seq 0 and imported idempotently by seq (see
 * ItemLedger.importEvents): ItemLedger.load()'s latest-per-item
 * collapse makes the events newer than the snapshot the effective
 * tail (a post-snapshot tombstone still removes a pre-snapshot item),
 * while pre-snapshot items — which no snapshot byte carries — are
 * restored exactly once through ItemStore.restore's per-id dedup.
 *
 * Takeover is this same path: the world reaper expires the dead
 * shard's lease, a replacement registers the same range (bumped
 * epoch), recalls, and continues. There is no separate takeover code.
 *
 * A failed recall never blocks the boot: a dead or corrupt world copy
 * degrades to the local cache, exactly like a dead world degrades
 * durability in P2. Standalone mode never calls this at all.
 */

import * as crypto from "node:crypto";
import type {
  ShardSnapshotRecord,
  StoredLedgerEvent,
} from "@mmo-engine/world-server";
import type { SnapshotStore } from "../persist/store.js";
import type {
  ItemLedger,
  LedgerEventRow,
  LedgerKindCode,
} from "../persist/item-ledger.js";
import { decodeSnapshot } from "../snapshot.js";
import { parseWireEntityId } from "../entity-id.js";

/** The slice of WorldClient recall needs (tests substitute a fake). */
export interface StateRecallClient {
  readonly rangeKey: string;
  /** The fresh fencing epoch from this boot's registration; null while unregistered. */
  readonly epoch: number | null;
  readonly registered: boolean;
  getShardSnapshot(): Promise<ShardSnapshotRecord | null>;
  getLedgerEvents(afterSeq: number): Promise<StoredLedgerEvent[]>;
}

export interface ShardStateRecallOptions {
  client: StateRecallClient;
  store: SnapshotStore;
  ledger: ItemLedger;
  log?: (line: string) => void;
  /** Write the world snapshot's `places` (PL3a: resource node stocks) into the local stores before they open. */
  seedPlaces?: (places: Record<string, unknown>) => void;
}

export interface ShardRecallOutcome {
  /** Which copy the boot will restore: the world's, the local cache's, or nothing (fresh range). */
  source: "world" | "local" | "fresh";
  /** Tick the boot resumes from (the winning snapshot's tick; null on a fresh range). */
  tick: number | null;
  worldTick: number | null;
  /** Epoch the world snapshot was written under; null when the world holds none. */
  worldEpoch: number | null;
  localTick: number | null;
  /** World ledger events seen / newly imported into the local ledger. */
  ledgerEventsSeen: number;
  ledgerEventsImported: number;
  /** True when the two copies disagreed and one was not applied. */
  diverged: boolean;
}

/**
 * Unwrap exactly the payload encoding P2's shipper uploads:
 * {format: "flatbuffers-base64", contentHash, data}. Returns the raw
 * snapshot bytes, or null when the payload is not that encoding (or
 * its content hash does not match the bytes — a corrupt copy must
 * never displace a good local one).
 */
export function unwrapShardSnapshotPayload(payload: unknown): Uint8Array | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p["format"] !== "flatbuffers-base64") return null;
  if (typeof p["data"] !== "string") return null;
  const bytes = new Uint8Array(Buffer.from(p["data"], "base64"));
  if (typeof p["contentHash"] === "string") {
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== p["contentHash"]) return null;
  }
  return bytes;
}

/**
 * Per-slot generations + live entity count for recalled bytes, derived
 * from the wire ids inside the snapshot itself (a live slot's wire id
 * carries its generation). SnapshotStore.saveSnapshotBytes needs the
 * table to seed the local store; freed slots are not represented in
 * the bytes and restart at generation 0 — restoreFromState only reads
 * the table for freed slots, and live-slot generations always come
 * from the wire ids, so the restored world is exact for live entities.
 */
function generationsFor(bytes: Uint8Array): {
  generations: Uint32Array;
  entityCount: number;
} {
  const state = decodeSnapshot(bytes);
  const gens = new Map<number, number>();
  let maxSlot = -1;
  const take = (wireId: bigint): void => {
    const { slot, generation } = parseWireEntityId(wireId);
    gens.set(slot, generation);
    if (slot > maxSlot) maxSlot = slot;
  };
  for (const block of [
    state.transforms,
    state.velocities,
    state.intents,
    state.chunks,
    state.healths,
    state.staminas,
    state.bodies,
    state.assets,
    state.locomotions,
    state.appearances,
    state.actions,
    state.characterRefs,
    state.animations,
    state.vfxEmitters,
  ]) {
    for (const row of block) take(row.wireId);
  }
  const generations = new Uint32Array(maxSlot + 1);
  for (const [slot, gen] of gens) generations[slot] = gen;
  return { generations, entityCount: gens.size };
}

/**
 * A stored world ledger event back into a local ledger row. The P2
 * shipper's payload is {itemId, kind, def, owner, slot, durability, x,
 * z, committedAt}; anything else is not an event this ledger wrote and
 * is skipped (null), never guessed at.
 */
function rowFromStoredEvent(e: StoredLedgerEvent): LedgerEventRow | null {
  if (e.payload === null || typeof e.payload !== "object") return null;
  const p = e.payload as Record<string, unknown>;
  const num = (k: string): number =>
    typeof p[k] === "number" ? (p[k] as number) : NaN;
  const itemId = num("itemId");
  const kind = num("kind");
  const def = num("def");
  const owner = num("owner");
  const slot = num("slot");
  const durability = num("durability");
  const x = num("x");
  const z = num("z");
  const committedAt = num("committedAt");
  if (
    [itemId, kind, def, owner, slot, durability, x, z, committedAt].some(
      (v) => !Number.isFinite(v),
    )
  ) {
    return null;
  }
  return {
    seq: e.seq,
    itemId,
    tick: e.tick,
    committedAt,
    kind: kind as LedgerKindCode,
    def,
    owner,
    slot,
    durability,
    x,
    z,
  };
}

/**
 * Recall this range's state from the world store into the local
 * stores. Call after registration, before any restore/simulation of
 * the range. Never throws.
 */
export async function recallShardState(
  opts: ShardStateRecallOptions,
): Promise<ShardRecallOutcome> {
  const { client, store, ledger } = opts;
  const log = opts.log ?? (() => {});
  const rangeKey = client.rangeKey;
  const local = store.loadLatest();
  const localTick = local?.tick ?? null;
  const base: ShardRecallOutcome = {
    source: local ? "local" : "fresh",
    tick: localTick,
    worldTick: null,
    worldEpoch: null,
    localTick,
    ledgerEventsSeen: 0,
    ledgerEventsImported: 0,
    diverged: false,
  };

  if (!client.registered) {
    // Registration failed (world down at boot): the local cache is
    // all there is — the same degradation as a standalone boot.
    log(
      `persistence recall: not registered with the world; booting from local state for range ${rangeKey}`,
    );
    return base;
  }

  let snapshot: ShardSnapshotRecord | null;
  try {
    snapshot = await client.getShardSnapshot();
  } catch (err) {
    log(
      `persistence recall: world snapshot fetch failed for range ${rangeKey} (${(err as Error).message}); booting from local state`,
    );
    return base;
  }

  if (snapshot !== null) {
    base.worldTick = snapshot.tick;
    base.worldEpoch = snapshot.epoch;

    if (localTick !== null && localTick > snapshot.tick) {
      // Divergence safety valve — the ONLY case the local copy wins
      // in fleet mode: it is genuinely newer than anything the world
      // holds (standalone running or unshipped flushes from a world
      // outage). The losing world copy is surfaced, not applied.
      log(
        `persistence recall: DIVERGENCE for range ${rangeKey}: local snapshot tick ${localTick} is newer than the world snapshot (epoch ${snapshot.epoch}, tick ${snapshot.tick}); keeping local state — world copy NOT applied`,
      );
      return { ...base, diverged: true };
    }

    const bytes = unwrapShardSnapshotPayload(snapshot.payload);
    if (bytes === null) {
      log(
        `persistence recall: world snapshot for range ${rangeKey} (epoch ${snapshot.epoch}, tick ${snapshot.tick}) has an unusable payload; booting from local state`,
      );
      return base;
    }
    let derived: { generations: Uint32Array; entityCount: number };
    try {
      derived = generationsFor(bytes);
    } catch (err) {
      log(
        `persistence recall: world snapshot for range ${rangeKey} (epoch ${snapshot.epoch}, tick ${snapshot.tick}) does not decode (${(err as Error).message}); booting from local state`,
      );
      return base;
    }
    // Snapshot first: seed the local store so the ordinary boot
    // restore (SnapshotStore.restoreInto) loads the world copy
    // through the existing path.
    store.saveSnapshotBytes(
      snapshot.tick,
      bytes,
      derived.generations,
      derived.entityCount,
    );
    // The range's places ride the same record (PL3a): the world's copy replaces the local one.
    const places = (snapshot.payload as Record<string, unknown>)["places"];
    if (opts.seedPlaces && places !== null && typeof places === "object" && !Array.isArray(places)) {
      opts.seedPlaces(places as Record<string, unknown>);
      log(`persistence recall: seeded places (${Object.keys(places).join(", ")}) from the world snapshot for range ${rangeKey}`);
    }
    if (localTick !== null && localTick !== snapshot.tick) {
      log(
        `persistence recall: DIVERGENCE for range ${rangeKey}: local snapshot tick ${localTick} superseded by the world snapshot (epoch ${snapshot.epoch}, tick ${snapshot.tick}) — the world is the single source of truth in fleet mode; local copy NOT restored`,
      );
      base.diverged = true;
    } else {
      log(
        `persistence recall: hot-loaded world snapshot (epoch ${snapshot.epoch}, tick ${snapshot.tick}) for range ${rangeKey}`,
      );
    }
    base.source = "world";
    base.tick = snapshot.tick;
  }

  // Ledger second: fetch the range's stream and import it into the
  // local ledger; the items module's existing load()-based restore is
  // the replay. Imported even with no world snapshot (ledger events
  // can precede the first checkpoint), except in the local-newer
  // divergence above, where the world stream is the stale copy.
  let events: StoredLedgerEvent[];
  try {
    events = await client.getLedgerEvents(0);
  } catch (err) {
    log(
      `persistence recall: world ledger fetch failed for range ${rangeKey} (${(err as Error).message}); items restore from the local ledger only`,
    );
    return base;
  }
  base.ledgerEventsSeen = events.length;
  const rows: LedgerEventRow[] = [];
  for (const e of events) {
    const row = rowFromStoredEvent(e);
    if (row) rows.push(row);
  }
  base.ledgerEventsImported = ledger.importEvents(rows);
  if (events.length > 0) {
    log(
      `persistence recall: imported ${base.ledgerEventsImported} new ledger event(s) (${events.length} in the world stream) for range ${rangeKey}`,
    );
    if (snapshot === null) base.source = "world";
  } else if (snapshot === null) {
    log(
      `persistence recall: world holds no state for range ${rangeKey} (fresh range)`,
    );
  }
  return base;
}
