# BUILD PROMPT — Dungeon bake, detail layers, terrain texture masking, unified cel shading

Paste-ready prompt for a coding agent working in the Nexus engine repo.
Companion design docs: `DUNGEON-BRUSH-REVERSE-ENGINEERING.md` (the room-
brush teardown this builds) and the engine's existing VFX recipe / scatter
pipeline code, which this work deliberately mirrors.

---

You are building four connected features in the Nexus MMO engine repo.
Read the repo first: `packages/art` (schemas, VFX recipes, scatter),
`packages/engine-core` (world bake), `apps/client/src/render` (toon,
shading, quality), `apps/editor` (authoring). Follow the house rules
without exception: TDD (tests before/with code), DRY, narrow swappable
interfaces, data-first (define with data and schemas before behaviour),
server-authoritative gameplay is untouched — everything here is bake-time
or client-render. No new runtime simulation. Work in phases; each phase
lands green (tests + tsc + build) before the next starts.

## Phase 0 — Cel-shading consistency audit (report before changing)

The game's cel shading is applied inconsistently. Establish why, in a
written audit committed with the phase:

- Inventory every material path in `apps/client`: the toon patch
  (`render/toon/toon-material.ts`), the shading module
  (`render/shading/shading.ts`), standard materials, `packages/art`
  material definitions (`SHADING_COMPONENTS`).
- Note: a second cel system exists — the D1 ramp shader-library work
  (`libD1Diffuse`, ramp-as-asset) — on local branch
  `arlo/shader-library-seed`, NOT on main. State whether it is in scope
  as the convergence target or explicitly out; do not silently layer a
  third system.
- Produce a coverage table: every rendered object class (terrain,
  buildings, props, characters, creatures, water, sky, VFX, impostors)
  × which shading path it actually takes today.

## Phase 1 — Unified cel shading (make it consistent)

Converge the client on ONE cel-shading model, driven by the audit:

- Cel shading becomes the **default** for world geometry. Adoption is no
  longer per-material opt-in by hand; materials declare an explicit
  **opt-out** with a recorded reason (expected opt-outs: sky, water,
  transparent VFX, editor-only helpers — each justified in the audit doc).
- One shared ramp asset and one feather policy, sourced from
  `quality.ts` per tier (hard bands at low, feathered at higher tiers).
  Ramp is an authored asset (bands, colours) validated like other art
  assets — not constants scattered in code.
- The art package's shading union and the client's patch must agree:
  a material authored as cel in `packages/art` renders cel in the
  client, always. Add a test that walks the material registry and fails
  if any world material resolves to the smooth path without an opt-out
  record.
- Outlines (`render/toon/outline.ts`, inverted hull) follow the same
  rule: on by default for the same classes, tier-gated by cost, off
  only via the same opt-out record.
- Acceptance: the Phase 0 coverage table re-issued with every row on
  the unified path or carrying a named opt-out; client suite green;
  a stills checklist (noon/dusk/night) left for human GPU verification —
  do NOT claim rendered output verified from headless software-GL.

## Phase 2 — Terrain texture-masking pass (procgen, bake-time)

Add a masking pass to the world bake, after terrain generation and
before scatter/detail:

- Per chunk, bake a **material mask** (texture channels or ID+weight
  data) derived from terrain data the bake already computes: height,
  slope, moisture, biome, erosion/flow. Channels at minimum: base ground,
  rock exposure, wet/darkened soil, path/wear.
- Masks are **data with a schema** (Zod in `packages/art` style):
  resolution per chunk, channel meanings, generation parameters
  (thresholds, noise scale, feather widths) all fields, all seeded, all
  reproducible — same seed, same mask, hash-checked in tests.
- The client terrain material consumes the mask for blending (this is
  where terrain meets Phase 1: masked terrain still shades cel).
- The mask is also an **input to Phase 3**: detail placement reads the
  same moisture/rock/path channels instead of recomputing conditions.
- Acceptance: mask bake for the default world spec completes within
  the existing bake's time envelope (measure and report); golden-hash
  tests on a fixed seed; a parameter change provably changes only the
  intended channel.

## Phase 3 — Decoration/detail layer system (shared core)

Build ONE layer system used by both dungeons and the overworld:

- A **detail layer** is data (schema in `packages/art`): `id`,
  `assetSet`, `surface` (floor/wall/ceiling/terrain), `density`,
  `noise {scale, threshold}`, `band` (distance-to-wall range indoors;
  mask-channel range outdoors), `affinity` (corners indoors; slope/
  moisture bands outdoors), `cluster {size, falloff}`, `seed`,
  `budget` (hard per-layer cap enforced at bake).
- A **placement evaluator** (pure, seeded, deterministic; TS reference
  implementation in the scatter pipeline's existing style) turns a
  layer + a surface context into placements. Two contexts ship:
  dungeon interior (Phase 4) and terrain chunk (reads Phase 2 masks).
- Bake output: merged/instanced geometry per chunk or room; texture-
  mesh detail (moss, lichen, ground plants) is alpha-tested cross-quad
  / conformed patch geometry — never full models, never runtime cost.
- Tier behaviour: low tiers thin layers at bake (raise threshold /
  scale density) via the budget fields; the runtime never re-decides.
- Acceptance: evaluator unit tests incl. determinism (same seed →
  identical placements), budget enforcement test, one overworld layer
  (moss on the wet channel) and one indoor layer (wall-band rubble)
  baked end-to-end on test fixtures.

## Phase 4 — Dungeon bake v1 (mask → shell → layers)

- **Layout mask**: cell grid (schema), per-cell solid/floor plus a
  per-cell height level (pits, daises); masks stack across levels with
  a portal list (door, arc, corridor, stair) as control-point objects —
  each portal is both a shell cut AND an ECS portal entity (same data,
  no drift).
- **Shell**: contour extraction → simplify (tolerance is a field) →
  extrude (wall height/thickness/style, corner mode, ceiling mode,
  floor style — all theme fields). Collision output for the server's
  physics from the same shell data.
- **Themes**: a theme = shell settings + ordered detail layers.
  Ship two proving themes on one fixture dungeon: *dry crypt* (rubble,
  sparse torches) and *damp crypt* (moss wall-band wide, mushrooms in
  corners, torches sparse) — same mask, visibly different dressing,
  changed only by theme data.
- **Editor surface** (minimal, honest scope): paint/erase the mask in
  the authoring viewport, place portals as points, edit theme/layer
  fields in the shelf, re-bake and view. Provenance (5W1H) on baked
  objects per the editor's existing rules.
- Acceptance: fixture dungeon bakes deterministically; portal entities
  match shell openings exactly (test); both themes bake green; editor
  round-trip (paint → bake → view) works in the editor suite.

## Non-goals (do not build)

Runtime/procgen-at-playtime generation of any of the above; a third
shading system; porting the Unity plugin's code (this is a workflow
rebuild); multiplayer/networking changes; the schema-v2 VFX work.

## Reporting

Per phase: what landed (files), test counts, measured numbers where
claimed (bake times, mask sizes), and what remains unverified — visual
output is unverified until a human runs it on a GPU. Commit per phase;
push only on the owner's word (editor-line standing merge rule applies
to editor changes only).
