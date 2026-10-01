# Alpha plan

What "alpha" means for this engine, the milestones that get there, and the
decisions still open. The status board stays in [`ROADMAP.md`](ROADMAP.md)
(section 7); this page is the reasoning behind it.

## 1. The alpha in one sentence

A player logs in, walks out, meets goblins carrying weapons, fights them
with a sword they can see in their hand, kills them, picks up what drops,
equips it, dies and respawns, logs out, and finds everything still there
the next day, on a server that holds 30 Hz with a published number of
players.

## 2. Exit criteria

Non-functional first: these are what the medium demands.

| # | Criterion | How it is checked |
|---|---|---|
| X1 | The loop above works end to end in the player client | A recorded playtest (GIF set) per milestone |
| X2 | 30 Hz with tick P99 under budget at the published player count, players and monsters fighting | World server D stress harness: bots and creatures in combat |
| X3 | No item is ever created or destroyed outside a recorded event | Ledger invariant test over a stress run: replaying the ledger gives every inventory |
| X4 | A server crash or restart loses at most one checkpoint interval and never duplicates an item | Kill the region mid-fight, restart, diff inventories against the ledger |
| X5 | Every hit, kill, drop and pickup is authoritative and validated (range, facing, ownership, rate) | Cheat tests: forged pickups, out-of-range hits, intent floods |
| X6 | The hot loop stays allocation-free | Heap and GC counters flat during the stress run (E5 graphs) |

## 3. Milestones

Each row is one PR, in order within a milestone. IDs extend the ones the
roadmap already uses.

### α1 First fight: monsters, weapons, damage, loot on the ground

The priority: something to fight, with weapons, that drops loot.

| # | Slice | Builds on |
|---|---|---|
| M3a | **Item instances**: an item definition table baked from the loot pool (physical properties per `MASTERY-AND-COMBAT.md` §3.1), and a runtime instance store as preallocated columns (id, definition, owner, location, durability). A ground item is an entity with a `WorldItem` row, streamed like props. Admin `give` and `drop` | L1 loot pool, A3 spawn |
| M3b | **Held weapons**: a `Held` component (main hand, off hand) on the wire; the client attaches the weapon mesh to the hand bone. One shared geometry and material per weapon definition, disposed when the last holder goes. A starter sword for new characters | M3a, E3 art pipeline |
| M2a | **Damage**: `CombatSystem` resolves the strike at the hit frame: reach (item length plus arm) and a facing cone, against a spatial-grid query with a reused scratch buffer. Damage comes from the rules' `computeDamage` hook with the held item's properties. Guard reduces it, the dodge roll avoids it. A hit event drives hit reactions. Rolls are seeded by tick and both entities | M3b, rules hooks |
| M2b | **Death and respawn**: health at 0 kills; `death.json` sets the delay, the place, and what is kept. Creatures leave a corpse; players respawn. Deaths are recorded on the character | M2a |
| AI1 | **Creature spawner and brain**: one shared spawner for bots and creatures (the gap `admin/spawn.ts` notes). Species tables pick goblins by biome; monsters use their own models as-is, with a weapon from the pool. Brain: aggro radius, chase over the navmesh crowd, attack through `CombatSystem` like a player, leash home. Admin `spawn goblin` | M2a, species, DetourCrowd |
| L2 | **Drops and pickup**: on a creature's death, a seeded roll draws from the pool's `mob` source and spawns ground items at the corpse. Pickup is an intent the server validates (range, ownership window, inventory space). Ground items despawn after a timeout | M2b, AI1 |
| U10a | **Inventory and equipment, first cut**: a bag grid and the two hand slots, drag to equip, an item tooltip with its properties | L2 |
| U12a | **Hit feedback and target frame**: the target's name and health bar, a hit flash, the player's own health bar reacting | M2a |
| ED1 | **Gameplay tables in the editor**: item definitions, creature numbers (health, aggro, leash, respawn, pack size), loot rules (ownership window, despawn) and death rules, each viewable and editable in the editor. Edits are validated by the same Zod schemas the server loads, written back to `content/`, and picked up by a running development server without a restart | M3a, then each slice adds its table |

Every α1 slice that adds a tunable adds it to ED1's editor view in the same PR.

Done when X1 holds for "fight, kill, loot, equip, die, respawn" in one
session.

### α2 Keep it: persistence and the item ledger

Built on the temporal-persistence model: two clocks, append-only history,
tombstones instead of erases.

| # | Slice | Builds on |
|---|---|---|
| P2a | **Item ledger**: every item event (created by a drop, picked up, equipped, moved, dropped, destroyed) is an append-only row with valid time (the tick it happened) and transaction time (when it committed). Inventories are a view over the ledger. Destroyed items are tombstones, never erased | M3a, L2 |
| P2b | **Character save**: position, health, inventory and equipment saved at checkpoints and on logout, in the same transaction as the ledger rows they depend on | P2a, C1 |
| P2c | **Crash and replay tests**: kill the region mid-fight, restart, rebuild every inventory from the ledger and diff (X3, X4) | P2b |
| L3 | **Pool rebake keeps held items**: the bake reads the ledger's live items, as `loot.ts` already expects of "the world server's record" | P2a |

Ledger reads run off the tick thread (checkpoints, restore, audits), and
range scans use cursors, never load-everything-then-filter.

### α3 Hold it: scale, trust, telemetry

| # | Slice | Builds on |
|---|---|---|
| T1 | **Ingress hardening**: merge the WebSocket frame cap (local branch `fix/ws-payload-limit`), per-session intent and pickup rate limits, validation tests (X5) | — |
| T2 | **Play telemetry**: kills, deaths, drops, pickups, damage dealt and taken per minute, and tick P99, into the editor's graphs (E5) | α1 |
| WD | **Stress harness and the published number** (world server D): N bots fighting M creatures with drops; the number goes in the README (X2, X6) | α1, T2 |
| M1 | **Mastery core**: use-based gain for the first combat skills, so fighting improves the character | M2a |

## 4. What is deliberately not in the alpha

- **Body parts and dismemberment** (the rest of M2 and M3): alpha damage
  is whole-body health; parts come after.
- **Edge/core split** ([`EDGE-CORE-SPLIT.md`](EDGE-CORE-SPLIT.md)):
  worth doing, not needed for the loop. Its slice names E1 to E6 clash
  with the editor's E items and would be renamed when it is scheduled.
- **Dungeon instances** (D4), parties, guilds, quests, mana.

## 5. Engine constraints every slice keeps

- **Server tick**: item instances, held items and hit queries live in
  preallocated columns and reused scratch buffers. No allocation per
  tick, per hit or per drop.
- **Client**: weapons share geometry and material per definition;
  ground items of one definition render as one `InstancedMesh`; scratch
  vectors and matrices are allocated once; geometry and materials are
  disposed when nothing uses them.
- **Art**: weapon and goblin models come from `/assets` through the local
  pipeline and never reach the repo. PR media stays out of the repo.

## 6. Decisions

Decided by the user on 2026-10-01: D1, D2 and D3, and that every
gameplay tunable is editable in the editor (ED1). The rest are proposed
defaults the slices build unless decided otherwise.

| # | Question | Proposed default |
|---|---|---|
| D1 | Pull a whole-body damage path ahead of mastery and body parts? The design docs order M1, then M2, then M3 | **Decided**: yes, whole-body health; body parts replace it later |
| D2 | Loot ownership | **Decided**: the killer's for 30 s, then anyone's; despawn after 5 min |
| D3 | Pickup | **Decided**: a key press near the item, not auto-loot |
| D4 | What a player keeps on death (`death.json` says keep, with partial loss 0.25) | Keep everything for alpha; partial loss waits for the respawn lore |
| D5 | Starter weapon | Every new character gets a starter sword from the pool's lowest rank |
| D6 | Goblin numbers | Health 60, aggro radius 12 m, leash 30 m, respawn 60 s, packs of 2 to 4 |
| D7 | Where weapon stats come from | Composed items from the loot pool (rank sets the properties), not hand-written stats |
| D8 | Player versus player | Off for alpha |
