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

Licensed third-party art is NOT content: it lives in the git-ignored
`/assets/` directory and must never be committed.
