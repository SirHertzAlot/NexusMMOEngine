# content/

Game content the engine generates from, committed with the code:

- `pcg/` — the PCG asset library: PICG graphs (`.pcg`) for game assets
  and the reusable parts they link (`.pcgsubgraph`), indexed by
  `pcg/index.json` (format: `@mmo-engine/picg` `library.ts`). Asset ids are
  the ones spawn tables use. The region serves it (`MMO_PCG_ASSETS`
  overrides the path).

Licensed third-party art is NOT content: it lives in the git-ignored
`/assets/` directory and must never be committed.
