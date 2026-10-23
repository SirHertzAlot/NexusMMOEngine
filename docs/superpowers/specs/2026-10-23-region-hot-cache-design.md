# Regions as hot caches (PL3)

## Intent
The world's embedded SurrealDB is the source of truth, and a region server is a hot cache in front of it. A region
whose disk is wiped, or a new region taking over a range, gets everything back from the world. You described the
target as "the region server processes all of these and sends them with a periodic snapshot update".

Today (after #351 and #352) the world holds:
- each range's ECS snapshot (every 300 ticks);
- the item ledger;
- each character's state, skills and gold (P4, on the region's save cadence);
- dungeon runs.

These five region SQLite files never leave the region:

| Store | File | Keyed by |
| --- | --- | --- |
| Quest logs | `quests.db` (`quest_log`) | character |
| Gathering pouches | `gathering.db` (`pouches`) | character |
| Resource node stocks | `gathering.db` (`resource_nodes`) | node key (a place) |
| Friends and blocks | `social.db` | character |
| Guilds (members, officer log) | `guilds.db` | guild, global |
| Parties | `parties.db` | party, global |

## The one decision for you: where per-character and global state rides
All of it goes uphill on the region's periodic update, as you described. The open question is which record carries
each piece, because they cross region borders differently:

- **Place state** (node stocks) belongs to the range. It rides the **range snapshot** (`shard_snapshot.payload`), next
  to the ECS bytes, and a takeover of the range gets it back.
- **Per-character state** (quest log, pouch, friends/blocks) belongs to the character, who walks between regions. It
  rides the **character's world record** (P4 `character_state`, which already carries state, skills and gold on the
  same cadence). A character crossing into another region, or logging in anywhere, brings their quests and pouch with
  them. Putting them in the range snapshot instead would leave a character's quests behind on the region they left.
- **Global state** (guilds, parties) belongs to neither. It becomes **world records** (`guild`, `party` tables in
  SurrealDB). Each region writes changes through and reads them on boot, the same seed-then-cache pattern as P3.
  Today every region has its own `guilds.db`, so a guild made on one region doesn't exist on another.

My recommendation is this split. The alternative, everything in the range snapshot, is simpler but keeps
cross-region play broken for quests, pouches, guilds and parties.

## Goals
1. A region rebuilt from the world (empty data dir, or a takeover) gets every row of the six tables back.
2. Characters keep their quests, pouch and friends when they cross regions or log in on another region.
3. Guilds and parties are the same on every region.
4. Standalone mode (no `WORLD_URL`) is unchanged: SQLite only.

## Non-goals
- Instances (`instances.db`): dungeon runs already report to the world.
- Accounts and sessions (`admin.db`, sessions): accounts are world-server item C.
- Live cross-region push. A guild change on region A shows on B at B's next read (boot, or a periodic refresh).
  Real-time fan-out between regions is later work.
- Changing any store's local schema or API.

## Anti-goals
- A region blocking its tick on the world: all world I/O stays on the save timer, never the tick.
- Silent divergence: when the local and world copies disagree at boot, the world wins (P3 rule) and the log says so.
- Losing a write during a world outage: local SQLite keeps everything, and the next cycle ships it (outbox, as the
  ledger does).

## Design (my calls)
- **Range snapshot payload:** `{ format, contentHash, data, places: { resource_nodes: [...] } }`. The content hash
  covers the bytes and the places, so an idle range still skips its upload. Recall writes `places` into
  `gathering.db` before `GatheringSystem` opens it.
- **Character payload:** P4's `WorldCharacterState` grows `quests`, `pouch` and `social`, read from the local stores at
  save and seeded into them at login (P4's `seedLocal`). The 256 KiB character cap stays; a quest log near it is
  logged.
- **Guilds and parties:**
  - New world RPCs `PutGuild` / `GetGuilds` and `PutParty` / `GetParties`, version-guarded like `character_state`.
  - The region writes a changed guild or party on the save timer and reads them all at boot (seeding `guilds.db` and
    `parties.db`).
  - Conflicts: last writer by version, with a 409 for a stale version. The losing region rereads.
- Every new path has a fake-store test and an embedded-SurrealDB contract test, plus one live check: wipe a region's
  data dir, reboot, and every table is back.

## Left to the builder
Batch sizes, the refresh period for guilds and parties (default: on boot and every 60 s), and test fixtures.

## Slices (one PR each)
- PL3a: node stocks in the range snapshot.
- PL3b: quests, pouch and social in the character record.
- PL3c: guilds and parties as world records.
