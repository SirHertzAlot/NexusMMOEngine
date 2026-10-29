# Three.js Tooling Review — Animation, Optimization & Inspection

**Reviewed:** 2026-10-09, from a "Best Libraries for Three.js in 2026"
roundup Joey pasted in. Each tool is judged against our stack (R3F mirror
client, vanilla-three.js editor, bake-time art pipeline, permissive-only
licenses, cost/benefit gate).
**Status:** recommendations, not locked decisions.

## ADOPT

### gltfpack — asset optimizer for the bake pipeline

- **What:** CLI optimizer (mesh reorder, texture downscale, Draco/Meshopt
  output); the roundup claims 50–90% compression.
- **License:** MIT (meshoptimizer, Arseny Kapoulkine). Clean.
- **Why adopt:** meshoptimizer is already in the client today, but only
  for *simplification* (LOD generation in `src/render/lod.ts`) — no
  compressed-asset *decoding* is wired yet. gltfpack gives the bake
  pipeline a blessed encode path, and the integration plan pairs it with
  wiring three.js's MeshoptDecoder into the client's GLTF loading. It
  directly attacks wire bytes, our binding constraint for the mirror
  client, and it lives at bake-time, exactly where expensive work
  belongs.
- **Where it lands:** art bake pipeline, after manifest validation,
  before packaging. Gate: measured bytes-per-asset before/after on our
  corpus, plus decode-time check on target hardware (Meshopt is decode-
  cheap; verify rather than assume).

### gltfjsx — GLB to R3F components

- **What:** CLI converting GLB models into R3F JSX components with
  granular control over sub-meshes, bones, and materials.
- **License:** MIT (pmndrs). Clean.
- **Why adopt:** it is the standard R3F asset workflow, and our client
  is R3F. Runs on baked output; generated components get granular
  programmatic control without hand-writing boilerplate.
- **Caveat:** generated code must pass through our component
  conventions (naming, prop discipline). Build-time tool, never a
  runtime dependency.

### Leva — live-tweak GUI (dev-only)

- **What:** React-first floating control panel (`useControls`) for
  live-tweaking vectors, colors, and variables while testing a scene.
- **License:** MIT, verified against the repo (pmndrs/leva, 6.2k stars,
  879 commits). Clean.
- **Why adopt:** our client is R3F — Leva is the native live-tuner for
  it. Genuinely useful for dialing in visuals, lighting, and feel
  during development.
- **Scope discipline:** client dev overlay only. It does *not* replace
  the editor's uniforms-based inspector plan (different app, different
  job). Must be a devDependency / stripped from production builds —
  never shipped to players.

## PARK

### Theatre.js — visual motion-design editor

- **What:** in-browser timeline GUI (studio) + runtime core for
  designing camera moves and object sequences visually.
- **License: FLAG.** `@theatre/core` (runtime) is Apache-2.0 — fine.
  `@theatre/studio` (the visual editor — the whole point of the tool)
  is **AGPL-3.0**, which trips the permissive-only constraint. There is
  also ownership churn (forks shipping as `@tomorrowevening/*`
  packages) — maintenance status needs a check before any commitment.
- **Why park, not reject:** the core license is clean and the use case
  (visual camera/cinematic sequencing) is real — but no cinematics or
  sequenced-animation system exists yet to need it. Revisit when the
  editor actually needs timeline authoring, with the AGPL-studio
  question answered first.

### Needle Inspector for three.js — scene-graph debugger

- **What:** Chrome extension mapping the live scene-graph hierarchy of
  any three.js / R3F page; inspect materials, edit values live.
- **License:** UNVERIFIED. Check before installing.
- **Why park:** it complements, not duplicates, Spector.js (scene-graph
  inspection vs. frame capture — different jobs, both dev-only). No
  technical objection; the license check is the gate.

## WATCH

### GSAP 4 — programmatic timelines

- **What:** the standard JS animation/timeline library; v4 announced at
  three.js conf 2026, first major since GSAP 3 (2019). Now free
  following the Webflow acquisition (confirm exact license text before
  vendoring).
- **Why watch, not adopt today:** our animation runtime is ozz/three.js
  mixer — GSAP is not a 3D-engine concern. Its candidacy is editor UI
  and client HUD tweens. Revisit when GSAP 4's feature list is public
  and a concrete UI animation need exists.

## Fit summary

| Tool | Verdict | Lands in | License |
|---|---|---|---|
| gltfpack | ADOPT | bake pipeline | MIT ✓ |
| gltfjsx | ADOPT | client asset workflow | MIT ✓ |
| Leva | ADOPT (dev-only) | R3F client dev overlay | MIT ✓ |
| Theatre.js | PARK (license flag) | — | core Apache-2.0 ✓ / studio AGPL-3.0 ✗ |
| Needle Inspector | PARK (license check) | — | unverified |
| GSAP 4 | WATCH | — | free post-Webflow; confirm text |

Highest value per effort: **gltfpack** — it completes a loop we already
half-own (decoder shipped, no blessed encoder) and attacks our binding
constraint directly.
