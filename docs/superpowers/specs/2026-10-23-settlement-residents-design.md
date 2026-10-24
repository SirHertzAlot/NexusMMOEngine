> **Status (2026-10-24): built except two parts.** RS1-RS7 are on main (ROADMAP rows RS1-RS7; the spec names them R1-R7). Decisions made: residents are attackable (they lie 10 s, stay dead three game days, then someone new moves in), homestead families are baked into `places.json`, dialogue is generated (`barkFor`), `maxFull` 300 / `maxEntities` 800 stand. Not built: the `residents-tick` valgrind workload (no valgrind on the dev host) and the editor overlay, and the `trade`, `quest` and `learn` options. The residents live in a `residents` module, not in engine-core.

# Settlement residents: the people who live in the baked towns and homesteads (SG3b, SG7)

## Intent
Every baked town already knows its people. `occupy()` (`packages/settlement/src/occupancy.ts:59-163`) deals a town's
population into households and homes, and working-age people into jobs. Each `Npc` (`occupancy.ts:21-37`) has a
`home` (or a `shelter` if homeless), a `cohort`, a `class`, a `role`, and maybe a `workplace`, `mastery` or
`grandMaster`. Each `Shop` names its keeper (`occupancy.ts:159-161`). A 600-person town comes to 136 households, 283
jobs and 86 shops (ROADMAP 2026-10-15). Homesteads carry a `family` of 2 to 10 (`places.ts:113-114`, drawn at
`places.ts:521`). Nothing spawns any of them yet. The town scenes and `places-scene.ts` (`:1-8`) build only the
buildings. SETTLEMENTS.md (§"Spawning a town into the world", end) explains why: putting people in the world needs a
simulated-agent path, "not hundreds of idle villagers".

Most of the pieces exist:

| Piece | Where |
| --- | --- |
| Bot entity (same as a player avatar), crowd-steered wander, random look | `packages/engine-core/src/bots.ts:1-22`, spawn `:96-140`, NavAgent target `:207-213` |
| Detour crowd steering for every character, default capacity 1024 agents | `navigation/crowd-system.ts:1-18`, `navigation/backend.ts:35-36` |
| Day clock, derived from the tick | `packages/protocol/src/day-clock.ts:8-20`; server `server.ts:250,667,747` |
| Seeded looks from the character kit | `randomLook(catalog, gender, rng)` `packages/art/src/character/look.ts:136`; `sim.setLook` (`bots.ts:120`) |
| Quest givers and dialog (U11): E to talk, numbered replies | `content/quests/npcs.json`, `dialogs.json`; `QuestGiver` spawn `scene-spawn.ts:181-187` |
| Raids: a creature in `raid` mode goes for a settlement | `creatures.ts:15-22,79,100-103`, `setSettlements` `:170-171`; settlements from the scene `server.ts:731-734` |
| Structure node id is the structure id, so `npc.home` / `workplace` resolve to a position | `packages/settlement/src/scene.ts:62` |

This spec adds one server system that turns the occupancy into people who keep a day, at a cost the tick can afford.
It follows the tiers sketched in `docs/LIVING-SIM-DEEP-DIVE.md` §4.1 (schedules, background vs local) but stops short
of needs, economy or memory.

## Goals
1. **Residents from the bake.** Every loaded town's and homestead's people exist in the world as derived data.
   Nobody authors them, and they are stable across boots.
2. **A day by role.** Home, then work, then tavern, then home, on the day clock. They walk the navmesh through the
   crowd. Shopkeepers stand at their shops in working hours.
3. **Stable looks.** Each resident's look is seeded from their id, so they look the same every boot and to every
   player.
4. **Hooks for E.** A resident answers "what can I do with you?" (talk, trade, quest). The interaction system
   (in flight) calls it.
5. **Raids.** Residents flee indoors when raiders come to their town and come out afterwards.
6. **Within budget.** The tick and the wire cost stay bounded however many towns are loaded, and the cost is measured
   with `valgrind:perf`.

## Non-goals
- Needs, wages, an economy, rumours, factions or relationships (Living Sim §4.2+).
- The interaction system itself: the E prompt, its UI, the trade screen. This spec gives it a lookup.
- Interest management. It is designed elsewhere. Until it lands, every entity reaches every client
  (`DECISIONS.md:316`), so this spec bounds entity count instead.
- Indoor scenes. Buildings are boxes. "Indoors" means the resident has no entity.
- Children's and elders' own animations or body scale.

## Anti-goals
- **Persisting residents.** They come from the seed and the bake, so a restart gives the same people. Nothing is
  stored except, if residents can be attacked, which of them died (see Persistence).
- **Allocation or `Math.random` in the tick.** Ids are hashed (`hash` from `procgen/ecology.js`, as `bots.ts:30`).
  Brains are numbers.
- **Ticking far towns.** A town with no player near it costs nothing per tick.

## Design (my calls)

### The schedule is a pure function
`scheduleAt(npc, timeOfDay) -> { anchor: structureId, activity }` lives in `packages/settlement` (tested there,
with no engine dependency). Its rules are data, a `schedules` section in `content/settlements/rules.json` keyed by
role. Blocks below are defaults:

| Who | Night | Morning–afternoon | Evening |
| --- | --- | --- | --- |
| Worker (`workplace` set) | home 22–6 | workplace 8–17 | tavern 17–21 (a seeded share of adults, else home) |
| Tavern/inn keeper, watch, barracks soldier | role's own shift (e.g. keeper 12–24 at work) | | |
| Resident, elder (no job) | home | home ↔ square / market | home |
| Child | home | square near home | home |
| Beggar, orphan | shelter (or rough at the square) | square / market | shelter |

Each npc's block edges are shifted ±30 game minutes by a hash of their id, so a town does not move in lockstep. The
"tavern" is the nearest tavern or inn structure to the npc's home (both are store archetypes,
`rules.json:187-188`). Masters and grand masters keep worker hours at their workplace. Shopkeepers are workers whose
workplace holds the shop, so they stand at the shop in working hours with no extra rule. A server with no day clock
(`dayClock` null) uses noon.

**Indoors vs outdoors.** Every anchor says whether the resident is visible there. At home at night, in a workshop
interior or in the tavern, they are indoors. A worker at an open-air job (market stall, smithy front, field, gate
watch) or a shopkeeper at the shop front is outdoors. Indoor residents have no entity. At night nearly the whole
town is indoors, which makes it cheap.

### Simulation tiers (per town, re-evaluated at 1 Hz)
| Tier | When | What exists |
| --- | --- | --- |
| **Full** | a player within `fullM` (default 150 m) of the town's edge | An entity per outdoor resident (Transform, Locomotion, Appearance, Health, NavAgent). They walk between anchors through the crowd (the BotSystem pattern, `bots.ts:171-213`). |
| **Coarse** | a player within `coarseM` (default 400 m) | An entity per outdoor resident with no NavAgent. They are placed at their anchor and snap when their block changes, with no steering and no crowd slot. The crowd treats them as obstacles, which they already are as characters. |
| **Schedule-only** | otherwise | Nothing. When a town is promoted, its residents are placed from `scheduleAt` for the current time. |

Hysteresis of 25 m stops thrash at the edges. A **per-region budget** (`residents.maxFull`, default 300;
`residents.maxEntities`, default 800) is filled nearest town first. Residents over the budget stay schedule-only, so
the far side of a big town can be empty when the region is crowded. The crowd's 1024-agent capacity
(`backend.ts:35-36`) is shared with players, bots and creatures, so `maxFull` must leave room for them.

Decisions run at 1 Hz, staggered by `index % 30`. Only walking is per-tick, and the crowd already pays for it.

### Spawning
`ResidentSystem` (engine-core, next to `bots.ts`) is given, for each loaded town (all of them once
`feat/world-scenes` lands), its occupancy from the manifest and the world position of each structure, by node id
(`scene.ts:62`). Homesteads come from `places.json`. A homestead's members are derived by
`homesteadFamily(place)` in `packages/settlement`, seeded by the place id: a head adult, the rest by the town
demographics' cohort mix, all working the farm or ranch (house ↔ field/pen). Roadside places (inn, outpost) get
their keeper and guards the same way. Doing this at load avoids re-pinning the places hash. A resident entity
carries a `Resident` row (npc id, town, role). A per-boot `Map<eid, npcIndex>` maps back to the npc. Entity ids are
per boot, like every scene entity.

### Looks
`randomLook(catalog, gender, rng)` (`look.ts:136`), with `rng` seeded by `hash(npcId)` and gender from one bit of
the same hash. Class picks the outfit set when the catalog tags one (peasant plain, noble fine). Until it does, the
starter body, as bots wear. The look is computed once on first spawn and cached by npc id, so promotion does not
redraw it.

### Interaction hooks (for the interaction system)
`residents.describe(eid) -> { name, role, options }` with options drawn from:
- `talk`: a bark line from a per-role table (`content/settlements/barks.json`), picked by hash(npc id, game day),
  with time-of-day and raid variants.
- `trade`: if the npc keeps a shop and is at it now.
- `quest`: if a quest giver in `content/quests/npcs.json` is bound to them by a new optional `resident: <npc id>`
  field. The giver then walks with the resident instead of standing at a fixed `x, z`. U11's dialog is reused
  unchanged.
- `learn`: if `mastery` is set (a hook only; the training design is separate).

### Raids
`CreatureSystem` exposes which settlements are being raided now (from `raidIdx`, `creatures.ts:100-103`). At 1 Hz,
each resident of a raided town who is outdoors gets their home (or nearest building) as an urgent target. Full-tier
residents run at sprint pace and become indoors when they arrive. Coarse ones go indoors at once. Barks switch to
the raid set. Guards and soldiers (`role` watch/soldier) do not flee: they stay at their post, until attackability
is decided. Twenty to sixty seconds (seeded) after the raid ends, schedules resume. Residents are not raid targets
while they cannot be attacked.

### Persistence
None for residents. They come from the bake and the seed, and the clock gives the same day back. If residents can be
attacked (open question), a dead npc id goes into the range's place state, the PL3 range snapshot that node stocks
ride (`2026-10-23-region-hot-cache-design.md`). It is cleared after N game days, when "someone new moved in" with the
same household slot and a new seed.

### Cost and measurement
- **Tick.** The new `valgrind:perf` workload `residents-tick` sits next to `crowd-tick-100`
  (`scripts/valgrind/workloads.mjs:155`). It runs one 600-person town at 10:00 with one player in the centre, then
  at 23:00, plus a schedule-only pass over 20 towns. The slice that adds it says what moved, updates the baseline
  (`-- --update`) and puts the before/after chart in the PR body (Mermaid). Target: the resident system itself under
  0.2 ms per tick at `maxFull` 300, with the crowd's share reported separately.
- **Wire.** Entity count is the real cost until interest management lands. The budget caps it, and the PR states
  bytes per second per client at the cap.
- **Editor.** A residents overlay in the editor's play mode shows tier per town, counts against the budget and a
  resident's anchor and block, and lets you scrub the time of day. The client shows none of it.

## Left to the builder
The exact archetype → indoor/outdoor table, block hours per role, bark text, and how the stagger interacts with the
crowd's add rate.

## Slices (one PR each)
1. **R1 Residents stand where they belong.** `scheduleAt` (blocks without jitter), anchors resolved from loaded
   town scenes, `ResidentSystem` spawns the outdoor residents of every loaded town at their anchor for the current
   time of day, with seeded looks, standing still. Per-region `maxEntities`, nearest town first. Tests:
   deterministic across boots, budget respected, every outdoor npc placed on its own structure. Screenshot of a
   town at 10:00 and 23:00.
2. **R2 A day.** Jittered blocks, walking between anchors through the crowd at block changes, shopkeepers at shop
   fronts, tavern evenings. GIF of a morning commute.
3. **R3 Tiers and budget.** Full, coarse and schedule-only with hysteresis, `maxFull`, the `residents-tick` perf
   workload, baseline and chart. Editor overlay.
4. **R4 Homesteads and roadside people (SG7).** `homesteadFamily`, the innkeeper and outpost guards, farm and ranch
   days.
5. **R5 Interaction hooks.** `describe(eid)`, barks content, the `trade` and `quest` options, and the
   `resident` binding on quest givers. Lands after, or alongside, the interaction system.
6. **R6 Raids.** The raided-settlements query on CreatureSystem, flee indoors, guards hold, resume.
7. **R7 (only if decided) Attackable residents.** Health that can be hit, raid targeting, deaths in the range
   snapshot, replacement after N days.

## Open questions
1. **Attackable?** My default is no: residents are invulnerable, and guards are the only ones who fight back (later).
   Yes brings R7, crime and reputation pressure, and raids that kill townsfolk.
2. **Budget defaults.** `maxFull` 300 and `maxEntities` 800 per region, with `fullM` 150 m and `coarseM` 400 m.
   Should these be larger or smaller?
3. **Homestead families.** Derive the members at load (my call, no re-bake), or bake them into `places.json`, which
   re-pins its hash?
4. **Barks.** Authored per role in a content file (my call), or generated?
