# Procedural Buildings — adoption into decomposition, synthesis, and the settlement bake

Written 2026-11-13 on Joey's direction. Seed: @githubsignals reel
(2026-10-04) — a web app that executes Blender Geometry Nodes
building generators in the browser: a Parisian apartment, a New York
corner tower, and a Chinese residential block, parameterized (floor
count, balcony type, window detail), with its math verified against
Blender itself. Source repo verified 2026-11-13:
`achrefelouafi/ProceduralBuildingsThreeJS` — **MIT**, TypeScript,
133 stars. Joey's proposal, adopted as the design below: take
Blender references, generate variations quickly, place them through
the settlement system so variety happens at bake time; fold the
texture-mapping pass into the same step for personality (vines, moss,
lichen, sun-dried, cracking, dirt); use gaussian splatting to give
vegetation spillover a soft 3D texture where plants run from
buildings to ground and across to neighbouring structures.

## Why this solidifies the synthesis pipeline

MODEL-SYNTHESIS-MAP.md's standing blocker for building assemblies:
*no part-assembly example corpus yet.* PR #437 proved decomposition
on a dungeon (598 unique parts, learned adjacency grammar). What was
missing is a corpus of buildings that are **already programs**.

A Geometry Nodes graph is exactly that: a parametric assembly —
parts, sockets, and a knob space (floors, balconies, window styles)
in one artifact. Decomposition therefore gains a second mode:

- **Static decomposition** (existing): mesh in → parts + grammar out.
- **Parametric decomposition** (new): a GN reference in → parts +
  grammar + **the parameter space the reference itself defines** out.

The synthesis template stops being "an arrangement of parts" and
becomes "an arrangement of parts *as a function of knobs*." One
reference is a family of buildings.

## The bake chain (one pass, five stages)

1. **Template intake.** A building reference (Blender GN graph, or a
   modeled building decomposed statically) becomes a synthesis
   template: part set, adjacency grammar, knob space with ranges and
   per-knob variation weights.
2. **Settlement placement.** The town bake (Watabou CITY method:
   wards, gate/road skeleton, frontage) assigns each lot a template
   family by ward character — a district reads as one architectural
   family with internal variety, not a parts salad. Placement data
   per lot: template id, seed, knob ranges narrowed by district
   rules (height bands near gates, richer trim on market frontage).
3. **Variation roll.** Per building, the bake rolls its knobs from
   the lot seed — floors, balcony type, window detail, roof form —
   inside the grammar, so every result is a legal building.
   Deterministic: same seed, same town, hash-tested like every other
   bake stage.
4. **Texture-mapping pass (personality).** The Phase 2 masking
   machinery (height / slope / moisture / biome / erosion masks)
   extends to building instances, driven by world context:
   moisture + shaded aspect → **moss and lichen** low on walls;
   sun exposure → **sun-dried** fading; settlement-held building
   **age** → **cracking, dirt** at the base, soot near chimneys,
   worn thresholds. Age is settlement data, so weathering is
   history, not noise — a founded-last-year ward looks new.
5. **Spillover detail layers.** The shared detail-layer core (dungeon
   prompt Phase 3) gains a third context — *structure surface* —
   alongside dungeon-interior and terrain-chunk. **Vines** grow at
   bake from ground contact points up wall faces, steered by the
   moisture mask and aspect, and continue across the seam onto the
   ground and adjacent structures: one growth pass, no visible
   boundary between "building decoration" and "terrain decoration."

Every stage writes 5W1H provenance per building: template, seed,
knob values, weathering inputs, layer passes — the editor can answer
"why does this house look like this" field by field.

## Execution route for the node graphs

- **Route B (adopted for the settlement path): TS re-implementation,**
  verified against Blender — the reel's own method, and its MIT repo
  is the proof of feasibility plus a starting corpus of three
  families. Keeps the bake in our TS world (bake-time code stays JS
  by our own rule) with no Blender dependency in the pipeline.
- **Route A (authoring side, stays open): Blender headless in the
  toolchain** for artists to build new references in real GN, which
  are then ported (Route B) or variant-baked directly. Not the
  runtime path.

## Gaussian splatting — where it honestly fits

Spark is already our splat renderer candidate (shader R&D Exp 11,
the leading bet). This proposal is a *new use* for it: not scene
capture, but **bake-generated splat clouds as a softness layer for
organic spillover** — the vine mass where a building meets the
ground, moss clumps, ivy thickness — synthesized procedurally from
the same growth simulation that places the detail layers (density
field → splats), palette-held to the world.

Standing discipline applies: **this enters through the shader R&D
cost/benefit gate, as an experiment, not an adoption.** Known costs
to beat: splats don't take cel shading like the surrounding meshes
(the style question is the experiment's first test — palette-snapped
stylized splats vs the photoreal lean splats ship with), sorting and
overdraw at density, memory per cloud. The defined experiment: one
building, one vine spillover, three treatments side by side —
cross-quad detail layers (the production route today), splat
overlay, hybrid (quads for structure, splats for mass) — measured
and screenshot-compared. Until a treatment wins that gate, spillover
ships as detail-layer geometry and the splat lane stays R&D.

## What this changes in existing plans

- MODEL-SYNTHESIS-MAP: the building-corpus blocker gets a named
  resolution path (parametric decomposition of GN references).
- DUNGEON-DETAIL-BAKE-BUILD-PROMPT: Phase 3's detail-layer core
  gains the structure-surface context; Phase 2's masks gain building
  instances as subjects. (Addendum, not a rewrite — the prompt's
  phases stand.)
- Settlement bake: templates + knob ranges become placement data;
  building age joins settlement state as a weathering input.

## Open items

- First template family: port one of the MIT repo's three (Parisian
  block is the richest knob space) vs author our own reference in
  the game's style first. Style gate argues ours-first; corpus
  speed argues port-first. Joey's call.
- Splat experiment scheduling: inside the existing Exp 11 line, on
  Joey's word.
