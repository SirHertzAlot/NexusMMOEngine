# Persistence Layer Spec — durable shard state at the world tier

Status: **adopted by Joey 2026-10-20; building on `arlo/persistence-layer`.**
Supersedes the storage assumptions of `docs/WORLD-SERVER-SPEC.md` §3
("Local SQLite: snapshots, chunk overrides" as the region's only durability).
The world-server control plane (registry, leases, migration, presence)
is unchanged; this spec adds the **state plane** beside it.

## Why

Case-study findings (2026-10-20 research, EVE Online / FFXIV / Star Citizen /
Diablo II: Resurrected postmortem / SpacetimeDB / Orleans):

- Production MMOs keep authoritative state in a **central durable layer**
  written continuously or near-continuously; server processes are
  **replaceable compute**. Local-file persistence is the survival-game
  pattern and carries its failure mode: host loss = total range loss.
- High-value events are protected either by making them **database
  transactions when they happen** (EVE) or by shrinking the universal
  save interval until loss is seconds (FFXIV, 15 s).
- Tiered persistence fails when a stale working copy can overwrite
  newer global state (D2R outages). Version/fencing discipline is not
  optional.

Our position before this build: a region checkpoints world state every
300 ticks (10 s at 30 Hz) into **local** SQLite (WAL), flushes its item
ledger and character saves on the same timer cycle, and reports only a
telemetry digest `{tick, entityCount, digest}` to the world server. A
process crash costs ≤ ~10 s; a **host loss costs the entire range** and
no replacement process can recall the state.

## Terminology

- **World** — the grouping and its durable services (this spec's state
  plane included). A world may correspond to a continent or a whole
  planet, per game design; operationally it owns a set of shards.
- **Shard** — a simulation process owning one chunk range (today's code
  calls this a "region"). Shards are replaceable; state is not theirs.
- Code identifiers keep the existing `region` names in this build. The
  region→shard rename is a separate sweep and is NOT smuggled into
  these slices. New persistence concepts are keyed by **rangeKey**
  (derived from the chunk range), never by regionId alone, so state
  survives the replacement of the process that wrote it.

## Durability tiers

- **Tier 1 — transactions (item ledger).** The engine's ItemLedger is
  already an append-only event log whose latest row restores an item.
  Every flushed batch is also streamed to the world store. The world
  acknowledges a contiguous head sequence; unacknowledged batches retry
  on the save cycle (outbox semantics, mirroring dungeon-run reports:
  rows stay unreported until the world confirms ingestion).
- **Tier 2 — checkpoints (world snapshots).** The existing 300-tick
  snapshot is additionally uploaded to the world store, keyed by
  rangeKey with `{tick, epoch, digest}`. This bounds full-state loss to
  one checkpoint interval even if the Tier 1 stream gaps.
- **Tier 3 — ambient.** Anything in neither the ledger nor the snapshot
  (transient entity churn) is lossy **by design** and documented as such.

## Fencing

Every ownership grant of a range carries a monotonically increasing
**epoch** (issued by the world core at registration/lease grant). All
state-plane writes carry the writer's epoch; the world store **rejects
writes from a stale epoch**. A zombie shard that wakes after being
replaced cannot clobber its replacement's state. (D2R rule: never
overwrite newer state with older state, enforced mechanically.)

## Recovery (recall)

A shard booting with `WORLD_URL` set:

1. Asks the world store for the range's latest snapshot + ledger tail
   after the snapshot's tick.
2. Compares `(epoch, tick)` against its local store.
3. Restores from whichever is newer — snapshot first, then ledger replay
   via the existing item-restore path — and only then registers for a
   fresh epoch and resumes.
4. With no world copy (fresh range), today's behaviour is unchanged.

Takeover is the same path: the reaper expires the dead shard's lease, a
replacement registers the same range, recalls, and continues. State
loss window after takeover = Tier 1 lag (≈ one flush cycle) for items,
one checkpoint interval for the rest of the snapshot state.

## Characters at the world tier (slice P4)

Characters belong to the world, not the shard (Star Citizen's global
inventory pattern; D2R's lock discipline):

- World store holds the character record (opaque serialized state,
  versioned) and a **session lock** `{characterId, regionId, epoch,
  expiresAt}`.
- Login acquires the lock (refused while held by a live lease; stealable
  only after expiry, with an epoch bump).
- The shard keeps the local record as a working cache, saves uphill on
  the existing cadence, and performs a **final commit + lock release**
  on logout and on migration commit.
- Standalone mode (no `WORLD_URL`) keeps today's local-only behaviour.

## Invariants (every slice)

- **The tick never waits on the world.** All state-plane traffic rides
  the existing save timer / async paths. A slow or dead world server
  degrades durability, never simulation. (Existing spec rule, restated
  because it now carries more weight.)
- **Standalone mode is byte-identical.** No `WORLD_URL`, no behaviour
  change.
- **Idempotency.** Every new mutating core op takes an `opId` and uses
  the existing `getOpResult`/`storeOpResult` dedup.
- **Edge validation.** New adapter inputs are Zod-stric
...[truncated 2221 chars]
## Single source of truth & resource-aware assignment

(Amendment, Joey-directed 2026-10-20. This section refines the framing
of the Recovery section above for fleet mode; the mechanics it builds on
— tiers, fencing, recall, locks — are unchanged.)

### Single source of truth

The world DB (SurrealDB, behind the world server) is the **single
source of truth** for shard state. Consequences:

- When `WORLD_URL` is set, hot-loading state FROM the world DB is the
  **normal boot path**, not a crash-recovery branch. A shard boots by
  recalling its range's snapshot + ledger tail from the world store
  (slice P3), then simulates. Local disk is a **working cache** (and
  the Tier 1 outbox source), never a competing authority.
- P3's `(epoch, tick)` newer-wins comparison against the local store
  remains only as a **divergence safety** — e.g. a shard that ran
  standalone or through a long world outage — not the fleet-mode
  default. In fleet mode the world copy wins by definition; the
  comparison exists to catch and surface divergence, not to arbitrate
  routine boots.
- Standalone mode (no `WORLD_URL`) is unchanged: local disk is the
  only store and the only authority, byte-identical to today.

### Resource-aware chunk assignment (slice P5, after P4)

Fixed `REGION_CHUNK_RANGE` assignment wastes heterogeneous hosts: a
big host idles, a small host drowns. Instead, chunk ranges are
**assigned by the world core, sized by reported host resources**.

- **Host resource sidecar.** A small separate process per host (never
  in the tick loop, never simulates) reports host capacity and live
  load — CPU cores, RAM total/free, co-located shard load when
  available — to the world server on an interval. Reports land in a
  new WorldStore section + core op keyed by `hostId`, TTL'd like
  heartbeats and reaped when stale.
- **Assignment.** The world core computes chunk-range assignments for
  requesting shards from reported resources, the total world chunk
  space, and live leases. A range held by a live lease is never
  stolen. The sizing algorithm is simple and deterministic, sits
  behind a narrow policy interface (swappable without touching the
  core op or the store), and its policy inputs/outputs are exactly:
  host reports + world chunk space + live leases → range per shard.
- **Delivery.** Assignment rides the existing lease/registration path:
  the shard receives its range together with its epoch grant (P1
  fencing applies from the first write).
- **Fleet boot flow.** A shard starts unassigned → registers its
  host's capability (via the sidecar's reports) → receives an
  assignment → hot-loads that range's state via P3 recall → only then
  simulates.
- `REGION_CHUNK_RANGE` remains the standalone/dev override. With no
  `WORLD_URL`, nothing in this section engages and behaviour is
  byte-identical.

P5 acceptance: sidecar report ingestion + staleness reaping;
assignment sizing (a bigger host receives a bigger range); no
double-assignment of a live range; an unassigned shard receives its
range and recalls its state before simulating.
