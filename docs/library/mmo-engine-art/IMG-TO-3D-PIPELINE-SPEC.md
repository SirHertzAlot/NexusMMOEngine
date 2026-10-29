# Image-to-3D Asset Pipeline Specification — Rapid Model Library Building

**Status:** Draft for review (2026-10-11)
**Positioning:** Two-track generation pipeline feeding the existing art bake chain. Reconstruction-by-code is the primary track; neural mesh generation is the fallback for organic/hero subjects.
**Companions:**
- `../mmo-engine-scripting/SCRIPTING-LAYER-SPEC.md` (data-definition layer; generated code can emit `defineEntity` scripts)
- `../mmo-engine-dev-ide/DEV-IDE-SPEC.md` (pipeline runner hosts the asset pipeline stages; Ghost Sync works on generated code)
- `../mmo-engine-procgen/STYLE-DRIVEN-PROCGEN.md` (style profiles constrain generation)

---

## 1. Purpose

Build model libraries rapidly from reference images ("proper images" in, game-ready models out). The pipeline turns a curated image set into a cataloged, style-consistent, provenance-complete model library — with code as the primary artifact and baked GLBs feeding the existing art chain (gltfpack → gltf-transform → gltfjsx, implemented on `arlo/tooling-full-audit`).

All pipeline output is **prototype content** under the shipped-art policy (same designation as Gobkit placeholders). The policy itself does not change; the pipeline feeds it faster.

---

## 2. Design Principles

1. **Code first, mesh as fallback.** Reconstruction-by-code produces parametric, editable, diffable, variant-generatable models. Neural meshes are frozen blobs — used only where code reconstruction can't reach.
2. **Style-gated, not style-hoped.** Every asset passes style-profile validation before entering the library. Generation prompts carry style constraints; the gate enforces them.
3. **Provenance-complete.** Every library entry traces to its source images, generator, version, parameters, gate reports, and author. No orphan assets.
4. **Swappable backends.** Both tracks sit behind narrow interfaces. The LLM provider, the reconstruction framework, and the neural model are each replaceable without touching the pipeline.
5. **Fail closed.** A subject that fails its track's quality gates never enters the library — it escalates (other track or human), never ships as "good enough."
6. **Human-in-the-loop where it matters.** Bulk props flow through automatically; hero assets require human approval. The pipeline knows the difference.

---

## 3. Architecture Overview

```
Reference images
      │
      ▼
┌─ Stage 0: Intake ─────────────────────────────────┐
│ upload → dedup → matting → quality gates →        │
│ subject classification (object/character/organic) │
└──────────────────┬────────────────────────────────┘
                   │ route by subject class + tier
        ┌──────────┴──────────┐
        ▼                     ▼
┌─ Track 1: Code ──┐  ┌─ Track 2: Neural ──┐
│ (primary)        │  │ (fallback)         │
│ img2threejs      │  │ img2glb plugin     │
│ framework +      │  │ (hosted route;     │
│ Gemini (AI Studio)│  │ self-hosted for    │
│                  │  │ private subjects)  │
│ → TS model code  │  │ → GLB mesh         │
└────────┬─────────┘  └────────┬───────────┘
         │                     │ cleanup (dust, holes,
         │                     │  decimate)
         ▼                     ▼
┌─ Style pass ──────────────────────────────────────┐
│ palette quantization → style-profile validation → │
│ polycount budgets per LOD tier                    │
└──────────────────┬────────────────────────────────┘
                   ▼
┌─ Bake ────────────────────────────────────────────┐
│ code track: execute → GLTFExporter → GLB          │
│ both tracks: gltfpack → gltf-transform → gltfjsx │
└──────────────────┬────────────────────────────────┘
                   ▼
┌─ Variant generation (WFC over code parameters) ───┐
│ code track only: N variants per subject           │
└──────────────────┬────────────────────────────────┘
                   ▼
┌─ Library ─────────────────────────────────────────┐
│ catalog + provenance + review workflow +          │
│ AI-generated flag + search/tags                   │
└───────────────────────────────────────────────────┘
```

---

## 4. Stage 0 — Image Intake

- **Upload:** single image, multi-view sets (2–4 consistently-lit views preferred for characters/hero subjects), or batch folders.
- **Dedup:** perceptual hash against the library — the same subject doesn't get generated twice. Near-duplicates are flagged for author decision.
- **Matting:** background removal (`rembg` or equivalent) with a quality check on the matte (subject isolation score). Poor mattes bounce back to the author, not forward.
- **Quality gates (intake):** minimum resolution, subject occupies sufficient frame fraction, not excessively blurry/occluded. Each gate reports a score; failures include the reason and a fix suggestion ("subject too small — crop tighter").
- **Subject classification:** `object` (hard-surface: weapons, furniture, tools), `character` (humanoids, creatures with anatomy), `organic-hero` (complex organic subjects where code reconstruction is unlikely to succeed). Classification routes to tracks (§6) and sets the review tier (§10).

---

## 5. Track 1 — Reconstruction-by-Code (Primary)

**Framework:** img2threejs (Apache 2.0) — the staged reconstruction pipeline, prompts, and quality gates.
**Vision LLM:** Google Gemini via AI Studio (API key via the Secure Vault credential flow — never in chat, code, or project files).
**Interface:** the framework sits behind a narrow `ReconstructByCode` interface (`analyze(image) → spec → generate → review → code`). The LLM provider and framework version are configuration, not code.

**Staged pipeline** (each stage vision-reviewed before the next begins):

1. **Intake/spec:** the model enumerates a `detailInventory` — every identity-defining detail (silhouette, proportions, gloss, bevels, engraved/painted linework, wear). A strict gate blocks code generation until the inventory is complete: no detail without a mapped component or material entry.
2. **Blockout → structural → form → material → surface → lighting → interaction → optimization:** one build pass at a time, each vision-reviewed against the reference. Self-correcting until every inventoried feature clears its threshold.
3. **Character subjects** route through the anatomy-aware track (head-unit proportions, facial landmarks, pose rigging points).
4. **Per-region confidence** is reported throughout; low-confidence regions are recorded as such rather than invented.

**Output:** a TypeScript module exporting a parametric procedural model (`create<Subject>Model(params)`), animation-ready (named parts, rigging points where applicable), using the project's Three.js version.

**Token discipline:** deterministic scripts handle validation and gating; LLM tokens are spent only on visual judgment and code. Per-asset token budgets are configured; overruns escalate to human rather than silently spending.

**Why this track is primary:** output is editable, diffable (Ghost Sync works on it), variant-generatable (WFC over parameters, §8), style-constrainable via prompts, and carries none of the training-data license risk of neural 3D models.

---

## 6. Track 2 — Neural Fallback

**Model:** TRELLIS.2 (MIT, weights included) — multi-image conditioning, single-pipeline decode to remeshed PBR-textured GLB.
**Deployment (default):** the official `img2glb` plugin's hosted route — image→GLB through img2threejs's hosted TRELLIS space. Zero GPU requirement on our side; no microservice to stand up. (Verified 2026-10-12: the plugin ships with the img2threejs repo.)
**Deployment (private/sensitive subjects):** self-hosted TRELLIS.2 bake microservice (GPU host). ~24GB VRAM full path, 16GB fp16 path. Used only when subjects can't leave our infrastructure — the pipeline does not assume local GPUs otherwise.
**Interface:** `GenerateMesh(images[]) → GLB`, swappable (Hunyuan3D-2.1 held as the hero-texture alternative pending its license verification).

**Routing to Track 2 happens when:**
- Subject class is `organic-hero`, or
- Track 1 exhausts its iteration budget without clearing quality gates, or
- A human reviewer explicitly requests it.

**Cleanup (mandatory, before the style pass):** dust/floaters removal, hole filling, decimation to the polycount budget, axis/origin normalization, scale normalization to meters.

Track 2 is never the default. Its outputs are meshes — they skip variant generation (§8) and go straight to style pass → bake.

---

## 7. Style Pass

Applies equally to both tracks. This is the stage that retired the style-consistency PARK rationale:

- **Palette quantization:** textures are quantized toward the project's style palette (from the style profiles). Out-of-palette colors are either mapped or flagged.
- **Style-profile validation:** the asset is scored against `style-profile.json` (per STYLE-DRIVEN-PROCGEN) — silhouette complexity, color distribution, material properties. Failures return to the track with diagnostics; they don't enter the library.
- **Polycount budgets:** enforced per LOD tier (LOD0/LOD1/impostor). Over-budget assets are decimated; if decimation destroys identity-defining features (per the detail inventory), the asset escalates to human review rather than shipping degraded.

---

## 8. Bake

- **Code track:** the TS module is executed headlessly → scene → `GLTFExporter` → GLB. The code remains the source of truth; the GLB is the baked artifact.
- **Both tracks:** GLB → **gltfpack** (geometry encode) → **gltf-transform** (texture/KTX2, cleanup) → **gltfjsx** (R3F component) — the existing chain, unchanged.
- Bake is a stage in the Dev IDE pipeline runner (`engine.pipeline.ts`), hermetic and cached like every other stage.

---

## 9. Variant Generation (Code Track Only)

The parametric output of Track 1 is variant-generatable:

- **WFC over parameters:** the model's parameter space (proportions, colors within palette, accessory toggles, wear levels) is treated as a constraint problem. Biome/species constraints from the living-sim design (frost vs. dune goblin) collapse to concrete variants.
- **One reconstruction → N variants:** e.g., a single goblin reference yields frost, dune, forest, and cave variants — each a parameter set, each baked to its own GLB, each with provenance linking back to the source reconstruction.
- Variants pass through the style pass (§7) independently — a variant that drifts out of style is rejected, not shipped.

---

## 10. Library, Provenance & Review

**Catalog:** searchable by tags, subject class, track, style scores, polycount, author, date. Preview renders in the editor.

**Provenance record (mandatory per asset):**
```
sourceImages[] (hashes + originals)
track (code | neural)
generator (framework + version, LLM model + version | neural model + version)
gateReports[] (per-stage scores and thresholds)
parameters (code track: full param set; neural: seed + settings)
styleValidation (profile version + scores)
author, createdAt, apiVersions
aiGenerated: true (always — shipped-art policy)
parentAsset (variants link to source reconstruction)
```

**Review tiers:**
- **Bulk (props, set dressing):** auto-accept if all gates pass above the auto-threshold. Human can audit retroactively.
- **Character:** auto-accept above a higher threshold; human review queue for borderline scores.
- **Hero:** human approval required, always. No auto-accept path.

**Review UI:** side-by-side reference vs. render, gate scores, per-region confidence overlay, approve/request-changes/reject with reasons. Rejections feed back into the track (retry with notes) or to intake (better images).

---

## 11. Integration Points

- **Scripting layer:** Track 1 code modules can emit `defineEntity` scripts — a generated model arrives in the data pipeline as a proper entity definition, not just a mesh.
- **Dev IDE pipeline:** intake → tracks → style → bake are stages in `engine.pipeline.ts` (§6 of the Dev IDE spec). `engine assets generate`, `engine assets review`, `engine assets variants` CLI commands with full IDE panels.
- **Ghost Sync:** generated code is text — collaborators see each other's model-code edits as ghosts, same as any other code.
- **Editor:** library browser panel, preview viewport, one-click "generate variants" and "send to review."
- **Needs/WFC systems:** generated creatures arrive with parameter spaces the species-variant WFC already understands (§9 is the same collapse machinery as the living-sim variant design).

---

## 12. Cost Model

- **Track 1:** Gemini API token spend per asset (vision + code generation + review passes). Bounded by per-asset token budgets; cached aggressively — identical source image hashes never regenerate.
- **Track 2:** GPU microservice cost (local amortized, cloud per-minute, or queued batch). Only incurred on routing (§6) — the code-first default keeps this rare.
- **Caching:** content-addressed on (source image hashes, track, generator versions, params). Regeneration is always a deliberate act, never accidental.
- Costs are reported per asset in the provenance record — the cost/benefit gate stays visible.

---

## 13. Invariants

- **A1 — Provenance-complete.** Every library asset traces to its source images, generator, versions, gate reports, and author. An asset without a provenance record cannot exist in the library. Tested by audit queries.
- **A2 — Style-gated.** No asset enters the library without passing style-profile validation at the configured threshold. Tested by submitting deliberately off-style subjects and asserting rejection.
- **A3 — AI-flagged.** `aiGenerated: true` on all pipeline outputs, always. The shipped-art policy consumes this flag downstream. Tested by schema assertion.
- **A4 — Deterministic replay (code track).** Same code + same parameters renders byte-identical output. Tested by replay golden tests.
- **A5 — Code-first routing.** Track 2 never runs without explicit routing (§6). Tested by asserting the routing decision log.
- **A6 — Hero review.** Hero-tier assets require human approval; no auto-accept path exists in code. Tested by attempting auto-accept on hero subjects.
- **A7 — Fail closed.** Failed gates produce no library entry — escalation only. Tested by fault injection at each gate.

---

## 14. Explicitly Out of Scope (v1)

- **Text-to-3D:** the pipeline starts from reference images, not prompts. Text-to-image (for concept generation feeding intake) is a compatible pre-stage but not specced here.
- **Rigging/animation generation:** Track 1 outputs are animation-*ready* (named parts, rigging points); auto-rigging and clip generation are a separate spec.
- **Texture painting beyond PBR:** Track 2's PBR output and Track 1's procedural materials are the v1 ceiling. Dedicated texture-artist tooling is separate.
- **Real-time generation:** the pipeline is a bake-time/content-creation tool. Runtime procedural generation (the living sim's terrain/settlement systems) is a different system.

---

## 15. Implementation Phases

- **Phase 1 — Intake + Track 1:** image intake (§4) with quality gates; img2threejs framework integration behind the `ReconstructByCode` interface; Gemini via AI Studio with Secure Vault key management; staged gates; TS module output. Invariants A1, A4, A7.
- **Phase 2 — Style + Bake + Library:** style pass (§7); code→GLB→existing chain (§8); library catalog with provenance records and review UI (§10). Invariants A2, A3.
- **Phase 3 — Variants:** WFC over code parameters (§9); `defineEntity` emission to the scripting layer.
- **Phase 4 — Track 2 + routing:** hosted img2glb route as default Track-2 deployment (self-hosted TRELLIS.2 reserved for private subjects); routing logic (§6); mesh cleanup; hero review workflow. Invariants A5, A6.
- **Phase 5 — Dev IDE integration:** pipeline stages, CLI commands, editor library browser, Ghost Sync on generated code.

Each phase holds all invariants from §13 that apply to it; a phase is not done until its invariant tests are green.
