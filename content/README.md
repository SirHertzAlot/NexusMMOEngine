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

- `combat/` — `moves.json` (roadmap EA21): the combat moves' timing,
  chaining, travel and sounds (format: `@mmo-engine/protocol`
  `combat.ts` `validateCombatMoves`). The server loads it at boot
  (`MMO_COMBAT` overrides the path); built-in defaults run when absent.

- `animation/` — `clips.json` (roadmap EA21): the clip map, which clip in
  the animation library each server clip id plays, and whether it loops and
  how long it crossfades (format: `@mmo-engine/art` `clip-map.ts`). The
  client reads it on load; the editor's Animation panel edits it.

Licensed third-party art is NOT content: it lives in the git-ignored
`/assets/` directory and must never be committed.
