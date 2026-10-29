# Shader & FX Extended — Library Evaluations (Companion to the R&D Bundle)

**Date:** 2026-10-04
**Status:** Evaluations, not decisions. Nothing here merges on its own.
**Relation to the bundle:** This document extends the Shader & FX R&D program
(`R&D-INDEX.md` and its five documents). It evaluates four external libraries
Joey surfaced in October 2026 against the program's cost/benefit rubric
(frame-ms budget, GPU-memory delta, mandatory quality-tier fallback), maps
each to the existing experiment program, and records the open art-direction
question they raised. Read `R&D-INDEX.md` first; this file assumes it.

**A correction to an earlier assessment (recorded here for the audit trail):**
in chat on 2026-10-04, three-pinata/Three-VFX were initially assessed against
"the engine is WebGL." The bundle's stated target is `three/webgpu` +
`three/tsl` with WebGL2 fallback (`SHADER-FX-DEEP-DIVE.md` §1). The corrected
position: WebGPU-first is the R&D direction, so a WebGPU-native library is
not disqualified on renderer grounds — it is evaluated on maturity, fit, and
cost like everything else. The per-library verdicts below supersede the
chat-speed versions.

---

## §1. The architectural principle: server-authoritative triggers, client-side presentation

All four evaluations below converge on one principle, which is stated here
once and referenced per library. It is also independently the industry
consensus for authoritative multiplayer:

> **The server decides *that* something happened and *with what seed*.
> The client decides *how it looks*.**

The server owns canonical game state — positions, damage, deaths, rewards —
and clients must never be the sole authority for game outcomes (Fairtick;
Kecek). For shared presentation specifically, the correct replication
payload is "the causes and state of shared presentation: seed/parameters,
authority time samples, schedules, and compact impact events," with
particles, camera effects, and decorative detail generated locally (Icy0u).
This is compact network traffic, and it preserves determinism: the same
seed plus the same event reproduces the same visuals on every client, with
replays falling out for free (Mighty840).

Concretely for this engine, every FX integration below follows the same
contract:

| Layer | Owns | Examples |
|---|---|---|
| **Server (authoritative)** | The event, its tick, its seed, gameplay consequences | `ObjectDestroyed(entity, seed, impactPoint)`, `SpellCast(caster, spellId, target, tick)` |
| **Client (presentation)** | Mesh fracturing, particle spawning, shader uniforms | three-pinata fracture with the server's seed; VFX burst at the event position |
| **Shared deterministic input** | World/chunk seeds, so ambient FX (grass placement) matches everywhere | GrassField scatter driven by chunk seed |

Anything that can "push, damage, conceal a necessary cue or change rewards
needs an authoritative rule and consistent representation" (Icy0u). Pure
decoration (grass blade #4,102's exact lean) needs no authority at all —
only a shared seed.

---

## §2. three-pinata — real-time mesh fracturing and slicing

### §2.1 Overview

three-pinata is a Three.js library for fracturing and slicing meshes in real
time directly in the browser (Greenheck). Core API: `DestructibleMesh`
extends `THREE.Mesh` with `fracture()`, `slice()` / `sliceWorld()`, and
`dispose()`. Fracture methods: 3D or 2.5D Voronoi tessellation, or fast
plane-based "simple" fracturing. Fragments are returned as new
`DestructibleMesh` instances, so refracturing (progressive destruction) is
supported with generation tracking handled externally via `userData`.

- **License:** MIT (Greenheck) — clean for commercial use.
- **Maturity:** 437 stars, 47 forks, 74 commits, 2 releases. By David
  Greenheck, an established Three.js educator. Stable API surface.
- **Dependencies:** Three.js ≥ 0.158 as a peer dependency. No native
  modules, no build-time codegen.

### §2.2 Technique deep dive

**Voronoi fracturing** is the industry-standard stochastic fracture method:
a set of seed points partitions the mesh into convex cells, each cell
becoming a fragment (Oh et al.; Raghavachary). The stochastic quality of
Voronoi diagrams is what makes fractures read as natural rather than
grid-cut (Müller et al.). Convexity is a feature, not just a limitation —
convex fragments admit real-time collision detection cheaply (Zafar et al.).

The important architectural context is *when* the fracture is computed.
Industry practice splits three ways (Issacl891):

1. **Pre-fractured (Unreal Chaos):** artists break objects in-editor;
   runtime swaps the whole mesh for pre-made pieces. Fastest, least dynamic.
2. **Hierarchical (NVIDIA Blast):** objects pre-fractured into a tree of
   chunks; runtime activates the relevant level by impact force.
3. **Runtime Voronoi (three-pinata, Eris):** the diagram and mesh
   generation are computed at fracture time, allowing dynamic,
   unpredictable patterns — including impact-point-concentrated seeds
   (Eris; three-pinata's `impactPoint`/`impactRadius` options).

three-pinata is firmly in camp 3, which is the right camp for an MMO: no
artist pre-authoring per destructible, and every client can reproduce the
fracture from the same seed. Its `seed` option is the load-bearing feature
for §1 — the server ships the seed, clients reproduce identical fragments.

Notable API details for integration:

- **Dual materials:** outer surfaces keep the original material; interior
  fracture faces get a separate material (fresh stone, splintered wood).
  This matches the two-submesh convention used by Unity fracturing tools
  (Sinanata).
- **Impact-based fracturing:** seeds cluster within a radius of the impact
  point — localized breaks read correctly for bullets and melee hits.
- **Plane slicing** (`slice`/`sliceWorld`): arbitrary-plane cuts in local
  or world space. Enables sword-slash bisection visuals, separate from
  shattering.
- **Requirements:** meshes should be manifold/watertight for clean
  fragments (Greenheck, "Important Requirements"). The art pipeline must
  guarantee this for anything flagged destructible.

### §2.3 Verdict

**Adopt as the client-side destruction renderer, behind server-authoritative
destruction events.** No existing experiment covers destruction; this fills
a real gap.

The server needs only a lightweight destruction model: which entity broke,
fragment count, seed, impact point. three-pinata handles the Voronoi math,
dual materials, and fragment lifecycle on the client. Proposed wire event:

```
ObjectDestroyed { entity, tick, seed, fragmentCount, impactPoint, impactRadius }
```

All clients reproduce identical fragments from the seed. Fragments are
pure presentation — they never feed back into physics or gameplay state.

### §2.4 Cost/benefit (per the program rubric)

- **Frame-ms:** fracture computation is a one-time CPU cost at the event
  (Voronoi is O(n²) in fragment count — Sinanata — so cap fragment counts;
  typical 16–50 fragments fracture in milliseconds). After fracturing,
  fragments are ordinary meshes: N draw calls for N fragments, each cheap.
  Mitigation: fragment budget per event, distance culling, fade-and-dispose
  (fragments are transient by design).
- **GPU-memory delta:** one blade/fragment geometry set per fracture event,
  disposed via `dispose()`. Transient — no persistent VRAM growth if the
  lifecycle is enforced.
- **Quality-tier fallback:** `low` tier disables refracturing (generation >
  1), caps fragment counts, and shortens fragment lifetime. Cleanly gatable.

### §2.5 Integration notes

- Fragments must respect the engine's chunk/entity lifecycle: parent the
  fracture to the destroyed entity's chunk, dispose on chunk unload.
- Physics: fragments are visual. If gameplay needs debris collision
  (blocking paths), that is a server-side decision with its own (much
  simpler) representation — never the Voronoi fragments themselves.
- Proposed experiment: **Exp 12 — Seeded destruction events** (see §7).

---

## §3. stylized-components — GrassField (stylized grass)

### §3.1 Overview

`GrassField` is one component of Christian Ortiz's *stylized-components*,
"a growing collection of real-time, anime-inspired rendering systems for
the web, built with Next.js, Three.js and React Three Fiber," each
"self-contained... written in custom GLSL" (Ortiz). The grass demo
(`stylized.cortiz.dev/grass`) shows a wind-animated field of instanced
blades and flowers with procedural dirt blending, rock trampling, and
per-blade shadows.

- **License:** MIT, with an attribution requirement (credit Christian Ortiz
  with a link back) (Ortiz). Clean for commercial use; attribution is a
  docs/README line.
- **Maturity:** 410 stars, 53 forks. Single-author creative-dev project,
  actively maintained (39 commits). Demo-quality code, not a hardened
  library — expect to vendor and adapt, not to npm-install and forget.

### §3.2 Technique deep dive

**Instanced blades, not texture cards.** Each blade is an individual tapered
polygon (close-up verified on the live demo); thousands are drawn in a
single instanced draw call. This is the standard high-quality approach:
GPU instancing collapses what would be tens of thousands of draw calls
into one (Xstrachey; Open-Realm WoW notes record ~47k draw calls collapsing
under instancing).

**Placement:** area-weighted sampling of ground-mesh triangles — pick a
triangle proportional to its area, then a uniform point inside it — so
every instance lands on the surface and `density` means instances per
world-unit². Placement is seeded: identical field on every reload (Ortiz,
"Instanced blades & flowers"). The seeded property is what makes it
deterministic-input-compatible per §1.

**Wind:** vertex-shader displacement weighted by blade height (tips move
most), phased by world position plus time — the canonical cheap wind. The
quadratic weighting (`height_t²`) and world-position phase are the same
pattern used across engines (Forge-GPU). WoW's production formula is the
same shape: `sin(uTime + dot(position.xy, ...)) * windWeight` with roots
fixed (Open-Realm). Exp 6 already plans exactly this; GrassField is a
reference implementation of it, plus extras.

**The dirt mask (the best idea in the component):** one procedural function
in world XZ — `groundDirt()` — is sampled by the ground material, the
blade shader, *and* the flower shader. The ground paints earth, blades
standing on dirt shrink and take its color, flowers are culled from it.
One shared source of truth; grass thins into bare earth with no hard edge
(Ortiz, "Ground colormap blending"). This is the composed-constraints
detail the art direction wants.

**Per-blade shadows:** three.js resolves shadows per fragment, which draws
a hard straight shadow line across blades mid-shadow. GrassField samples
*one* shadow value per blade, so each blade is entirely in or out of
shadow — the shadow edge becomes the grass's own jagged silhouette (Ortiz,
"Per-blade shadows"). This is both a visual and a perf consideration
(fewer shadow taps than per-fragment).

**Translucency:** an additive back-scatter lobe — blades glow when the
camera looks into the sun through them, strongest at thin tips, and
shadowed blades transmit nothing so the glow never leaks into shadow
(Ortiz, "Translucency"). Classic subsurface approximation, cheap in the
fragment shader.

**Rock trampling:** rocks are passed to the blade shader as world-space
spheres; blades inside are pressed flat *and splayed outward*. Bending on
top of flattening is what reads as trampled rather than mown (Ortiz, "Rock
trambling"). Note: rock positions are gameplay-adjacent data (they come
from worldgen) — the trampling spheres should derive from the world's
rock placements, not be hand-authored per scene.

**Season/sky presets:** named looks (Spring, Autumn) pushed into the
parameter panel; a `SkyDome` (procedural gradient, sun/moon, FBM clouds,
stars, aurora) drives scene lighting plus a full-screen color filter
(Ortiz, "Season presets," "Sky presets"). Direct hook for the engine's
season and day/night systems.

**Flowers:** cross-billboards (two quads at 90°) with petal alpha masks,
wind-animated, with a `customDepthMaterial` so shadows carry the flower
shape and sway instead of a static rectangle (Ortiz, "Shadow-casting
flowers").

**Scholarly grounding:** the instanced-blade + vertex-shader-wind
approach goes back to Bakay, Lalonde, and Heidrich's "Real Time Animated
Grass" (Eurographics 2002), which established vertex-shader displacement
of grass as the real-time method. Everything since is refinement of that
core.

### §3.3 Verdict

**Adopt the techniques; adapt the components.** The engine client is
R3F-based (`@react-three/fiber` 9, verified in `apps/client/package.json`)
with vanilla three.js render modules underneath (`apps/client/src/render/`),
so stylized-components' R3F structure is adaptable rather than requiring a
full port. What stays behind: the Leva debug panels and Next.js demo
scaffolding. What transfers: the raw GLSL (via `onBeforeCompile` injection
into the render modules) and the dirt-mask architecture.

This maps directly onto **Exp 6 (Wind vegetation)** as its reference
implementation, superseding the WoW-formula-only plan with: the dirt mask,
per-blade shadows, translucency, trampling, and season presets.

### §3.4 Cost/benefit (per the program rubric)

- **Frame-ms:** one instanced draw call; wind is vertex-shader ALU
  (negligible — Exp 6 budgets <0.3ms at 10k instances). Real costs:
  overdraw (blades overlapping at grazing angles) and the shadow pass.
  The per-blade shadow sample is cheaper than per-fragment.
- **GPU-memory delta:** one blade geometry + one instance buffer per
  chunk-field; trivial. No textures required (procedural).
- **Quality-tier fallback:** density (instances/m²) is the natural slider;
  translucency and per-blade shadows toggle off on `low`. Exp 6 already
  verdicts tier-gating (off on `low`).

### §3.5 Integration notes

- **Chunk lifecycle:** scatter on chunk load from the chunk seed, dispose
  on unload. The engine's scatter pipeline (spawn graphs → spawn tables)
  is the natural host; grass becomes a scatter-driven client visual.
- **Determinism input:** chunk seed → blade placement. All clients agree.
- **Rock trampling spheres** derive from worldgen rock placements.
- **Season presets** bind to the engine's season state; sky presets bind
  to the day/night cycle (the bundle's sky dome work is adjacent).

---

## §4. stylized-components — WaterFloor (anime water)

### §4.1 Overview

The sibling component in the same repo: a modular, layered anime water
system (Ortiz, "WaterFloor System"). Six passes: animated Voronoi seabed,
cel-shaded water surface, screen-space depth intersection, PDE wave
simulation, procedural sparkles, and a ripple event bus.

- **License:** MIT with attribution (same as §3).
- **Maturity:** same repo as §3 (410 stars). The water is the more complex
  system; more adaptation risk than the grass.

### §4.2 Technique deep dive

1. **Seabed:** animated Voronoi pattern below the surface, cells moving
   slower than the surface pattern for parallax depth (Ortiz).
2. **Surface:** cel-shaded water via **Voronoi F1 − SmoothF1** subtraction —
   the Blender node-graph technique recreated in GLSL — with a 3-stop
   color ramp (deep → mid → highlight), noise-distorted animated cells,
   and world-space XZ anchoring so the pattern doesn't swim with the
   camera (Ortiz).
3. **Depth intersection:** screen-space depth comparison — geometry is
   rendered to a depth-only target; a fullscreen plane at the water level
   draws a sharp white silhouette line plus soft halo where geometry
   crosses the plane. DPR-aware (Ortiz). This is the standard
   depth-fade/shoreline technique, anime-styled.
4. **Wave simulation:** three-pass GPU sim per frame — injection (ortho
   render of waterline geometry), ping-pong wave PDE
   (`h_next = 2·h_cur − h_prev + c²·∇²h`) with absorbing boundaries, and a
   display pass rendering gradient magnitude as additive rings (Ortiz).
5. **Sparkles:** GPU particles via `gl_PointCoord`, procedural 4-pointed
   stars, sine lifetime fade — no textures (Ortiz).
6. **Ripples:** a composable hook/event bus (`rippleStore`) — any object
   entering water emits anime ripple rings (Ortiz).

### §4.3 Verdict

**Evaluate against Exp 9 (Water), adopt selectively.** The surface shading
(Voronoi F1−SmoothF1, 3-stop ramp) and depth-intersection shoreline are
directly applicable to Exp 9's foam work. The full PDE wave simulation is
the expensive part — evaluate its frame-ms against Exp 9's budget before
committing; the foam-band energy fix in Exp 9 is a correctness fix that
stands regardless.

Note the demo's water is a contained pond/lake scene. The engine's water
needs (rivers, lakes, shorelines at chunk scale) are larger in scope —
the techniques transfer, the scene composition does not.

### §4.4 Cost/benefit (per the program rubric)

- **Frame-ms:** surface shading is one fullscreen-ish pass (cheap);
  depth intersection needs a depth prepass (moderate); the PDE sim is
  three passes per frame (the expensive item — measure before merging).
- **GPU-memory delta:** depth render target + two ping-pong height
  textures. Counted via `perf-stats.ts` gauges per the rubric.
- **Quality-tier fallback:** `low` tier drops the PDE sim (static rings
  only) and the sparkles; keeps surface shading + shoreline.

---

## §5. Three-VFX — GPU particle system

### §5.1 Overview

Three-VFX is a GPU-accelerated particle system for Three.js, built on
**WebGPU compute shaders**, with bindings for React Three Fiber (primary),
TresJS, Threlte, and experimental vanilla Three.js (Mustache-dev).
Features: GPU compute simulation, emitter shapes (point/box/sphere/cone/
disk/edge), bezier-curve control over lifetime properties, turbulence,
attractors, collisions, trails, soft particles, custom shaders.

- **License:** MIT (Mustache-dev) — clean.
- **Maturity:** **low.** 146 stars, 10 forks, 0 releases, created January
  2026. Vanilla Three.js support is explicitly experimental. This is the
  least mature of the four libraries by a wide margin.

### §5.2 Technique deep dive

The architecture is the right one for GPU particles: simulation in compute
shaders (position/velocity/lifetime integration on the GPU), rendering as
instanced quads or geometry — the same pattern the bundle's Exp 7 plans
with TSL compute (`instancedArray` + `storage` buffers, one dispatch + one
draw). The broader ecosystem confirms the direction: WebGPU compute is
"the same capability that powers... million-particle physics in native
engines," with the CPU not touching a single particle (Josphk). Three.js
r186's `three/webgpu` import gives WebGPU with automatic WebGL2 fallback,
and TSL compiles to both WGSL and GLSL (Songfeitong) — which is exactly
the bundle's authoring strategy (`SHADER-FX-DEEP-DIVE.md` §1).

**The correction from §0:** the bundle targets WebGPU-first, so
Three-VFX's WebGPU requirement is *aligned*, not disqualifying. What
disqualifies it today is maturity: 9 months old, no releases,
experimental vanilla support, single-maintainer risk. Exp 7 already plans
the in-house TSL-compute path with a three-nebula WebGL2 fallback —
Three-VFX would be buying an immature dependency to do what Exp 7 does
natively.

### §5.3 Verdict

**Do not adopt. Revisit in 12 months.** The need it serves (GPU particles)
is real and already owned by Exp 7. (Fit note: the client's R3F base means
Three-VFX's primary R3F binding would integrate cleanly — framework fit is
not the blocker.) The blocker is maturity: 9 months old, no releases,
single-maintainer risk. If Exp 7's in-house implementation stalls,
Three-VFX becomes the fallback candidate — re-evaluate on: a 1.0 release,
stable API, and a second maintainer or corporate backer.

### §5.4 Cost/benefit (per the program rubric)

Not applicable until re-evaluation — but the rubric items to check then:
compute dispatch ms at 50k particles vs Exp 7's target, storage-buffer
VRAM, and the WebGL2 fallback path (Three-VFX's CPU fallback vs the
bundle's three-nebula fallback).

---

## §6. Art direction: decided 2026-10-04 (partially)

**Locked:** low-poly, stylized. Both candidate renderings sit on a low-poly
base — this constrains asset budgets (vertex counts), favors techniques
that get richness from shading rather than geometry (the dirt mask, cel
ramps, translucency), and keeps the GPU-memory rubric easy to satisfy.

**Open:** anime/cel vs. PBR — "it just depends." The decision is deferred
to evidence, not vibes. Settle it with:

1. **Stills from Exp 5 (Material library)** — the same low-poly test
   assets rendered both ways (cel banding vs. physical shading), shot
   against the Exp 3 TAA baseline.
2. **Cost numbers** — cel shading is generally cheaper (simpler BRDFs,
   fewer lights), but the difference must be measured on the program's
   named hardware, not assumed.
3. **Asset fit** — whichever direction Joey's art inputs favor (hand-
   painted textures lean PBR-with-style-in-inputs; flat color palettes
   lean cel).

Until it is decided, keep shared work direction-agnostic: the dirt mask,
per-blade shadows, Voronoi water surface, and seeded destruction in this
document work under either rendering. Exp 5 is the decision point — it
should produce the A/B stills as an explicit deliverable, and the verdict
lands before Exp 2's lighting rig (which is the experiment most sensitive
to the choice).

---

## §7. Integration map and proposed experiments

| Library / system | Maps to | New experiment? |
|---|---|---|
| three-pinata destruction | *(none — new capability)* | **Exp 12 — Seeded destruction events** (proposed): server `ObjectDestroyed` event → client Voronoi fracture; fragment budget, fade/dispose lifecycle, tier gating |
| GrassField grass | Exp 6 (Wind vegetation) | Extend Exp 6: adopt dirt-mask architecture, per-blade shadows, translucency, trampling, season presets as acceptance criteria |
| WaterFloor water | Exp 9 (Water) | Extend Exp 9: evaluate Voronoi F1−SmoothF1 surface + depth-intersection shoreline against the foam-band work; PDE sim as stretch goal with its own frame-ms gate |
| Three-VFX particles | Exp 7 (GPU weather particles) | No new experiment; re-evaluate library in 12 months if Exp 7 stalls |

**Proposed: Exp 12 — Seeded destruction events.** Goal: the §1 contract
for destruction, end to end. Steps: (1) define the `ObjectDestroyed`
event schema (entity, tick, seed, fragmentCount, impactPoint/Radius);
(2) client-side three-pinata fracture from the event (vendored;
three-pinata is vanilla three.js and composes naturally inside the R3F
client); (3) fragment lifecycle (budget, fade, dispose,
chunk-unload safety); (4) determinism test (same seed → identical
fragments on two clients); (5) tier gating. Acceptance: <Xms fracture
time at 32 fragments (measure, don't borrow); zero gameplay-state
feedback from fragments (audit); `low` tier caps fragments and disables
refracture.

---

## §8. Rubric summary

| Library | Frame-ms | GPU mem | Tier fallback | Maturity | Verdict |
|---|---|---|---|---|---|
| three-pinata | One-time fracture cost (cap fragments); N cheap draw calls after | Transient; disposed | Clean gating | High (437★, stable API) | **Adopt** (Exp 12) |
| GrassField | ~0.3ms/10k instances (Exp 6 budget); overdraw + shadow pass are the costs | Trivial (procedural) | Density slider; features toggle | Medium (demo code, vendor it) | **Adopt techniques** (extend Exp 6) |
| WaterFloor | Surface cheap; depth prepass moderate; PDE sim expensive — measure | Depth RT + ping-pong textures | Drop sim/sparkles on low | Medium | **Adopt selectively** (extend Exp 9) |
| Three-VFX | (re-evaluate) | (re-evaluate) | (re-evaluate) | Low (146★, 0 releases, 9 months old) | **Do not adopt**; revisit in 12 mo |

All four are MIT-licensed. stylized-components carries an attribution
requirement (credit + link); three-pinata and Three-VFX are plain MIT.

---

## §9. New findings (2026-10-05)

Four items surfaced 2026-10-05 that feed open experiments. None overturn an
existing verdict; they extend Exp 6's technique shelf and give Exp 11 its
first concrete memory budget plus an eval candidate.

### §9.1 Grassworks v1.1.0 — consistency-first grass LOD

The weekend's v1.1.0 update fixes grass LOD pop-in by building consistency
first: lower LODs thin blades from the higher-LOD population while keeping
the surviving blades in their exact positions, then spatial dithering
dissolves between LOD levels instead of swapping the whole population at
once. This is a second, distinct LOD strategy next to the techniques already
adopted for Exp 6 (§3): GrassField's approach leans on dirt masks and
per-blade features, while Grassworks' consistency-first thinning + dithered
transition attacks the same pop-in problem from the geometry side.
Candidate: adopt the thinning-consistency rule as an Exp 6 acceptance
criterion alongside the existing per-blade techniques; the spatial dither
needs its own frame-ms measurement before merging, per the program rubric.

### §9.2 Deterministic TSL grass — seeded scatter, prefix-safe quality tiers

Kissinger's threejs-field-grass draws 126,000 blades in one instanced draw
per layer, with a deterministic scatter bake and prefix-safe quality tiers.
The deterministic bake is the notable part for this program: a seeded grass
scatter is exactly the kind of client-side determinism the
server-authoritative contract (§1) can live with — the server ships biome +
seed, every client grows the same field. Relevance: Exp 6 technique shelf;
the prefix-safe tiering is also a clean model for the quality-tier fallback
the rubric demands.

### §9.3 Splat budget number for Exp 11

ARGO's 2026 production workflow guide puts a phone-sized Gaussian splat
scene at ~1M splats / ~17.6 MB in SOG, with larger scenes cut into streamed
levels (Spark 2.0's RAD, Cesium 3D Tiles). This gives Exp 11 its first
concrete memory budget: ~17.6 MB per million-splat tile, streamed like map
data. No verdict change — Spark remains the leading bet — but the
cost/benefit gate now has a number to measure against.

### §9.4 Gaussian-Splat-Lite — a license-clean Spark sibling worth an eval run

Gaussian-Splat-Lite (Apache-2.0) is a three.js Gaussian splatting renderer
with WebGPU and a WebGL2 fallback, streaming RAD and SOG scenes through a
per-frame splat budget with smooth LOD fades. The author credits Spark and
SuperSplat as the architectural models, so it reads as a license-clean
alternative evaluator for Exp 11 rather than a Spark replacement candidate.
Relevant facts from the repo: streaming is exposed as schedulers (RAD /
SOG) with a configurable splat budget and fade duration; it also offers
stochastic rendering with temporal anti-aliasing, offscreen capture to
cube/env maps, and SDF-based recolor/hide edits. Caveats for the verdict
rubric: the repo is young (created August 2026, ~160 stars, 2 months old at
this writing — the same maturity class that parked Three-VFX), and dev
builds require Rust + the wasm target for the decoder. No verdict change —
Spark remains the leading bet — but this is the first Apache-2.0 streaming
splat renderer with an explicit per-frame budget and dual-renderer support,
so it belongs on Exp 11's eval list behind Spark.

### §9.5 KHR_gaussian_splatting — splats become glTF citizens (2026-10-09)

Khronos announced `KHR_gaussian_splatting` as a release candidate in
February 2026: Gaussian splats stored as native glTF 2.0 point primitives
(position, rotation, scale, opacity, spherical-harmonics color), backed by
Google, NVIDIA, Apple, and Bentley, with Niantic, Cesium, and Esri behind
it. Still RC as of October 2026 — the attribute set is settled but the spec
text can still move; ratification was targeted Q2 2026.

Why it matters for Exp 11: the art pipeline already speaks glTF, so
standardized splats mean one asset path — same validators, same bake
discipline, same manifest thinking — instead of PLY/SPZ as a separate
sidecar asset class. It converges *toward* Spark (which already handles
SOG, a glTF-container splat format), not away from it: a tailwind for the
leading bet, not a new decision.

The open question is compression, and it is exactly our binding
constraint: the base extension is intentionally lossless (separate
accessors per attribute), which is heavy on the wire for multi-million-
splat scenes. The SPZ companion (`KHR_gaussian_splatting_compression_spz_2`)
is still draft — the working group is openly asking for compression
contributions. That extension decides the wire-bytes-per-vista number.
Watch it; do not build on the draft.

Pipeline note: a glTF carrying splat extensions needs its own import path
— mesh loaders choke on it (cf. the LichtFeld assimp issue, Aug 2026).
When the bake grows splat support, target the KHR extension as the
interchange format, with a splat-aware reader alongside the mesh loader.

No verdict change: Spark remains the Exp 11 bet, eval still queued. Watch
item: compression-extension ratification.

### §9.6 SDR-to-HDR via WebGPU shaders — technique reference only (2026-10-09)

An enthusiast shipped an open-source Chromium extension doing SDR-to-HDR
video conversion on the GPU through WebGPU shaders — an open alternative
to Nvidia RTX Video HDR — using manual inverse tone mapping instead of
machine learning, reportedly written with the Opus 5.5 model.

Verdict: **bookmark the technique, do not adopt the code.**

- Wrong shape: a Chromium video extension is not an engine component.
- Wrong problem for us: inverse tone mapping expands *legacy SDR content*
  to HDR. A game engine generating its own frames should render HDR
  natively (half-float render targets, tone map at the end of the post
  chain) — strictly better quality, and the tone-mapping stage is already
  owned by our tier-gated post-processing stack.
- WebGPU-only; our client is WebGL2-first with WebGPU still an open
  decision.
- License unverified; check before lifting any code.

What earns the bookmark: a shipped reference for the output-transform
shader on the day WebGPU lands and HDR display output gets evaluated
(likely as part of the Exp 5 anime/cel-vs-PBR stills). Secondary signal:
AI-written shader code shipping to real users is a data point for our
shader R&D workflow, not for this technique's adoption.

---

## Works Cited

ARGO. "Gaussian Splatting Production Workflow." *ARGO Blog*, 2026,
https://ar-go.co/blog/gaussian-splatting-production-workflow/.

Bakay, Brook, Paul Lalonde, and Wolfgang Heidrich. "Real Time Animated
Grass." *Eurographics 2002 Short Presentations*, 2002,
https://vccimaging.org/Publications/Bakay2002RAG/Bakay2002RAG.pdf.

Eris — Voronoi Fracture. *Unity Asset Store*,
https://assetstore.unity.com/packages/tools/physics/eris-voronoi-fracture-396978.

Fairtick — CLAUDE.md. GitHub, Vitaliiermolaev,
https://github.com/vitaliiermolaev/fairtick/blob/HEAD/CLAUDE.md.

Forge-GPU — Grass Rendering Skill. GitHub, Rosygamestudio,
https://github.com/rosygamestudio/forge-gpu.

Grassworks. "High-Performance Grass Rendering in Three.js / WebGPU."
*three.js Discourse*,
https://discourse.threejs.org/t/high-performance-grass-rendering-in-three-js-webgpu/94175.

Greenheck, David. *three-pinata*. GitHub,
https://github.com/dgreenheck/three-pinata.

Icy0u. "Replication Research." *water-everywhere*, GitHub,
https://github.com/icy0u/water-everywhere/blob/HEAD/planning/REPLICATION_RESEARCH.md.

Issacl891. *voronoi-fracture-716*. GitHub,
https://github.com/issacl891/voronoi-fracture-716.

Josphk. "Module 12 — WebGPU Cutting Edge." *love-2-vibe* Wiki, GitHub,
https://github.com/josphk/love-2-vibe/blob/HEAD/wiki/engines/r3f/module-12-webgpu-cutting-edge.md.

Kecek05. "Unity TD Netcode Skill." *tcc-puc*, GitHub,
https://github.com/kecek05/tcc-puc/blob/HEAD/.claude/skills/unity-td-netcode/SKILL.md.

Kissinger, Matthew. *threejs-field-grass*. GitHub,
https://github.com/matthew-kissinger/threejs-field-grass.

Liu, William. *Gaussian-Splat-Lite*. GitHub,
https://github.com/williamliu-1997/gaussian-splat-lite.

Mighty840. "A Pure, Seeded Game Engine Gives You Multiplayer Almost for
Free." *DEV Community*, 2026,
https://dev.to/mighty840/a-pure-seeded-game-engine-gives-you-multiplayer-almost-for-free-4412.

Müller, Matthias, et al. "Fracture Modes for Realtime Destruction."
*arXiv*, 2021, http://arxiv.org/pdf/2111.05249v5.

Mustache-dev. *Three-VFX*. GitHub,
https://github.com/mustache-dev/Three-VFX.

Oh, Young-Joon, et al. "Voronoi Fracture." Cited in Müller et al.,
"Efficient Clustering of Heterogeneous Fracture," 2012.

Open-Realm. "Static Grass and Height Atlas." GitHub, Corepunch,
https://github.com/corepunch/open-realm/blob/HEAD/docs/games/world-of-warcraft/static-grass-and-height-atlas.md.

Open-Realm. "Grass Rendering System." GitHub, Sookyboo,
https://github.com/sookyboo/open-realm/blob/HEAD/docs/games/world-of-warcraft/grass-rendering-system.md.

Ortiz, Christian. *stylized-components*. GitHub,
https://github.com/cortiz2894/stylized-components.

Raghavachary, Saty. "Fracture Generation." Cited in Müller et al., 2012.

Sinanata. *unity-mesh-fracture*. GitHub,
https://github.com/sinanata/unity-mesh-fracture.

Songfeitong. "WebGPU Three.js Migration Guide." *pretty-lattice*, GitHub,
https://github.com/songfeitong/pretty-lattice/blob/HEAD/docs/notes/webgpu-threejs-migration-guide.md.

Xstrachey. *instanced-grass-demo*. GitHub,
https://github.com/xstrachey/instanced-grass-demo.

Zafar, Nafees, et al. "Convex Decomposition." Cited in Müller et al.,
2010.
