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

- `dungeons/` — dungeon instances (roadmap D4): `instances.json` (the run
  rules: party size, time limit, re-entry, teardown, loot rolls) and
  `entrances.json` (where in the world a party asks for a run, and which
  pool layouts each draws from). `MMO_DUNGEONS` overrides the path; the
  layouts are the pool `npm run dungeon:bake` writes to `<data>/dungeons`.

- `combat/` `animation/` `vfx/` `materials/` `audio/` — media content (roadmap
  EA21, EA22, EA24), edited in the editor's Art & audio workspace and
  checked by `MEDIA_DOCS` in `@mmo-engine/art`: `combat/moves.json` (the
  moves' timing, chaining and travel; the server loads it at boot,
  `MMO_COMBAT` overrides, the client reads it for clips and sounds),
  `animation/animations.json` (a v3 animation manifest carrying the
  locomotion state machine; v2 manifests still load), `vfx/effects.json`
  (particle effects, weather, splash), `vfx/tiers.json` (quality presets and
  particle budgets), `materials/materials.json` (toon look, terrain surface
  tints and footsteps) and `audio/events.json` (generated-tone events, buses,
  voice limits, hooks). The client inlines them as `virtual:game-content`.
- `crafting/recipes.json` — crafting costs (refining, element reagents, fittings, units, skills); checked at server boot (`MMO_CRAFTING` overrides) and read by `npm run craft:report`.

- `species/species.json` — optional overlay merged over the built-in species roster (`MMO_SPECIES` overrides); the editor's Species grid writes it.

- `prefabs/*.prefab.json` — component bundles a scene node places by name (`prefab`), with the node's components overriding field by field (`MMO_PREFABS` overrides). Scenes also place items (`ItemSpawn`), species (`Spawner.species`) and quest posts (`QuestGiver`).

Licensed third-party art is NOT content: it lives in the git-ignored
`/assets/` directory and must never be committed.

- `playtests/` — automated playtest scenarios (roadmap EA26): one
  `<name>.playtest.json` each, a bot script (admin commands, moves, chat at
  ticks), a seed and bot count for a scratch world, and assertions. The
  editor's Release > Playtests runs them headless on a scratch server;
  results and replays are kept under the data dir, not here.
