# `@mmo-engine/kit-quests`

What a character is asked to do, and who asks. It is a kit, not a part of the
engine: nothing in `@mmo-engine/engine-core` imports it, and a game that wants
a different idea of a quest does not have to work around this one.

## What is in it

One system, and the pieces it is built from:

| Export | What it does |
| --- | --- |
| `QuestService` | The system and the gateway's `"quest"` extension: places reached, objectives met, the giver a player talks to, the dialogue |
| `QuestLog` | The rules of one character's log — accept, advance, hand in, abandon, and the 25-quest ceiling |
| `generateQuest` | A quest built from a template for a day and a giver, by constraint solve (`@mmo-engine/wfc`) |
| `authoredQuest` | A quest written by hand in `content/quests/`, as the same concrete shape |
| `loadQuestContent` | The four content files — steps, quests, npcs, dialogs — parsed and checked |
| `SqliteQuestStore` | What a log persists to, with `MemoryQuestStore` for a harness |
| `questRecordsOf` | Which recalled rows are quests: the validator for what rides a world record |

Plus the worldbuilding a quest reads and writes: pacts and their states, rites,
a sick place's treatments, a price that has come due, and the motivations and
flaws a giver is composed from.

## How a host finds it

Not by port. A port is a system the gateway ticks and asks; this one speaks to
a player directly, so it is an **extension** — `modules/quests/server.js`
builds it and returns it under the key `quests`, the gateway registers it as
`"quest"`, and the server's entry point asks the service registry for a
`QuestService`, which is two calls: `place`, for a scene saying where a quest
starts, and `onDeath`, so a kill can advance a log.

The three questions the gateway asks of whatever registers under `"quest"` are
`QuestExtension` in `engine-core/src/net/extension.ts`:
`pinnedResidentsOf`, `npcOfResident` and `talkAt`. They were written out
inline at four call sites until `ES5o` gave them a name.

An absent module is a feature that run lacks, not an error. Drop
`modules/quests` and nobody offers a quest, no NPC has anything to say beyond
their greeting, and a character's record carries no log; the rest of the world
runs.

## What the engine keeps, and why

Three things, each declared on the engine's side because neither this kit nor
any replacement owns them.

**The log's journey.** A character's quest log rides their world record
between regions (`PL3b`). The host moves those rows and never reads inside
them, which is why `QuestRecords` — `loadQuests` and `replaceQuests` — takes
and returns `unknown`, and why `questRecordsOf` is *here*: the only thing that
can say which rows are valid is whatever wrote them. A recalled log this kit
does not recognise is dropped rather than thrown over.

**Where a quest's giver stands.** A scene can say "stand this quest's giver
here", and until `ES5o` `server.ts` carried that out itself by reaching
through the service into its content, looking up the quest's giver and writing
that NPC's coordinates. A game whose quests are not keyed by a giver NPC could
not place one at all. `place` is this kit's answer now, and the engine passes
on whatever refusal comes back — a refusal moves nobody.

**Determinism.** A generated quest seeds from `hash`, the engine's own mixer,
rather than one of this kit's, because two runs of the same world have to
agree on what the day's quest was.

What this kit asks of the engine in return is eight names, pinned by
`test/kit-boundary.test.ts`: `ExtensionPlayer`, `GatewayExtension`,
`SimSystem`, `SimWorld`, `LifeEvent`, `Transform`, `CharacterRef` and `hash`.
The first two and `QuestExtension` and `hash` were added to the engine's
public entry at `ES5p`; the rest were already there for any kit.

## Changing it

In rising order of cost, which is the engine's usual framing — the cheapest
layer that expresses what you want:

1. **Data.** The quests themselves, the steps they are built from, the NPCs
   who give them and the dialogue they speak are all content:
   `content/quests/` (`steps.json`, `quests.json`, `npcs.json`,
   `dialogs.json`). A template plus a day's seed is how a generated quest
   comes out, so new templates mean new quests without code.
2. **Module wiring.** `modules/quests/server.js` builds the service and hands
   it the host's pieces: what a species is near, what an item base is, what is
   in a bag, and how to grant an item or gold. Change what it passes, or
   disable the module, without touching this package.
3. **One piece.** The log's rules (`quest-log.ts`), the generator
   (`generate.ts`) and the content schema (`content.ts`) are separate files
   with one import edge each, so a game can keep the service and replace how
   a quest is generated, or keep the generator and widen the schema.
4. **The kit.** Fork it, or ignore it and write your own. The engine's side of
   the contract is `QuestService` and `QuestRecords` in
   `engine-core/src/services.ts`, `QuestExtension` in
   `engine-core/src/net/extension.ts`, and the eight names above — all of it
   declared where neither side owns it.

Nothing here limits what your game may do. The costs above are what each
change takes, not permission to make it.
