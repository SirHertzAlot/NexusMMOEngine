# Atomic Operations Spec — value-moving exchanges as world-tier DB functions

Status: **adopted by Joey 2026-10-20; building on `arlo/atomic-operations`**
(stacked on `arlo/persistence-layer` — merges after it).
Companion to `docs/PERSISTENCE-LAYER-SPEC.md`, whose state plane this
spec builds on (character records, session locks, item ledger, epoch
fencing all live there).

## Why

Atomicity matters most when one operation moves value between two
owners, or touches several pieces of state that are only correct
together. A crash — or a player force-quitting at the wrong moment —
in the middle of such an operation creates or destroys value:

- **Trades:** an item must leave A and enter B in one indivisible step.
- **Vendor / auction settlement:** gold debit, item credit, and the
  seller's payout are one fact, not three.
- **Crafting:** consume inputs and produce outputs together.
- **High-value loot grants:** kill credit, the drop's existence, and
  its ownership are one event.
- **Inventory swaps / stack merges:** an item must never be in two
  slots — or no slot — for even one persisted frame.

The invariant underneath all of them is **value conservation**: items
and gold are neither created nor destroyed except by explicit game
rules. Region-local execution cannot uphold it across owners, and
cannot uphold it at all across shards. The world tier can: it holds
the canonical character records and the item ledger, so an exchange
executed there is **one database transaction — atomic and durable in
the same step.**

## The governing invariant

**One operation = one WorldStore call = one DB transaction.**

Each operation below is a single method on the WorldStore interface.
The SurrealDB implementation executes it as a database function
(`DEFINE FUNCTION`) inside one transaction. The in-memory (fake)
implementation executes the same semantics in one critical section.
The world core NEVER assembles an operation from a sequence of store
calls — a crash between calls is exactly the failure this spec exists
to prevent. An operation that cannot fit in one transaction does not
belong in this set.

## Consistency model

- The world record is the commit point. A shard initiates an operation
  via the world core (webrpc, Zod-strict, opId-idempotent like every
  mutating core op) and applies the **settled outcome** returned in the
  response to its live session state. The world's version is truth; a
  shard's cache reconciles to it, never the reverse.
- **Fencing:** every operation carries the caller's lock epoch for each
  participating character (P4 session locks) and the expected record
  version. A stale epoch or version mismatch is a typed rejection —
  the operation does not partially apply, ever.
- **Cross-shard is the normal case, not a special case:** participants
  may be in session on different shards; neither shard's local state
  is consulted by the function, only the world records.
- **System counterparties** (vendor, auction house, loot source) are
  world-tier records/identities, so one side of an exchange being the
  game itself changes nothing about the transaction shape.

## The operation set (slice A1)

All operations: `opId` idempotency via the existing dedup; typed
rejections (`INSUFFICIENT_FUNDS`, `ITEM_NOT_PRESENT`, `VERSION_CONFLICT`,
`LOCK_CONFLICT`, `EPOCH_STALE`); on success they append the resulting
item movements to the world item ledger within the same transaction,
so the audit trail and the state change commit or fail together.

1. **`tradeCommit`** — two characters exchange declared item sets and
   gold amounts, both directions, all-or-nothing.
2. **`vendorTransact`** — one character and a vendor: buy (gold →
   item) or sell (item → gold) as a single step.
3. **`auctionSettle`** — buyer pays the price, seller receives the
   price, the item moves buyer-ward: three records, one transaction.
4. **`craftExecute`** — one character: consume the recipe's input
   items (and optional gold fee), produce the output items.
5. **`lootGrant`** — system → character: create the item instance and
   assign ownership atomically (the boss-drop path; also the general
   grant verb's fleet-mode form).
6. **`inventoryMutate`** — one character: move / stack-merge / equip
   -swap within the character's own inventory as one version-checked
   mutation.

## Region integration (slice A2)

- `WorldClient` gains the six operations. In fleet mode (`WORLD_URL`
  set), the economy module's trade/vendor/auction commit paths, the
  crafting service's execution step, and the item service's grant path
  route their **commit step** through the world operation and apply
  the settled outcome; negotiation, validation UX, and rate limits
  stay region-side where they already live.
- Standalone mode (no `WORLD_URL`) executes locally exactly as today —
  byte-identical behaviour.
- A rejected operation surfaces to the region as a typed refusal (the
  existing refusal-semantics pattern); a world outage during the
  commit step fails the operation closed (no local fallback commit —
  a trade that "probably happened" is worse than one that visibly
  didn't).
- **Migration is already atomic** (begin/commit/abort + epoch fencing
  in the world core) and is NOT rebuilt; A2 adds an exactly-one-owner
  race test if coverage is missing.

## Invariants (both slices)

- The tick never waits on the world: these operations are initiated
  from gateway/module paths, never from the sim tick.
- One op = one store call (above) — reviewed at the diff, not assumed.
- Tests per slice, failure sets diffed against the slice's baseline;
  Surreal implementations covered by the same contract tests that
  auto-run when `WORLD_TEST_DB_URL` is set (the P1 pattern).
- No changes to the client wire protocol; no identifier renames.
