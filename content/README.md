# content/

Game content the engine generates from, committed with the code:

- `pcg/` — the PCG asset library: PICG graphs (`.pcg`) for game assets
  and the reusable parts they link (`.pcgsubgraph`), indexed by
  `pcg/index.json` (format: `@mmo-engine/picg` `library.ts`). Asset ids are
  the ones spawn tables use. The region serves it (`MMO_PCG_ASSETS`
  overrides the path).

- `quests/` — quests and dialog (roadmap P1): `steps.json` (stages, step
  types and templates for generated quests), `quests.json` (authored
  quests), `npcs.json` (quest givers, their boards and places) and
  `dialogs.json` (dialog graphs). Checked as a set at boot
  (`packages/engine-core/src/quests/content.ts`); `MMO_QUESTS` overrides
  the path.

- `settlements/` — `rules.json`: the town generator's rules (format:
  `@mmo-engine/settlement` `rules.ts` `SettlementRulesSchema`), which the
  settlement bakes read; the editor's Towns view edits and previews it.
  `MMO_SETTLEMENT_RULES` overrides the path. Baked manifests
  (`<id>.settlement.json`) are written here too.

- `server/` — server settings (roadmap EG13, EG14): `persistence.json` (how
  often the world is saved, snapshots kept, the save log's size limit, and
  the database query row caps and timeout) and `world.json` (day length,
  start time of day, and the bots' count, home and roam radius; the
  `MMO_DAY_*` and `MMO_BOTS*` variables still win), read when the server starts
  (`packages/engine-core/src/server-settings.ts`); the editor's Live ops ›
  Server settings edits it. `MMO_SERVER_SETTINGS` overrides the path.

- `dungeons/` — dungeon instances (roadmap D4): `instances.json` (the run
  rules: party size, time limit, re-entry, teardown, loot rolls) and
  `entrances.json` (where in the world a party asks for a run, and which
  pool layouts each draws from). `MMO_DUNGEONS` overrides the path; the
  layouts are the pool `npm run dungeon:bake` writes to `<data>/dungeons`.

- `combat/` — `moves.json` (roadmap EA21): the combat moves' timing,
  chaining, travel and sounds (format: `@mmo-engine/protocol`
  `combat.ts` `validateCombatMoves`). The server loads it at boot
  (`MMO_COMBAT` overrides the path); built-in defaults run when absent.

- `animation/` — `clips.json` (roadmap EA21): the clip map, which clip in
  the animation library each server clip id plays, and whether it loops and
  how long it crossfades (format: `@mmo-engine/art` `clip-map.ts`). The
  client reads it on load; the editor's Animation panel edits it.
  `animations.json` is a v3 animation manifest carrying only the locomotion
  state machine (which base clip plays at which speed, crossfades, the
  airborne rule); v2 manifests (the converter's) still load with the
  defaults. The client animator runs it (`pickLocomotion`).

- `combat/moves.json` — the combat moves' timing, chaining, travel and hit
  frame (roadmap EA21). The server loads it at boot (`MMO_COMBAT`
  overrides; a bad file stops the boot with every problem named), the client
  reads it for clips and for each move's `sound.start` / `sound.hit` audio
  events. Edited on the Animation panel's combat timeline; restart the play
  server to apply.

- `materials/materials.json` — the toon look, terrain surface tints and the
  footstep sound per surface (roadmap EA22); the client applies it at start.
  Not to be confused with the single material definitions beside it
  (`materials/<name>.json`). Edited in the Materials view of Art & audio.

- `crafting/recipes.json` — crafting costs (refining, element reagents, fittings, units, skills); checked at server boot (`MMO_CRAFTING` overrides) and read by `npm run craft:report`.

- `species/species.json` — optional overlay merged over the built-in species roster (`MMO_SPECIES` overrides); the editor's Species grid writes it.

- `prefabs/*.prefab.json` — component bundles a scene node places by name (`prefab`), with the node's components overriding field by field (`MMO_PREFABS` overrides). Scenes also place items (`ItemSpawn`), species (`Spawner.species`) and quest posts (`QuestGiver`).

- `settlements/*.settlement.json` — baked towns (`npm run settlement:bake`, roadmap SG1): a canonical manifest with a content hash, read back with `readSettlement`. `--scene` also writes `scenes/settlement-<id>.scene.json`, whose `Structure` nodes the scene spawner turns into buildings (`MMO_SCENE=settlement-<id>`).

- `scale.json` — the global scale document (`@mmo-engine/scene` `ScaleDoc`): a factor for the whole world, one per kind of object (building, tree, rock, plant, prop) and per-asset corrections (an id, or a prefix ending in `*`), multiplied. The server applies it where baked objects spawn (Transform scale and collision together; `MMO_SCALE` overrides the file), so a building that arrives 13 m tall from the art pack can stand 8 m for a 1.8 m character without re-baking. The shipped building factor is 1 (the world is real scale: a storey is 2.7 m for the 1.8 m human; see `docs/SETTLEMENTS.md`). Art is brought to size per model by `npm run settlement:scale-fit`, which writes `content/scale.local.json` (gitignored: it names licensed models); run the server with `MMO_SCALE=content/scale.local.json`.

Licensed third-party art is NOT content: it lives in the git-ignored
`/assets/` directory and must never be committed.

- `playtests/` — automated playtest scenarios (roadmap EA26): one
  `<name>.playtest.json` each, a bot script (admin commands, moves, chat at
  ticks), a seed and bot count for a scratch world, and assertions. The
  editor's Release > Playtests runs them headless on a scratch server;
  results and replays are kept under the data dir, not here.
