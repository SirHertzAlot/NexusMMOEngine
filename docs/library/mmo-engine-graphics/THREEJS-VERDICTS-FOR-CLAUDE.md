# Three.js Verdicts — Comprehensive Findings for Claude

**Compiled:** 2026-10-23
**For:** Claude, to build against directly.
**Status of everything in this document:** these are **research findings
and recommendations**, compiled from the project's own review documents.
A verdict here is **not** a claim that anything is implemented, merged,
or shipped. Where a later spike changed a verdict, both the original and
the update are shown with dates. Anything that could not be verified
from the sources is labeled **UNVERIFIED** inline and collected in §8.

**This document authorizes nothing.** No pushes, no merges, no branch
changes. It is a handoff reference only.

**Sources (read exhaustively for this compilation):**

- Shader R&D set — `~/workspace/your_files/mmo-engine-shader-rnd/`:
  `R&D-INDEX.md` (the verdict rubric), `SHADER-FX-EXTENDED.md`
  (per-library evaluations, 2026-10-04/05 + §9 findings through
  2026-10-09), `THREEJS-CONF-2026-FINDINGS.md`, `SHADER-EXPERIMENTS.md`
  (experiment specs + incumbent ground truths), `STYLIZED-RENDERING-DNA.md`.
- Client review set — `~/workspace/your_files/mmo-engine-client/`:
  `THREEJS-TOOLING-REVIEW.md` (2026-10-09), `THREEJS-DIRECTORY-REVIEW.md`
  (2026-10-09), `THREEJS-TOOLING-FINDINGS.md` (2026-10-10, the compiled
  build order incl. the animouse deep review), `TOOLING-INTEGRATION-PLAN.md`.
- Cross-checks — `~/memory/people/*.md` per-library pages (used to
  cross-check and to record post-report spike outcomes; they do not
  replace the report sets). Entries sourced only from a people page are
  marked **[cross-check]**.
- GitHub — repo `SirHertzAlot/NexusMMOEngine`, checked live 2026-10-23
  (see §7).

---

## 1. The verdict rubric (the cost/benefit gate)

Every verdict below was issued under the shader program's gate
(`R&D-INDEX.md`, `SHADER-EXPERIMENTS.md` §0.4). Joey's directive:
**push graphics as far as they can go — inside a hard cost/benefit
gate.** No technique or library merges on stills or vibes. Each must
declare, measured on named hardware (never borrowed numbers):

1. **Frame-ms budget** — per-experiment cost ceiling.
2. **GPU-memory delta** — new textures, render targets, shader programs.
3. **Mandatory quality-tier fallback** — on/off state registered per
   tier in `quality.ts`; the `low` tier must never regress. A technique
   that can't be cleanly gated off doesn't merge.

Plus the standing license rule: **permissive licenses only** (MIT /
Apache-2.0 / CC0 / BSD). AGPL and non-commercial licenses are hard
stops, and several verdicts below turned on exactly that. And the
architectural contract for anything multiplayer-visible: **the server
decides *that* something happened and with what seed; the client
decides *how it looks*** (`SHADER-FX-EXTENDED.md` §1).

Verdict vocabulary: **ADOPT** (integrate; execution spec exists),
**ADOPT SELECTIVELY** (named parts only), **EVALUATE** (spike first,
pass bar defined), **PARK** (do not touch; revisit condition recorded),
**WATCH** (no action; check back on a trigger), **BOOKMARK** (manual
reference, no integration), **REJECT** (evaluated and closed).

---

## 2. ADOPT

### 2.1 gltfpack (meshoptimizer CLI) — geometry encode path
- **Source:** client set, `THREEJS-TOOLING-REVIEW.md`; build order in
  `THREEJS-TOOLING-FINDINGS.md` Phase 1 / `TOOLING-INTEGRATION-PLAN.md`.
- **Reason:** the client already used meshoptimizer for LOD
  *simplification* only, with no compressed-asset decoding wired.
  gltfpack gives the bake a blessed encode path and attacks wire bytes,
  the mirror client's binding constraint. Lives at bake-time, where
  expensive work belongs.
- **License:** MIT (Arseny Kapoulkine), verified.
- **Cost gate:** measured bytes-per-asset before/after on the project
  corpus (gate: ≥40% reduction on the baseline sample or a written
  reason per asset), zero visual delta, decode-time check on target
  hardware. Pinned v1.3 (2026-10-10 appendix).

### 2.2 gltf-transform — texture conversion + scene cleanup stage
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md` ("the single
  biggest find"); Findings Phase 1c.
- **Reason:** completes the compression story gltfpack starts —
  gltfpack owns geometry, gltf-transform owns textures (WebP baseColor,
  UASTC KTX2 for data slots) and cleanup (`prune`/`dedup`, always on).
  Also the tool that performs the KTX2 evaluation (§4.8).
- **License:** MIT (donmccurdy), verified against the repo.
- **Cost gate:** texture bytes before/after recorded per asset in the
  manifest; VRAM estimate down or flat; zero visual delta. Pinned
  `@gltf-transform/cli` 4.5.1.

### 2.3 gltfjsx — GLB → R3F component workflow
- **Source:** client set, `THREEJS-TOOLING-REVIEW.md`; Findings Phase 2.
- **Reason:** the standard R3F asset workflow, and the client is R3F.
  Runs on baked output; generated components give granular control over
  sub-meshes, bones, materials.
- **License:** MIT (pmndrs).
- **Cost gate:** build-time tool only, never a runtime dependency;
  generated code must pass project component conventions; one asset
  end-to-end pixel-identical to the pre-component render. Pinned 6.5.3.

### 2.4 Leva — live-tweak panel, R3F client (**dev-only**)
- **Source:** client set, `THREEJS-TOOLING-REVIEW.md`; Findings Phase 3.
- **Reason:** the native live-tuner for an R3F client — dialing
  visuals, lighting, and feel during development.
- **License:** MIT (pmndrs), verified against the repo.
- **Cost gate / scope discipline:** devDependency only, mounted behind
  `import.meta.env.DEV` so production *cannot* include it by
  construction; automated prod-bundle check for zero Leva bytes. Never
  shipped to players. Pinned 0.10.1.

### 2.5 lil-gui — live-tweak panel, vanilla editor (**dev-only**)
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings Phase 3.
- **Reason:** Leva is React-first and belongs to the R3F client; the
  editor is vanilla three.js and lil-gui (the dat.gui successor) is its
  equivalent — zero-drama live tweaking for editor development.
- **License:** MIT (well-established; the review notes "confirm on
  adoption"). Same dev-only scope discipline as Leva. Pinned 0.21.0.

### 2.6 Gobkit — CC0 placeholder characters
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings Phase 4.
- **Reason:** 69 rigged + animated low-poly GLBs with a no-auth JSON
  manifest — the exact combination that unblocks animation,
  retargeting, and crowd prototyping before real art exists. Test bed
  for the animouse spike (§5) and the compression pipeline.
- **License:** CC0, stated on the directory card.
- **Cost gate:** placeholders, never shipped art; gate = ≥3 characters
  load, play clips, and survive the Phase 1 compression pipeline.
  **[Cross-check note]:** the people page records the library has since
  grown (149 models, 108 rigged/animated) and flags the animal packs as
  AI-generated — relevant if a no-AI-art policy is applied; the refresh
  of Joey's copy was still pending his word at last record.

### 2.7 three-pinata — real-time mesh fracturing / slicing
- **Source:** shader set, `SHADER-FX-EXTENDED.md` §2 (full evaluation).
- **Reason:** fills a real gap — no experiment covered destruction.
  Runtime Voronoi fracturing with a `seed` option is the right camp
  for an MMO: no per-asset artist pre-authoring, and every client
  reproduces identical fragments from the server's seed under the
  §1 contract. Proposed wire event:
  `ObjectDestroyed { entity, tick, seed, fragmentCount, impactPoint, impactRadius }`.
  Fragments are pure presentation — never physics or gameplay state.
- **License:** MIT (David Greenheck), clean.
- **Cost gate (rubric):** frame-ms = one-time fracture cost at the
  event (Voronoi is O(n²) in fragment count — cap fragments, typical
  16–50; afterwards N cheap draw calls); GPU memory = transient,
  disposed via `dispose()`, no persistent VRAM growth if the lifecycle
  is enforced; tier fallback = `low` disables refracturing (generation
  > 1), caps counts, shortens fragment lifetime. Art-pipeline
  precondition: destructible meshes must be manifold/watertight.
  Proposed as **Exp 12 — Seeded destruction events**.

### 2.8 stylized-components — GrassField (grass techniques)
- **Source:** shader set, `SHADER-FX-EXTENDED.md` §3.
- **Verdict shape:** **adopt the techniques; adapt the components.**
  Demo-quality code, not a hardened library — vendor and adapt, don't
  npm-install and forget. Transfers: the raw GLSL (via
  `onBeforeCompile` into the render modules) and the architecture.
  Stays behind: Leva panels, Next.js scaffolding.
- **What transfers:** instanced blades (one draw call); seeded
  area-weighted placement (deterministic — server ships chunk seed,
  every client grows the same field); height-weighted vertex wind;
  **the dirt mask** — one procedural world-XZ function sampled by
  ground, blade, and flower shaders so grass thins into bare earth
  with no hard edge; per-blade shadow sampling; translucency
  back-scatter; rock trampling (spheres derived from worldgen rock
  placements, not hand-authored); season/sky presets bound to the
  engine's season and day/night state.
- **Maps to:** **Exp 6 (Wind vegetation)** as its reference
  implementation; the items above become Exp 6 acceptance criteria.
- **License:** MIT **with attribution requirement** (credit Christian
  Ortiz with a link — a docs/README line).
- **Cost gate (rubric):** frame-ms ≈ one instanced draw call, wind is
  vertex ALU (Exp 6 budget <0.3 ms at 10k instances); real costs are
  overdraw and the shadow pass (per-blade sampling is the cheaper
  option); GPU memory trivial (procedural, no textures); tier fallback
  = density slider, translucency and per-blade shadows off on `low`.
  Scatter rides the chunk lifecycle (load from chunk seed, dispose on
  unload) through the existing scatter pipeline.

### 2.9 ozz-animation — skeletal animation runtime (bake + native)
- **Source:** recorded as already-decided in the client set
  (`THREEJS-TOOLING-FINDINGS.md`, "Already decided", from
  `ANIMATION-RUNTIME.md` 2026-10-06).
- **Reason:** best-in-class precedent (the Jolt pattern: narrow
  interface, vendored behind a bulk boundary). Lives primarily in the
  bake pipeline — retargeting, compression, validation, root-motion
  extraction via the offline toolchain through a Node N-API addon;
  secondarily any future native client / headless sim worker. The web
  client keeps three.js `AnimationMixer` for now.
- **License:** MIT (Guillaume Blanc).
- **Cost gate:** the ozz-to-WASM upgrade path is gated on a *measured*
  comparison — per-character CPU at 100+ visible characters, WASM vs.
  the current mixer. "Do not migrate on faith; migrate on numbers."
  Not adopted: ozz's sample renderers/importers (Assimp stays the sole
  file importer).

### 2.10 acl — animation compression at bake
- **Source:** same already-decided record as §2.9.
- **Reason:** an MMO multiplies the animation problem (hundreds of
  visible characters × full clip sets × LODs); uncompressed clips are
  a memory/bandwidth budget line. acl compresses at bake; the client
  decompresses the small hot path, or ozz consumes acl-compressed data
  (the two compose).
- **License:** MIT (Nicholas Frechette).
- **Cost gate:** measured bytes-per-character at each quality tier,
  error metrics within the authored tolerance, `low` tier never
  regresses. Note: the tolerance for this art direction is *tighter*
  than acl's defaults — compression pops show on held-frame stylized
  silhouettes.

### 2.11 three.quarks — authored-VFX runtime
- **Source:** shader set references the adoption as standing fact
  (`STYLIZED-RENDERING-DNA.md`: "the three.quarks evaluation (already
  adopted as the authored-VFX runtime)"); the full evaluation is
  recorded in the Alchemist0823 people page **[cross-check]**.
- **Reason:** batched rendering (minimal draw calls), a visual editor
  that exports effects as JSON — designers author spells/ambient/combat
  effects visually, the client loads JSON: a real pipeline win. Splits
  cleanly with Exp 7: quarks for authored VFX at modest counts, GPU
  simulation for 50k-particle storms.
- **License:** MIT (Alchemist0823).
- **Cost gate / open measurement:** particle simulation is CPU-side
  per system (`batchRenderer.update(delta)`) — the recorded condition
  is measuring N simultaneous systems at target particle counts,
  watching main-thread ms, before the adoption is treated as final.
  **[Cross-check]:** the archived three.quarks-editor was later ported
  into the engine's editor app as the authoring workspace against the
  engine-agnostic `VfxEffect` JSON format.

### 2.12 camera-controls (yomotsu) — camera infrastructure **[cross-check]**
- **Source:** people page only; **not in either report set** — included
  because it is an adoption decision on record for the editor and
  client camera.
- **Verdict:** ADOPT — "infrastructure, not a research question."
  Editor viewports first (orbit + fit-to-box + collision), then the
  client third-person camera replacing the hand-rolled follow cam
  (the library ships a third-person example to start from). No
  experiment spec needed.
- **License:** MIT; mature (2,430 stars, 971 commits, 87 releases
  since 2017, at evaluation).

### 2.13 Yuka — game-AI library **[cross-check]**
- **Source:** people page only (Mugen87); **not in either report set**.
- **Verdict:** Joey marked it "worth using" for the NPC/enemy-AI layer
  (living-sim S12/S13 track): steering, navmesh/pathfinding, state- and
  goal-driven agents, perception, fuzzy logic. Placement rule recorded
  with the verdict: engine-agnostic JS at the AI layer — **it stays
  out of the server tick**; authoritative world state stays in the
  server ECS. Where the AI logic ultimately lives (edge service vs.
  client vs. bake) was still open at last record.
- **License:** MIT (1,373 stars, not archived, at evaluation).

### 2.14 Spector.js — WebGL frame debugger **[cross-check]**
- **Source:** people page only (Babylon.js org); **not in either
  report set**.
- **Verdict:** KEEP as a **dev-only** profiling tool — frame capture
  for the shader program's per-experiment frame-ms budgets and
  terrain perf diagnosis. Zero production runtime cost. Explicitly
  *not* the instrument for fleet hardware baselining (it's a heavy
  per-frame debugger); that job belongs to a lightweight startup probe
  or `@pmndrs/detect-gpu` feeding the telemetry service.
- **License:** MIT (1,619 stars, actively released, at evaluation).

---

## 3. ADOPT SELECTIVELY

### 3.1 stylized-components — WaterFloor (anime water)
- **Source:** shader set, `SHADER-FX-EXTENDED.md` §4.
- **Take:** the surface shading (Voronoi F1−SmoothF1 cel water with a
  3-stop ramp, world-space anchored) and the screen-space
  depth-intersection shoreline — both map directly onto **Exp 9
  (Water)** foam work. Sparkles and the ripple event bus are part of
  the evaluated system.
- **Hold back:** the three-pass GPU PDE wave simulation — the
  expensive item; it must pass its own frame-ms measurement against
  Exp 9's budget before any commitment. Exp 9's foam-band energy fix
  is a correctness fix that stands regardless.
- **Scope caution:** the demo is a contained pond/lake; the engine
  needs rivers/lakes/shorelines at chunk scale. Techniques transfer,
  scene composition does not.
- **License:** MIT with attribution (same repo as §2.8).
- **Cost gate (rubric):** surface shading cheap (one pass); depth
  intersection needs a depth prepass (moderate) + a depth render
  target; PDE sim = three passes/frame + two ping-pong height
  textures, counted via `perf-stats.ts`; tier fallback = `low` drops
  the PDE sim (static rings only) and sparkles, keeps surface +
  shoreline.

### 3.2 Rohlinger's particle discipline (three.js Conf 2026)
- **Source:** shader set, `THREEJS-CONF-2026-FINDINGS.md` §1b/§4.
- **Take (techniques, reimplemented):** **deferred particle shading**
  (record visible particle ID + depth per pixel, shade once per pixel
  — collapses overdraw, the dominant particle cost; directly
  applicable to the three.quarks VFX layer, evaluated against the
  CPU-cost measurement work) and **single-triangle sphere impostors**
  for round particles.
- **Caution recorded in the source:** the talk's ~1M-particle figure is
  WebGPU compute on controlled installation hardware. The techniques
  transfer to the WebGL2-first client; the number does not. Do not
  cite it as a budget.

---

## 4. EVALUATE (spike first — pass bars are part of the verdict)

### 4.1 animouse — animation state machine with blend trees
**This is the full entry; §5 is devoted to it.** In the client
Findings it sits under EVALUATE with a spike-first order and a defined
pass bar; a later same-day spike flipped it to ADOPT (2026-10-10).
Both states are documented in §5.

### 4.2 EZ-Tree — procedural trees
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings spike.
- **Why:** feeds the octahedral-impostor baker directly — procedural
  species in, baked atlases out. Deterministic seeds make it
  bake-pipeline friendly. Same author as three-pinata (§2.7).
- **License:** MIT, verified via multiple sources.
- **Spike / pass bar:** generate 3 species with distinct silhouettes,
  bake to impostors, measure bake time and atlas bytes; species
  visually distinct at impostor distance; bake deterministic (same
  seed → byte-identical output).
- **Later outcome (2026-10-10) [cross-check]:** verdict upgraded to
  **ADOPT with bake-time constraint** (TS3, PR #231): `@dgreenheck/ez-tree@1.1.0`
  added to `packages/art`; documented path seed/preset → bake → GLB →
  impostor. That PR is decision/dependency only — it does not
  implement the tree baker or the deterministic same-seed test.

### 4.3 InstancedMesh2 — BVH-culled instanced scattering
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings spike.
- **Why:** the scattering-side complement to EZ-Tree and the impostor
  work — InstancedMesh + BVH frustum culling + LOD, reportedly 200k
  trees (report figure — **UNVERIFIED** against our hardware).
- **License:** MIT (per the research).
- **Spike / pass bar:** scatter 50k EZ-Tree instances; single-digit
  draw calls for the forest; frame time within budget at 60fps on
  target hardware, vs. naive InstancedMesh.
- **Later outcome (2026-10-10) [cross-check]:** verdict upgraded to
  **ADOPT** (TS4, PR #232): `@three.ez/instanced-mesh` dependency added
  to `packages/art`; planned chain TS3 baked trees → per-species
  InstancedMesh2 → BVH culling → near/mid/impostor LOD. Decision/design
  only — scattering implementation and benchmark gates still open.

### 4.4 NixieFX — visual VFX editor + runtime
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings spike.
- **Why evaluate:** it was the thing three.quarks lacked — a visual
  editor. Directory stated an MIT *runtime*; the **editor's license
  was unverified**, and that was the gate.
- **Spike / pass bar:** editor license confirmed permissive; runtime
  CPU within 10% of the hand-coded equivalent; authoring ≥2× faster.
- **Later outcome (2026-10-10) [cross-check]: REJECTED** (EA22 spike,
  PR #217). The runtime is MIT, but the editor is proprietary —
  hosted-only, no license text, no source, no self-host option. If the
  site goes down the authoring tool is gone; not adoptable as
  toolchain infrastructure. (The spike still shipped particle tier
  budgets as data — `content/vfx/budgets.json` — and the authoring gap
  was later filled by the ported three.quarks-editor, §2.11.)

### 4.5 GLB Delivery Desk — batch GLB QA gates
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings spike.
- **Why:** ready-made batch GLB inventory/handoff checks adjacent to
  the project's manifest validation.
- **License:** to verify (part of the spike).
- **Spike / pass bar:** run against 10 baked assets, diff checks
  against the manifest validators; adopt the *missing checks as
  validators* rather than the tool, unless it covers >50% of the
  validation surface with zero overlap.
- **Later outcome:** none recorded in the sources — still EVALUATE.

### 4.6 Meshamorphosis — batch FBX→GLB + Mixamo batching
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings spike.
- **Why:** batch-converts FBX/OBJ/glTF to GLB and can batch-add Mixamo
  animation FBX; the animation pipeline retargets from GLB clip
  sources, so batch ingest slots into the bake's animation stage.
- **License:** to verify (part of the spike).
- **Spike / pass bar:** license confirmed permissive; batch-convert 5
  Mixamo FBX clips to GLB; one retargets onto a Gobkit character
  without manual bone remapping.
- **Later outcome:** none recorded — still EVALUATE. **Caution
  [cross-check]:** Mixamo *content* itself carries a do-not-bundle
  verdict for anything the engine ships (Adobe terms prohibit
  redistributing raw Mixamo files in an asset package) — see §6.4.
  That restricts what converted clips may be used for, not the
  converter tool.

### 4.7 lygia — modular GLSL shader functions
- **Source:** client set, `THREEJS-DIRECTORY-REVIEW.md`; Findings spike.
- **Why evaluate:** granular function-level GLSL (noise, SDFs, color)
  for the shader R&D experiments — import math, not frameworks; fits
  the "reimplement, don't vendor" posture at the smallest unit.
- **License as stated in the review:** "MIT (verify on adoption)".
- **Spike / pass bar:** use 3 functions in one experiment; zero
  integration cost; functions genuinely reusable.
- **Later outcome (2026-10-10) [cross-check]: REJECTED at the license
  gate** (TS7). The original repo's `LICENSE.md` is **Prosperity
  Public License 3.0** — free for noncommercial use, commercial use
  limited to a 30-day trial — which fails the permissive-only rule.
  The rejection was challenged and re-verified against the actual
  LICENSE.md; it stands. Replacement path decided: build an in-house
  shader library plus individually verified permissive sources.
  **The "MIT" line in the directory review was wrong; do not rely on it.**

### 4.8 KTX2 as bake output format
- **Source:** shader set, `THREEJS-CONF-2026-FINDINGS.md` §4.
- **Why:** nominated by Kiiatkin's conf talk (hand-painted low-poly
  pipeline) and the natural container for octahedral-impostor atlases.
- **Gate:** decode cost on target hardware vs. current formats, and
  toolchain fit with the manifest-validated art pipeline. (In the
  event, the client Findings routed KTX2 through gltf-transform,
  §2.2, with the Windows KTX2 trial as a Phase 0 gate.)

### 4.9 Spark — 3D Gaussian Splatting renderer (Exp 11)
- **Source:** shader set, `SHADER-EXPERIMENTS.md` Exp 11 +
  `SHADER-FX-EXTENDED.md` §9.3/§9.5; people page (sparkjsdev)
  **[cross-check]** for the evaluation record.
- **Standing:** the program's **leading rendering-research bet** —
  EVALUATE, spike not yet run in these sources. three.js-native
  `SplatMesh` objects that fuse with mesh rendering (correct
  inter-splat and splat/mesh sorting), most splat formats (PLY, SPZ,
  SPLAT, KSPLAT, SOG), WebGL2 target.
- **Why:** splats are captured reality — they serve the design north
  star ("a real world, not THE real world"; nostalgia/familiarity)
  directly. Presentation-only, which is clean for the authoritative
  contract.
- **License:** MIT (World Labs' sparkjsdev org).
- **Cost gate (Exp 11 budget row):** ≤3 ms at 3 vistas; memory +
  wire bytes declared per vista; `low` tier loads **zero** splat
  bytes. First concrete budget number (§9.3): ~17.6 MB per
  million-splat tile (SOG, ARGO 2026 production guide) — the figure
  the gate measures against. Honest costs on record: uncompressed
  splat scenes run to hundreds of MB; SPZ compression helps but a
  chunk-streamed client needs a real budget; the renderer is young
  (~1 year, 16 releases at evaluation); it has a Rust/WASM build
  component (their prebuilt dependency, not project code).
- **Acceptance:** stills obviously better *and* worth the bytes, on
  named hardware; tier fallback verified in the network panel.

### 4.10 Gaussian-Splat-Lite — license-clean Spark sibling (Exp 11 eval #2)
- **Source:** shader set, `SHADER-FX-EXTENDED.md` §9.4.
- **Standing:** EVALUATE — rides the Exp 11 spike as the second
  candidate, not a Spark replacement. Apache-2.0 three.js splat
  renderer with WebGPU + WebGL2 fallback, RAD/SOG streaming schedulers
  with a configurable per-frame splat budget and smooth LOD fades —
  the explicit budget mechanism Spark lacks an equivalent for.
- **Caveats recorded in the source:** young repo (created Aug 2026,
  ~160 stars — the same maturity class that parked Three-VFX, §5/§6);
  dev builds require Rust + the wasm target for the decoder.
- **Cost gate:** same Exp 11 spike — same vista in both renderers,
  memory, wire bytes, and frame cost measured head-to-head.

### 4.11 Grassworks — consistency-first grass LOD (technique)
- **Source:** shader set, `SHADER-FX-EXTENDED.md` §9.1.
- **Standing:** candidate technique for Exp 6 — adopt the
  thinning-consistency rule (lower LODs thin blades from the
  higher-LOD population, survivors keep exact positions) as an Exp 6
  acceptance criterion alongside the GrassField techniques (§2.8);
  the spatial-dither LOD transition needs its own frame-ms
  measurement before merging, per the rubric. Not a package adoption.

### 4.12 threejs-field-grass (Kissinger) — deterministic TSL grass (techniques)
- **Source:** shader set, `SHADER-FX-EXTENDED.md` §9.2; people page
  (matthew-kissinger) **[cross-check]**.
- **Standing:** **adopt the techniques for Exp 6, not the package.**
  What fits: deterministic seeded scatter bake (server ships biome +
  seed, every client grows the same field — exactly the §1 contract),
  prefix-safe quality tiers (lower tiers decode a spatially fair
  prefix), 126k blades in one instanced draw per layer (author's
  figure — **UNVERIFIED** on our hardware), bounded CPU wake field.
- **Why not the package:** it is TSL-only, which means
  `WebGPURenderer`; the client runs the classic WebGL path, so taking
  the package means migrating the render path — a decision, not a
  dependency. The portable parts (stratified scatter sampler,
  prefix-shuffle tiering, wake-field accumulation) port onto the
  existing WebGL grass work.
- **License:** MIT; the author designs it to be vendored, not depended
  on.

### 4.13 Octahedral impostor baker — ADOPT as technique, reimplemented
- **Source:** shader set, `THREEJS-CONF-2026-FINDINGS.md` §2/§4
  (verdict there: "ADOPT (as technique, reimplemented)" — listed here
  with the evaluates because its gates are spike-shaped).
- **What:** bake each tree species from N sphere-distributed views
  into an octahedral atlas (albedo + object-space normal + depth);
  runtime is one camera-facing quad per distant tree, blending the 3
  nearest atlas cells, baked depth for parallax, baked normals for
  lighting; wind survives as a vertex bend. Completes the LOD chain:
  full mesh → reduced mesh → composite cards → impostor, mapped onto
  the 4 quality tiers. Canonical reference: Brucks (Epic, 2015–2017).
- **License:** clean by construction — reimplemented from the
  published write-up; no dependency.
- **Cost gates before it earns its place:** atlas memory per species
  (with KTX2), bake time per species, and the swap-distance threshold
  where the swap is invisible (the discourse no-popping condition
  becomes a bake validator) — all measured, per the rubric.

---

## 5. FULL ENTRY — animouse (animation state machine with blend trees)

**What it is.** An MIT-licensed TypeScript animation state machine for
three.js, built over `THREE.AnimationMixer`: `ClipState` (single clip +
lifecycle events), `LinearBlendTree` (1D — idle→walk→run on speed),
`PolarBlendTree` (2D polar — direction + intensity),
`FreeformBlendTree` (2D, Delaunay triangulation), and an
`AnimationMachine` with event-driven, automatic (on-complete), and
data-driven (condition) transitions, configurable crossfade durations,
and **time events** — callbacks fired at clip fractions (footstep
sounds at 0.25/0.75, attack impact at 0.6). Events run via `eventail`.
Repo: `jango-git/animouse`; npm 0.8.0; peer dependency three.js
^0.175.0. (Library facts from the deep review in
`THREEJS-TOOLING-FINDINGS.md`, verified against the repo 2026-10-10.)

**Why it matters here.** The client's hand-rolled animator
(`character-animator.ts`) is a two-layer base/action crossfader —
animouse is the locomotion-blending layer the client didn't have, and
its time events are the hook for footstep audio (EA24) and hit-frame
feedback. It sits on `THREE.AnimationMixer`, which the client already
uses. It does **not** conflict with the server-authoritative contract:
the server still decides `(clipId, startTick, rate, layerMask)` (EA21);
animouse is purely the client's blending/execution layer, strictly on
the client side of that line.

**Verdict history (both states, honestly).**
1. **EVALUATE — spike first** (client Findings, 2026-10-10). Spike:
   wire animouse into a dev scene with 3 Gobkit characters —
   LinearBlendTree locomotion, one ClipState attack with a time event
   firing at the hit frame. Pass bar: blends pop-free; time events
   within ±1 frame of the expected clip fraction; per-character
   overhead <0.1 ms/frame; code clean enough to vendor if needed.
2. **ADOPT** (2026-10-10) **[cross-check: people page]**: the TS1
   spike completed — state machine + blend trees over the mixer, 3/3
   tests green; recorded as PR #230 in the monitor-and-merge stack.
3. **Integration tested 2026-10-19 [cross-check: people page]:**
   EA21 — `CharacterAnimator` builds an animouse `LinearBlendTree`
   (idle → walk → jog → sprint by normalized speed) driven via
   `AnimationMachine`, with manual crossfade fallback for server
   overrides, swim/fly, and airborne states; EA24 — animation-driven
   footstep events (phase crossings at ¼ and ¾ of each locomotion
   cycle); EA21 foot IK (`foot-ik.ts`, two-bone law-of-cosines solver,
   plants feet when grounded); EA21 cross-rig clip retargeting
   (`retarget.ts`, bone-name normalization + rest-pose-delta track
   conversion). Recorded as 293/293 client tests passing on branch
   `arlo/ea21-animouse-blend`. *Per this document's standing rule,
   these are recorded implementation claims from the project's own
   logs — the verdict compiled here is the research verdict (ADOPT);
   the integration state is Claude's to confirm against the branches.*

**Risk on record.** 1 star, 1 watcher, 0 forks at review — bus factor
1, single author. Mitigation: the library is small (a few hundred lines
of state-machine logic over the mixer), MIT means it can be vendored/
forked if the author vanishes, and the math (Delaunay triangulation
for the freeform tree) is standard, not magic.

**Cost gate.** Per-character overhead budget <0.1 ms/frame (spike pass
bar above); blend correctness (no popping) is a correctness gate, not
a preference. No GPU cost — it drives the mixer the client already runs.

**License.** MIT, verified 2026-10-10 against `jango-git/animouse`.

---

## 6. PARK / WATCH / BOOKMARK / REJECT

### 6.1 PARK — do not touch (revisit conditions are part of the verdict)

| Item | Reason | Revisit when |
|---|---|---|
| **Theatre.js** | `@theatre/studio` (the visual editor — the whole point) is **AGPL-3.0**, tripping permissive-only; `@theatre/core` is Apache-2.0 but useless alone here. Also ownership churn (`@tomorrowevening/*` forks) — maintenance needs a check. | A cinematics/sequenced-animation need exists AND the AGPL question is answered |
| **Needle Inspector** | License **UNVERIFIED**. No technical objection — it complements Spector.js (scene-graph vs. frame capture, both dev-only). | License confirmed permissive |
| **Three.js DevTools** | Parked alongside Needle Inspector on the same license-check gate. | With Needle Inspector |
| **TSL visual editors** (TSL Graph, Nodetoy, tsl-textures) | Tied to the TSL/WebGPU path. | The WebGPU decision itself is made |
| **AI 3D generators** (Rodin, Tripo, Meshy, Genaimo, etc.) | Art is supplied input and style consistency is a design pillar; generated assets are a style risk with murky training-data licensing. Parked explicitly, not overlooked. | Never without a license + style review |
| **Three-VFX** (WebGPU GPU particles) | **Do not adopt** (`SHADER-FX-EXTENDED.md` §5): architecture is right and WebGPU is aligned with the bundle's direction — the blocker is maturity: 146 stars, 0 releases, ~9 months old, experimental vanilla support, single maintainer. The need is already owned by Exp 7 (in-house TSL compute + three-nebula WebGL2 fallback). Three-VFX is the **fallback candidate if Exp 7 stalls**. | Re-evaluate in 12 months (from 2026-10-05), or if Exp 7 stalls — on a 1.0 release, stable API, second maintainer or corporate backer. Rubric items then: compute ms at 50k particles vs. Exp 7's target, storage-buffer VRAM, WebGL2 fallback path |
| **Motion matching** (Clavet technique) | Parked (`ANIMATION-RUNTIME.md` via the client Findings): (1) memory — vanilla motion matching exceeds 0.5 GB and scales linearly; (2) corpus — no large curated mocap database exists for the game's rigs; (3) scale — per-character database search × hundreds of characters needs an acceleration structure and a measured budget first. The hybrid state machine is the path instead — which is what animouse (§5) provides client-side. | A mocap corpus exists AND per-character CPU is measured AND Learned Motion Matching (Holden et al. 2020, ~70× database compression) is evaluated as the memory answer |
| **GTAO port** (Exp 4) | The experiment spec's pre-registered expectation is **park**: N8AO is already a strong incumbent in the client (half-res medium/high, full ultra). GTAO merges *only* on a visible crevice-quality win at the measured pass cost (<1.5 ms half-res budget). **UNVERIFIED as a final verdict** — this is the spec's stated expectation, not a measured result; the N8AO-vs-GTAO comparison is itself the deliverable. | Exp 4 runs and produces numbers |
| **Tessendorf FFT water** | Standing decision (`R&D-INDEX.md`): parked — out of an MMO client's GPU budget. | — |
| **PRT (precomputed radiance transfer)** | Standing decision: parked behind Exp 2's verdict — only if the LTC lighting rig leaves perf headroom. | Exp 2 verdict + headroom |
| **True volumetrics** | Standing decision: out. Exp 8's cheap light shafts are the ceiling. | — |

### 6.2 WATCH — no action, check back on a trigger

- **GSAP 4** — the standard JS timeline library; v4 announced at
  three.js Conf 2026, first major since GSAP 3 (2019), free following
  the Webflow acquisition (**confirm exact license text before
  vendoring**). Not a 3D-engine concern (the animation runtime is
  ozz / three.js mixer + animouse); candidacy is editor UI and client
  HUD tweens only. Revisit when the feature list is public and a
  concrete tween need exists. (Both report sets concur.)
- **KHR_gaussian_splatting + its SPZ compression draft** — Khronos RC
  (Feb 2026) makes splats native glTF 2.0 point primitives, backed by
  Google/NVIDIA/Apple/Bentley + Niantic/Cesium/Esri. A tailwind for
  Spark (§4.9), not a new decision: splats as glTF citizens ride the
  existing asset pipeline, and Spark already handles SOG. The base
  extension is intentionally lossless (heavy on the wire); the draft
  companion `KHR_gaussian_splatting_compression_spz_2` decides
  wire-bytes-per-vista. **Watch the compression ratification; do not
  build on the draft.** Pipeline note: splat-carrying glTF needs a
  splat-aware import path alongside the mesh loader.

### 6.3 BOOKMARK — manual reference, no integration

- **gltf.report** (donmccurdy) — web GLB diagnostic (BASIS/KTX2);
  manual QA companion to the bake.
- **Kenney / Quaternius** (CC0) — placeholder assets (nature, medieval,
  animated characters). **Caution [cross-check]:** Quaternius carries
  a recorded license contradiction (QAL v1.0 vs. CC0) in the project's
  prototype-asset research and was treated as a hard stop for the
  *shipped* prototype packs — the directory review's CC0 bookmark
  predates that finding. Treat Quaternius as **UNVERIFIED for
  shipping** until re-checked.
- **Polyhaven / AmbientCG** (CC0/free) — HDRIs and PBR textures for
  lighting/material prototyping.
- **Mixamo** (free) — standard free clip source for the animation
  pipeline's *internal* testing. **Overridden for shipping
  [cross-check]:** DO NOT BUNDLE — Adobe's terms prohibit
  redistributing raw Mixamo characters/animations in a shipped asset
  package (verdict 2026-10-09). Internal use or a
  download-your-own workflow only.
- **VAT Blender addon** — vertex-animation-texture generation; a
  research note for the crowd-animation problem, not a tool to adopt.
- **SDR-to-HDR via WebGPU shaders** — **bookmark the technique, do not
  adopt the code** (`SHADER-FX-EXTENDED.md` §9.6): a Chromium video
  extension is the wrong shape, inverse tone mapping solves a problem
  an engine doesn't have (render HDR natively; the tone-map stage is
  already owned by the tier-gated post stack), it's WebGPU-only, and
  its license is **UNVERIFIED**. What earns the bookmark: a shipped
  reference for the output-transform shader if/when WebGPU lands and
  HDR display output is evaluated.

### 6.4 REJECT — evaluated and closed

- **NixieFX** — rejected 2026-10-10 at the license gate (editor
  proprietary/hosted-only). Full record in §4.4.
- **lygia** — rejected 2026-10-10 at the license gate (Prosperity
  Public License 3.0, not MIT as the directory review stated). Full
  record in §4.7.
- **Mixamo (for shipped content)** — do-not-bundle verdict above
  (§6.3); listed here so the rejection isn't missed.

### 6.5 Incumbents named in the report sets (context, not new verdicts)

So Claude doesn't re-litigate what's already in the stack per the
report sets' own ground truths (`SHADER-EXPERIMENTS.md`, verified
against the repo at spec time):

- **pmndrs `postprocessing`** — the client's `EffectComposer` stack
  (Bloom, Vignette, custom effects, GT tone mapping), tier-gated.
- **N8AO** — the incumbent ambient occlusion (see Exp 4, §6.1).
- **@takram/three-atmosphere** — the physical sky on high/ultra tiers
  is already implemented; remaining sky work is clouds, not the dome.
- **three-nebula** — the designated WebGL2 fallback for GPU particles
  in Exp 7's design (nebula parity at 50k particles is Exp 7's
  acceptance bar); hero small effects stay on nebula by design.
- **`@pmndrs/detect-gpu`** — drives the quality-tier presets
  **[cross-check: people pages]**.
- **SMAA** (pmndrs postprocessing `SMAAEffect`) — the AA baseline
  Exp 3 evaluates TAA against.

---

## 7. Per-branch map — PRs #165, #166, #177, #185

**Checked live on GitHub, 2026-10-23** (GitHub API, repo
`SirHertzAlot/NexusMMOEngine`). The premise that these are Claude's
*still-open* branches is **out of date**. All four are **closed and
merged**, and none of their head branches still exists on the remote.

| PR | Title | State (verified 2026-10-23) | Head branch | What it held |
|---|---|---|---|---|
| #165 | Editor dock: real Output, Problems and Bakes | **Closed, merged 2026-10-10T01:53Z** | `claude/project-thread-kwpoim-dock` — **no longer on origin** | 10 files, +388/−32, all under `apps/editor/` (dock panes/feed, App.tsx, panels) + dock-feed test |
| #166 | Editor Ctrl K: commands, assets and settings | **Closed, merged 2026-10-10T01:57Z** | `claude/project-thread-kwpoim-palette` — **no longer on origin** | 5 files, +417/−17, all `apps/editor/` (command palette, open-asset) + palette test |
| #177 | Editor: Details pane shows the real unsaved Gameplay edits | **Closed, merged 2026-10-10T01:58Z** | `claude/project-thread-kwpoim-details` — **no longer on origin** | 5 files, +198/−15, all `apps/editor/` (gameplay-diff, pending-changes) + test |
| #185 | Editor: customizable toolbar | **Closed, merged 2026-10-10T01:59Z** | `claude/project-thread-kwpoim-toolbar` — **no longer on origin** | 3 files, +159/−51, all `apps/editor/` (toolbar-config) + test |

Context: the four were part of Claude's editor audit series (#163–182
era) and landed in the 2026-10-10 merge wave (#168–197). A 2026-10-22
check found zero open PRs in the repo; today's check finds 13 open
PRs (#357–#369), all newer engine/editor work — none of them is one
of these four.

**Verdict mapping — stated plainly:** *no library verdict in this
document maps onto any of these four PRs.* All four are editor-UI
work in `apps/editor/`; none touches a three.js library, the client
renderer, or the art bake. There is nothing for Claude to "build
against" in them — they are already on main.

The verdicts that *would* have been relevant to Claude's editor lane
generally, for the record:

- **lil-gui (§2.5)** — the editor's dev-only tweak panel (the editor is
  vanilla three.js); the editor-UI PRs above are exactly the app it
  lands in.
- **camera-controls (§2.12)** — editor viewports are its first
  adoption surface.
- **Needle Inspector (§6.1)** and **Three.js DevTools (§6.1)** —
  dev-only editor-adjacent debugging, both parked on license checks.
- **Theatre.js (§6.1)** and **GSAP 4 (§6.2)** — editor timeline/tween
  candidacies, parked/watched.
- **Spector.js (§2.14)** — dev-only profiling for the editor/client.

If a future editor branch reopens any of those questions, the verdicts
above are the starting point — with their gates intact.

---

## 8. UNVERIFIED — explicit list

Nothing below was presented as fact anywhere in this document:

1. **GTAO** — no measured verdict exists; §6.1 records the experiment
   spec's *expectation* (park). Exp 4 has not produced numbers in
   these sources.
2. **InstancedMesh2's "200k trees"** and **threejs-field-grass's
   "126k blades/draw"** — authors' reported figures, not measured on
   project hardware. Both spikes exist precisely to replace them with
   measured numbers.
3. **Needle Inspector's license** — unverified; that is its park gate.
4. **GLB Delivery Desk's and Meshamorphosis's licenses** — unverified;
   verification is step one of both spikes.
5. **lil-gui's MIT text** — "well-established; confirm on adoption"
   per the directory review; not re-read line-by-line for this
   compilation.
6. **GSAP 4's exact license text** — "free following the Webflow
   acquisition" per the reports; confirm the text before vendoring.
7. **Quaternius's license for shipping** — CC0 per the directory card,
   but a later project survey recorded a QAL-vs-CC0 contradiction and
   treated it as a hard stop for shipped packs (§6.3).
8. **The SDR-to-HDR extension's license** — unverified (§6.3).
9. **three-mesh-bvh** — named in program memory as present in the
   client, but **no verdict for it exists in either report set or the
   people pages**, so it is deliberately *excluded* from this document
   rather than given an invented verdict.
10. **Post-report implementation claims** (animouse EA21 integration,
    EZ-Tree/InstancedMesh2 dependency PRs, the three.quarks-editor
    port) are recorded from the project's own logs and people pages;
    they are labeled [cross-check] where they appear and are not
    independently re-verified by this compilation.

---

## 9. Counts

Report-set verdicts compiled (counting each library/system once, at
its report-set verdict; later updates shown inline in its entry):

- **ADOPT:** 10 (gltfpack, gltf-transform, gltfjsx, Leva, lil-gui,
  Gobkit, three-pinata, GrassField techniques, ozz-animation, acl) —
  plus 3 adoptions recorded via cross-check only (three.quarks,
  camera-controls, Yuka) and 1 keep (Spector.js).
- **ADOPT SELECTIVELY:** 2 (WaterFloor; Rohlinger particle discipline)
  — plus the octahedral impostor baker, ADOPT-as-technique (§4.13).
- **EVALUATE:** 11 (animouse, EZ-Tree, InstancedMesh2, NixieFX,
  GLB Delivery Desk, Meshamorphosis, lygia, KTX2, Spark,
  Gaussian-Splat-Lite, Grassworks/field-grass techniques).
- **PARK:** 10 entries (Theatre.js, Needle Inspector, Three.js
  DevTools, TSL visual editors, AI 3D generators, Three-VFX, motion
  matching, GTAO expectation, Tessendorf FFT, PRT — plus true
  volumetrics as a standing exclusion).
- **WATCH:** 2 (GSAP 4; KHR_gaussian_splatting/SPZ).
- **BOOKMARK:** 6 (gltf.report, Kenney/Quaternius, Polyhaven/AmbientCG,
  Mixamo, VAT addon, SDR→HDR technique).
- **REJECT (post-report outcomes):** 2 (NixieFX, lygia) + Mixamo
  do-not-bundle for shipped content.

*End of findings. Research only — this document authorizes no pushes,
merges, or branch changes.*
