# Quest Compute Contract — DB-Owned Functions vs Server Read-Only

**Status:** Contract (design only). This document authorizes no code changes, no migration, and no new infrastructure. It records a decision and draws the ownership boundary quest compute must follow as it grows.
**Date:** 2026-10-25
**Scope:** Quest-compute ownership only — which layer owns each quest computation. This is not a persistence redesign and takes on no sibling subject.

## The decision this contract records

Joey, 2026-10-14:

> "The DB itself will perform a lot of the heavy computations that large-scale quests would need to be fun and playable across servers."

And its corollary, settled the same day: the read-only SQL constraint applies to **game servers only**. The DB layer itself **may** own mutating SQL functions for heavy cross-server computation. Game servers never gain write logic against the DB layer; heavy, shared, contention-critical quest compute moves *down* into the DB tier, not *out* into the regions.

## The layers, as built

The engine today has three distinct places quest-relevant compute can live. The contract uses exactly these names:

| Layer | What it is in the code today | Write power |
|---|---|---|
| **Region-local compute** | The region server process: `QuestService` and friends in `packages/engine-core`. Region-local stores (SQLite) sit under it. | Owns its local stores; holds **no** SQL write access to either DB layer below. |
| **Region DB-function layer** (EA17, SQLite edition) | Named SQL files under `content/db/`, loaded by `packages/engine-core/src/persist/db-functions.ts`. Functions are single parameterized SELECTs; caches are snapshot tables (`_cache_<name>`) refreshed in one transaction. | **Read-only by construction** — the loader refuses anything that is not a single read-only statement: "a function can never mutate the database." |
| **World DB layer** (SurrealDB) | The world tier: `WorldCoreImpl` + `WorldStore` in `packages/world-server`, backed by SurrealDB. Mutation reaches it only as typed WorldStore operations; on Surreal they persist through stored functions `fn::<op>` defined in `packages/world-server/src/surreal-store.ts`. | Mutates **only** through the six atomic operations and the typed world-core APIs. No raw SQL from game servers, ever. |

One distinction the whole contract depends on: a region writing its **own local store** (its quest log SQLite file, its wallet) is region-local persistence, not DB-layer write logic. The read-only rule governs the two DB layers — the region DB-function files and the world DB. Section 5 records where the as-built code stands against that reading.

## 1. Ownership map — quest-compute operations

Status key: **EXISTS** = present in the engine today at the named path. **PROPOSED** = the contract assigns it here; nothing in the repo implements it yet. **EXISTS (region form)** = works today region-locally; the DB-tier form named beside it is the contract's assignment for the cross-server case and is **PROPOSED** wiring.

| # | Operation | Owning layer | As built / contract assignment |
|---|---|---|---|
| 1 | Quest definition & availability lookup (may this character take / hand in this quest?) | Region-local compute | **EXISTS** — `packages/engine-core/src/quests/quest-service.ts` + `quest-def.ts` over authored content in `content/quests/` (`quests.json`, `steps.json`, `dialogs.json`, `npcs.json`). |
| 2 | Daily board-quest generation (one generated quest per NPC per character per day) | Region-local compute | **EXISTS** — `packages/engine-core/src/quests/generate.ts`; deterministic from seed (npc, character, day), built from creatures near the NPC. Deterministic generation needs no DB round-trip and stays local. |
| 3 | Accept / abandon a quest (quest-log mutation) | Region-local compute → region-local store | **EXISTS** — `QuestLog` (`packages/engine-core/src/quests/quest-log.ts`) writes through on every change to the `QuestStore`; the SQLite implementation is `SqliteQuestStore` (`packages/engine-core/src/quests/quest-store.ts`, own `quests.db`, WAL). |
| 4 | Objective progress counting (kills of a kind, talks, standing in a place, items held) | Region-local compute | **EXISTS** — `QuestService` counts kills from `DeathSystem` events and re-checks places/bags every `checkEveryTicks` (default 15); item counts come from `ItemService.countBase` via the `countInBag` wiring in `packages/engine-core/src/server.ts`. |
| 5 | Completion validation & hand-in (all steps done → "ready" → giver completes) | Region-local compute | **EXISTS** — step/state machine in `quest-log.ts` (`active` → `ready` → `done`); the dialog `complete` action in `quest-service.ts` performs hand-in. Validation is over one character's log — local data, local verdict. |
| 6 | Reward grant — items | Region-local service call (single-region form) | **EXISTS (region form)** — the service's `grant` callback resolves to `ItemService.grantItem` (wiring in `server.ts`). Cross-server form: the same grant as a world-tier atomic op — `fn::loot_grant` / `fn::inventory_mutate` **EXIST** as functions (row 7), but quests do not call them today; that wiring is **PROPOSED**. |
| 7 | Reward grant — gold | DB layer, mutating function (cross-server form) | **EXISTS (region form)** — today the `grantGold` callback lands on the region wallet (`walletHolder.grant`, `server.ts`). The DB-owned form **EXISTS as a function**: `fn::loot_grant`, one of the six atomic ops defined in `packages/world-server/src/surreal-store.ts` (shared transition logic: `packages/world-server/src/atomic.ts`). Quest completion does not route through it today — routing cross-server quest gold through `lootGrant` is **PROPOSED**. Single-region gold may stay on the region wallet; the moment a reward must be correct *across* servers, it belongs to the DB form (rule B4). |
| 8 | Quest-log persistence & cross-server resume (log survives region change) | World DB layer — typed channel, **not** SQL | **EXISTS** — quest records ride the world character record as `extras.quests` (shape-checked by `questRecordsOf`, `quest-store.ts`) inside `character_state`; on load, the world copy replaces the region log in one transaction (`SqliteQuestStore.replace`, the PL3b path). This is the sanctioned channel: a typed character-record write through the world core, never a SQL statement from a game server. |
| 9 | Quest-log read for the player UI | Region-local compute (read of local log) | **EXISTS** — `QuestService` pushes the whole log after any change (`QuestLogMessage`, `packages/protocol/src/quests.ts`). Presentation reads never touch the DB layers. |
| 10 | Shared / world-quest objective counter (server-wide totals: "the realm has slain 8,412 / 10,000") | **DB layer, mutating function** | **PROPOSED** — no such function exists in either DB layer (see Finding F1). Contract form: a world-tier function in the atomic-ops pattern (working name `fn::quest_counter_advance` — a name this contract proposes, not one in the repo), one call = one transaction, opId-idempotent, version-fenced (rules C1–C4). A counter thousands of actors increment concurrently is the canonical case Joey's decision assigns to the DB. |
| 11 | Limited-pool claim resolution (first-N completions, finite reward pools, world-resource races) | **DB layer, mutating function** | **PROPOSED** — no quest claim function exists. Contract form: resolve the claim inside the DB transaction, fenced like `fn::auction_settle` (the atomic op whose hot-seller behavior is measured in §3), so "was I in the first N?" is decided by the tier that can serialize it — never by regions comparing notes. |
| 12 | Cross-server quest aggregation (realm-wide totals computed over all regions' quest state) | **DB layer, read function** | **PROPOSED** — no Surreal-side quest aggregation exists. Aggregation over the world tier's own records belongs to the world tier (a read query/function over `character_state` extras), not to regions shipping logs to each other. Region-side analogue for the pattern: the leaderboard cache (row 13). |
| 13 | Quest standings / leaderboards (top questers, fastest completions) | DB layer, read function (cache form) | **PROPOSED for quests; pattern EXISTS** — `content/db/caches/leaderboard.sql` already builds a top-100 snapshot (combat power: kills − deaths) as a `_cache_leaderboard` table via the EA17 cache mechanism, and `content/db/functions/character_power.sql` is the working exemplar of a read-only DB function. A quest standings cache follows that exact shape; no quest version exists today. |

**Reading the map:** everything about *one character's* quest — take it, count it, finish it, show it — is region-local today and stays region-local under this contract. Everything that is *shared* — counters, pools, realm totals, standings — is assigned to the DB layer, and almost none of it exists yet. That asymmetry is the honest state of the engine, and §4 lists it as findings rather than smoothing it over.

## 2. Boundary rules

- **B1 — Game servers are read-only against both DB layers.** A game server may call DB read functions and caches, and may invoke the typed world-core operations. It may never issue a mutating SQL statement to the region DB-function layer or the world DB, and no quest feature may add one. (As built, the region layer enforces this mechanically: `db-functions.ts` refuses any function file that is not a single read-only SELECT.)
- **B2 — World-DB mutation has exactly two doors.** (a) The six atomic operations — `tradeCommit`, `vendorTransact`, `auctionSettle`, `craftExecute`, `lootGrant`, `inventoryMutate` (WorldStore ops; Surreal forms `fn::trade_commit`, `fn::vendor_transact`, `fn::auction_settle`, `fn::craft_execute`, `fn::loot_grant`, `fn::inventory_mutate`) — and (b) typed world-core APIs such as the character-record save that carries `extras.quests`. A quest operation that needs world-DB mutation must fit one of these doors or be proposed as a new DB-owned function in the atomic-ops pattern (§1 rows 10–11). It may not open a third door.
- **B3 — A quest operation qualifies for DB ownership when any of these hold:** its state is shared between characters or regions (counters, pools, standings); its correctness depends on serialization against concurrent actors (claims, first-N, races); or its aggregation is heavy enough that computing it in a region would mean shipping many records to the compute instead of computing where the records live. If none hold, it stays region-local — the DB tier is not a default, it is the escalation.
- **B4 — Value movement follows the value rule, not the quest rule.** Gold and items granted as quest rewards are value movement. Inside one region they may use the region paths that exist (rows 6–7). Any reward whose correctness must hold across servers — a shared pool paying out, a realm-first prize, a reward granted while the character's home region is down — must go through the atomic ops (`lootGrant` / `inventoryMutate`), inheriting their fencing and idempotency instead of re-implementing them in quest code.
- **B5 — Every DB-owned mutating function is deterministic and idempotent.** Same inputs + same fenced state ⇒ same commit or same typed rejection. Every mutating call carries an `opId`; a retried call with the same `opId` returns the first call's outcome and changes nothing twice (the world core's existing dedup is the mechanism; quest functions inherit it, they do not reinvent it).
- **B6 — Region-local quest state stays reproducible from the world copy.** The region quest log is a working copy; the world character record (`extras.quests`) is the resume point. Region code must never treat its local log as the only copy of anything a player would lose — write-through (as `QuestLog` does today) is the standing expectation.

## 3. Contention-safety rules for large-scale quests

These are requirements a quest designer can implement directly from. They are not aspirations: each one restates behavior the atomic-ops layer already implements or the 51k contention harness already measured (`~/workspace/your_files/mmo-engine-scale/CONTENTION-51K-REPORT.md` — 51,256 entities, one region, all actors on shared resources; sandbox figures, cited as measured there).

- **C1 — One operation = one transaction.** A quest operation that mutates DB-tier state commits entirely or not at all. The atomic ops' governing invariant — one operation = one WorldStore call = one DB transaction, with every participating record and the ledger untouched on rejection — is the template every DB-owned quest function follows.
- **C2 — Every mutating call carries an opId, and retries reuse it.** Network retries, region restarts, and double-submits must be safe by construction: same opId, same outcome, no double grant, no double counter increment.
- **C3 — Fence with lock epoch + record version, and expect VERSION_CONFLICT.** DB-tier quest state is read with its version/epoch and written back guarded (the Surreal atomic functions throw `VERSION_CONFLICT` on a stale guard and abort the whole invocation). In the 51k harness, `VERSION_CONFLICT` was 22.2% of all attempts (58,123 of 261,984) — at scale, conflict is the normal case, not an error case. Design for it.
- **C4 — On VERSION_CONFLICT, refresh the fences and retry once.** The measured cure: of the operations that eventually settled, every built refresh-and-retry succeeded (57,984 of 57,984), lifting overall settlement to 88.3% of 204,000 planned operations. A quest function call that conflicts and is *not* retried is a coin the designer chose to flip; the contract's default is one refresh + one retry, then surface the typed rejection.
- **C5 — Rejections are typed, and quest code branches on the type.** The atomic vocabulary — `INSUFFICIENT_FUNDS`, `ITEM_NOT_PRESENT`, `VERSION_CONFLICT`, `LOCK_CONFLICT`, `EPOCH_STALE` — is the rejection language DB-owned quest functions speak. "The realm pool is empty" is a typed outcome a designer can present ("the last reward was claimed"), never a silent failure or a partial commit.
- **C6 — Hot resources serialize; design the quest so that is fun, not fatal.** The harness's sharpest edge was one hot seller under `auctionSettle`: 13% per-attempt success while everything contended on the same records. A world quest that funnels 50,000 actors onto one counter, one pool, or one NPC-turned-claim-point will behave the same way: most attempts conflict, the refresh+retry cure (C4) carries them, and per-attempt latency grows. Prefer many counters/pools sharded by design (per-region sub-counters the DB aggregates — row 12) over one global hot record wherever the fiction allows it.
- **C7 — Never hold a DB transaction across a tick, a network hop, or a player decision.** Quest steps complete in the region; only the final, small, fenced mutation goes to the DB tier. A DB-owned quest function receives everything it needs in one call (the atomic functions receive precomputed records/entries and validate-then-commit in one invocation) — it does not reach back into a region mid-transaction.
- **C8 — Counters only move inside fenced transactions.** A shared quest counter incremented by read-modify-write from region code is a lost-update machine at 51k actors. Increments happen inside the DB function (row 10), guarded per C3, or they do not happen at all.
- **C9 — Assume the same character can act on two regions in quick succession.** Hand-off and resume ride the character record (row 8); its whole-log replace granularity means a designer must not build quests whose correctness depends on two regions advancing the *same character's* log simultaneously. Per-character quest state has one writer at a time (the region currently holding the character); shared state lives in DB-owned counters/pools, not in clever merging of logs.
- **C10 — The ledger is the audit.** Value-moving quest operations append to the same world item ledger the atomic ops write, so gold and items a quest creates can be reconciled to the unit after the fact (the soak/harness audits conserved totals exactly). A quest reward path that moves value without a ledger entry is out of contract, however convenient.

## 4. Findings — where the contract and the engine differ today

- **F1 — No quest-specific DB function exists in either DB layer.** The region layer ships exactly one function (`character_power.sql`) and one cache (`leaderboard.sql`), both combat-power, neither quest-related. The world layer ships exactly six stored functions, all atomic ops, none quest-named. Rows 10–13 of the map are therefore PROPOSED in full: the shared-quest half of Joey's decision is currently unimplemented, not partially implemented.
- **F2 — Quest gold rewards bypass the world-tier atomic ops today.** Hand-in grants gold through the region wallet (`grantGold` → `walletHolder.grant` in `packages/engine-core/src/server.ts`) and items through the region `ItemService`. That is coherent for single-region play, but it means quest rewards inherit none of the atomic tier's fencing, opId idempotency, or ledger audit (C2, C10) — a cross-server quest reward path does not exist until row 7's wiring lands. Recorded as a gap against B4's cross-server clause, not as a defect in the single-region path.
- **F3 — Cross-region quest-log safety is whole-log granularity.** `SqliteQuestStore.replace` swaps a character's entire log in one transaction from the world copy. Two regions advancing one character's log concurrently would resolve as last-replace-wins for the whole log. Nothing in the current design lets that happen (one region holds a character at a time), and C9 writes the assumption down so quest design doesn't silently grow past it.
- **F4 — No violation of the read-only boundary was found.** Game-server code issues no mutating SQL to either DB layer: the region function loader refuses non-SELECT files at load, and world-DB mutation is reachable only through the six typed atomic ops and typed world-core APIs. Quest writes that exist today are region-local store writes and the typed character-record channel — both inside the boundary as the layers section above defines it. The gap is absence (F1, F2), not trespass.

## 5. Sources

Repo (all at `origin/main`, read 2026-10-25):

- `packages/engine-core/src/quests/quest-service.ts` — QuestService: region system + gateway extension, progress counting, dialog hand-in, reward callbacks.
- `packages/engine-core/src/quests/quest-log.ts` — QuestLog state machine, write-through store contract, `MAX_ACTIVE_QUESTS`.
- `packages/engine-core/src/quests/quest-store.ts` — `SqliteQuestStore`, `questRecordsOf`, PL3b `replace`.
- `packages/engine-core/src/quests/generate.ts`, `quest-def.ts`, `content.ts` — board generation, definitions, content loading; content in `content/quests/*.json`.
- `packages/engine-core/src/server.ts` — service wiring: `countInBag`, `grantItem`, `grantGold` (region wallet).
- `packages/engine-core/src/persist/db-functions.ts` — EA17 DB functions/caches: read-only-by-load enforcement, `_cache_<name>` snapshots.
- `content/db/functions/character_power.sql`; `content/db/caches/leaderboard.sql` — the only function and cache that exist.
- `packages/world-server/src/atomic.ts` — the six atomic ops' shared pure transition module; governing invariant.
- `packages/world-server/src/surreal-store.ts` — `ATOMIC_FN_NAMES`, `defineAtomicFn`, the six `fn::` stored functions, version/seq fencing.
- `packages/world-server/src/core.ts`, `fake-store.ts` — world core and the in-memory store running the same transitions.
- `docs/ATOMIC-OPERATIONS-SPEC.md` — op set, typed rejections, opId idempotency, region integration (A2).
- `docs/PERSISTENCE-LAYER-SPEC.md` — persistence tiers and the world-DB-as-source-of-truth model.
- `packages/protocol/src/quests.ts` — quest log/dialog wire messages.

Measured evidence:

- `~/workspace/your_files/mmo-engine-scale/CONTENTION-51K-REPORT.md` — 51k-actor contention: VERSION_CONFLICT rate, refresh+retry cure, hot-seller auction edge (§3's numbers).

Decision record:

- Joey, 2026-10-14 (quoted in the header): DB-owned heavy compute for large-scale quests; read-only constraint binds game servers only.
