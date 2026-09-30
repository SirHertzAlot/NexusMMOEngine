# Working in this repo

Read `README.md` for layout and setup and `docs/DECISIONS.md` for why things
are the way they are.

## Workflow

- **One PR per feature.** Every feature or addition gets its own branch and
  its own pull request, opened as soon as the feature is complete (tests pass,
  checked in the running app where it shows). Don't stack unrelated work on
  an open PR.
- **Show the progress.** For anything visible or measurable, capture it and
  send it for review with the PR: PNG screenshots of the running client
  (Chromium via Playwright), GIFs for motion (animation, effects, physics),
  and charts for performance work (benchmarks). Keep the media out of the
  repo (screenshots show licensed art); describe what each one shows in the
  PR.
- **Keep the roadmap current.** `docs/ROADMAP.md` is the official task
  list. Every PR updates its item's status there and adds a line to its
  update log; new work goes on the list before it starts.
- **Client or editor?** The game client shows only the player's
  interface. Developer tools (debug overlays, performance graphs,
  inspectors, toggles) belong in the editor, the debugger in its play
  mode.
- **Test before pushing.** `npm test` at the root runs every workspace. A
  native addon change needs its addon rebuilt (`npx node-gyp rebuild` in the
  addon) before engine-core's tests use it.

## Hard rules

- **`/assets/` is confidential licensed art: never commit or push anything
  in it**, and never copy it elsewhere in the repo. The dev server serves it
  locally only (`vite-local-assets.ts`, loopback).
- After `npm install`, restore the root lockfile's `"packages": {"dev": true,
  "optional": true, "peer": true}` block, which npm rewrites to `{}`.
