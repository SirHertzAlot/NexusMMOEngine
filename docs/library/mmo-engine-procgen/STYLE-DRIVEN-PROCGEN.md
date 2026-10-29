# Style-Driven Procgen — Sine Synthesis + Asset-Rule Extraction

**Date:** 2026-10-06 · **Status:** Research + pipeline design · **R&D companion**
**Audience:** AI builders implementing the procgen backbone; the art team owns the style being measured.
**One-line thesis:** Measure the asset corpus to learn the style's statistical rules,
then generate new assets with sine-based synthesis bounded by those rules —
infinite content that looks like *your* game, not generic noise.

---

## 0. The two ideas and how they connect

Joey brought two ideas that turn out to be two halves of one pipeline:

1. **Sine waves can generate anything.** The talk's underlying principle is
   Fourier synthesis: any periodic signal decomposes into summed sines, so any
   *cyclic* game content — walk cycles, water, breathing, terrain undulation —
   can be authored as layers of sine waves with controlled frequency,
   amplitude, and phase. This is the *synthesis* half.
2. **Analyze model proportions to learn the style's rules, then procgen
   assets that mimic and extend them.** Measure poly counts, proportion
   ratios, palette distributions across the existing assets; treat the
   statistics as the style's DNA; drive generators from those statistics
   instead of hardcoded numbers. This is the *analysis* half — and it has a
   name in the literature: **inverse procedural modeling**.

Pipeline in one sentence: **analyze → profile → synthesize → validate.**

---

## 1. The sine-wave principle (what the talk was getting at)

### 1.1 Fourier synthesis for game devs

Any periodic motion or shape can be expressed as a sum of sines:

```
value(t) = Σ Aᵢ · sin(2π·fᵢ·t + φᵢ)
```

Each layer adds one "idea": a slow large sway + a fast small shiver =
organic motion. This is why sines feel like they "generate anything" — with
enough layers you can approximate any cyclic behavior, and each layer stays
independently art-directable (change one amplitude, keep the rest).

The likely talk Joey remembers is in the Freya Holmér lineage — her math
visualization threads and shader course teach sine-layered procedural motion
as core gamedev literacy (Holmér, "Math Visualization" Twitter threads;
*Shaders for Game Devs* course). The 3Blue1Brown Fourier-series exposition is
the same principle from the math side. The principle matters more than the
attribution: **sines are the cheapest expressive primitive in the toolbox.**

### 1.2 Where sines beat noise in *this* engine

The engine already uses hash-based noise (the scatter pipeline's portable u32
hash goldens). Sines complement noise in three places where they win outright:

| Use | Why sines win |
|---|---|
| Cyclic animation (idle, walk bob, sway, water) | Perfectly periodic — no popping at loop points, unlike sampled noise |
| Terrain/detail octaves | Fully analytic: value *and* derivative available in closed form (normals without finite differences); trivially tileable by quantizing frequencies |
| Determinism | `sin()` of a seeded phase is bit-identical everywhere — no lookup tables to keep in sync between the TS reference and the C++ port |

**The determinism point is load-bearing.** The engine's contract demands
bit-identical output across the JS prototype and the C++ addon (proven by the
scatter pipeline's TS→C++ port). Summed sines with integer-quantized
frequencies and seeded phases satisfy this by construction — there is no
platform-dependent table to diverge.

### 1.3 The sine toolkit (concrete operators)

- **Layered oscillators** for animation: `sway(t) = A₁·sin(f₁t) + A₂·sin(f₂t+φ₂)`.
  Vegetation wind, cloth ripple, idle breathing, water bob. Amplitudes bounded
  by the style profile (§2).
- **Sine octave stacks** for geometry detail: displacement =
  `Σ Aᵢ·sin(kᵢ·x + φᵢ)` over 2–4 octaves. Rock/terrain micro-detail that is
  analytic, tileable, and cheap. The profile bounds total displacement so a
  rock never stops reading as *your* rock.
- **Sine-warped UVs** for stylized water/shader motion: scrolling sine warps
  under the WaterFloor-style cel surface (Exp 9) — replaces noise textures
  with zero memory cost.
- **Phase-seeded variation:** one generator, N assets — the *seed* changes the
  phases, the *profile* bounds the amplitudes. Same style, infinite instances.
  This is the "mimic and extend" mechanism at the synthesis level.

---

## 2. Style-rule extraction (the analysis half)

### 2.1 What to measure

Run a bake-time **corpus analyzer** over the asset library (per asset family:
characters, vegetation, rocks, buildings, props). For each family, extract:

| Metric | What it captures | Example rule learned |
|---|---|---|
| Tri/vert count distribution (p50, p95, max) | Poly budget discipline | "rocks: 300–800 tris, never above 1200" |
| Bounding-box proportion ratios | Silhouette grammar | "humanoids: leg:torso:head ≈ 4:3:1.2" |
| Texel density (px/m) | Texture budget discipline | "props hold 128 px/m ± 20%" |
| Palette clusters (k-means on textures, k≈8) | Color identity | "vegetation lives in these 8 greens" |
| Material slot count | Shader complexity budget | "characters: ≤ 4 slots (skin, hair, cloth, accent)" |
| Normal-map presence | Shading authorship (cf. DNA doc D2) | "0% of characters use normal maps" |
| Silhouette complexity (convexity ratio) | Shape language | "rocks: convexity 0.7–0.85, never blobby, never spiky" |

Output: **`style-profile.json`** — one per asset family, versioned,
human-readable. This file is the style's DNA in data form. Artists can read
it, argue with it, and tune it; generators only read it.

### 2.2 The academic grounding

Joey's intuition — infer the rules from examples, then generate new instances
— is **inverse procedural modeling**, with a real literature:

- **Št'ava et al. 2010**, "Inverse Procedural Modeling by Automatic Generation
  of L-systems" (*Computer Graphics Forum*): the foundational paper. Input: a
  2D model of atomic elements. Method: detect similar elements, cluster their
  transformations, infer L-system rules, regenerate. Demonstrated: analyzing a
  structure, then generating *similar structures, deeper hierarchies, and
  randomized variants*. That last clause is exactly "mimic and extend."
- **Bokeloh, Wand & Seidel 2010** (SIGGRAPH): partial symmetry detection as
  the bridge to inverse procedural models — the formal version of "find the
  repeating rules."
- **Hermans et al. 2021**, "SIGI: Shape Inference and Grammar Induction for
  Example-based Procedural Generation": infers a shape grammar from
  grid-based 3D building examples and generates **new buildings in a similar
  style**. The closest published analog to what Joey wants for structures.
- **Guo et al. 2020** (SIGGRAPH Asia): inverse procedural modeling of
  branching structures via L-system inference — the vegetation path.
- **2025 (arXiv:2501.17044)**: transformer-based inversion of procedural
  buildings — the ML frontier; noted, not needed. The statistical-profile
  approach below is deliberately *simpler* than full grammar induction, and
  that is a feature: it ships.

### 2.3 Statistical profiles vs. full grammar induction (judgment call)

Full grammar induction (Št'ava/SIGI style) is powerful but heavy: it needs
clean segmented inputs and produces grammars artists can't easily tune.
**Recommendation: start with statistical profiles (§2.1), not grammars.**
Profiles are JSON artists can read; generators sample distributions from
them; the validator (§4) enforces them. If a family later needs structural
rules (buildings with real floor/window grammars), SIGI-style induction is
the documented upgrade path — the profile already holds the distributions the
grammar would need.

---

## 3. The pipeline: analyze → profile → synthesize → validate

```
┌─────────────┐    ┌──────────────────┐    ┌───────────────────┐    ┌──────────────┐
│ Asset corpus │───▶│ Corpus analyzer  │───▶│ style-profile.json │───▶│  Generators  │
│ (/assets/)   │    │ (bake-time tool) │    │ (per family)       │    │ (seeded)     │
└─────────────┘    └──────────────────┘    └───────────────────┘    └──────┬───────┘
                                                                          │
                                                                          ▼
                                                                   ┌──────────────┐
                                                                   │  Validator   │
                                                                   │ (conformance │
                                                                   │  vs profile) │
                                                                   └──────────────┘
```

### Phase A — Corpus analyzer (bake-time)

A Node script (bake-time-only code can stay JS per the project's modularity
principle) that walks the asset library and emits `style-profile.json` per
family. Runs on asset change; profiles are committed so diffs show *when the
style drifts*. Reuses the existing art-pipeline manifest validation.

### Phase B — Profile-driven generators (seeded)

Generators take `(profile, seed)` — never hardcoded style numbers. Starter set:

1. **Rocks/debris:** icosphere → sine-octave displacement (amplitudes from
   profile) → convexity check → done. The cheapest possible win and the
   perfect determinism demo (TS reference → C++ port, bit-identical goldens
   like the scatter pipeline).
2. **Vegetation:** L-system interpreter (Št'ava/Guo lineage) with branching
   parameters sampled from the profile + sine-layered wind sway at runtime.
   Analysis half now, runtime sway already covered by the GrassField work.
3. **Buildings/structures:** box-grammar composer (footprint/height/floor
   distributions from profile) — the SIGI-lite path; full grammar induction
   later if the simple version under-delivers.
4. **Texture/mask synthesis:** palette-constrained sine-warped patterns for
   detail masks (camouflage, stone banding, cloth weave) — k-means palette
   from the profile guarantees the output *colors* are the game's colors.

### Phase C — Sine detail pass (the "anything" generator)

Every generator ends with the same detail operator: profile-bounded summed
sines (displacement, UV warp, or vertex color modulation). One code path,
every asset family. The seed varies the phases; the profile caps the
amplitudes. This is where "sines generate anything" becomes an engine system
instead of a talk anecdote.

### Phase D — Style-conformance validator

Generated assets are measured with the *same* analyzer from Phase A and
checked against the profile: tri count within p95, proportions within
tolerance, palette distance under threshold, texel density in range.
Violations are warnings-first (like the DNA doc's A-series validators), errors
only for hard breaks. **The loop is closed: the thing that measures the style
is the thing that enforces it.**

---

## 4. How this fits the existing engine

| Existing system | Connection |
|---|---|
| Seeded determinism contract | Sine synthesis is analytic + seeded — satisfies it by construction |
| Scatter pipeline (TS→C++ bit-identical) | The proven porting pattern; rock generator is the next candidate |
| WFC settlement layout | Consumes profile-driven buildings as its tile set |
| Art pipeline intake validators | The corpus analyzer extends them; A-NORM/A-PACK/A-HULL/A-TANGENT (DNA doc) become profile *inputs* |
| FX lab / quality tiers | Generated assets carry their profile conformance score; over-budget variants blocked from tier promotion like over-budget emitters |
| Sim-lab bake microserver | Corpus analysis and generation are bake-time — they belong there, not in the tick |

## 5. Non-goals

- **Not a replacement for artists.** The pipeline mimics and *extends* —
  background rocks, variant vegetation, building filler. Hero assets stay
  hand-authored; the profile is *learned from them*.
- **Not ML.** No training runs, no GPUs at bake time, no black boxes. If the
  transformer-based inversion (2025) matures into something shippable, it's a
  documented future — not this pipeline.
- **Not a style change.** The analyzer measures the *current* assets; if Joey
  changes the art direction, the profiles regenerate and the generators follow
  automatically. The pipeline is direction-agnostic by design.

---

## Works Cited

Bokeloh, Martin, Michael Wand, and Hans-Peter Seidel. "A Connection Between
Partial Symmetry and Inverse Procedural Modeling." *ACM Transactions on
Graphics* 29, no. 4 (2010). doi:10.1145/1778765.1778841.

Guo, Jianwei, et al. "Inverse Procedural Modeling of Branching Structures by
Inferring L-Systems." *ACM Transactions on Graphics* 39, no. 5 (2020).
doi:10.1145/3394105.

Hermans, Gillis, Thomas Winters, and Luc De Raedt. "Shape Inference and
Grammar Induction for Example-based Procedural Generation." *Proc. Int. Conf.
on Computational Creativity* 12 (2021): 342–349. arXiv:2109.10217.

Holmér, Freya. "Math Visualization" threads and *Shaders for Game Devs*
course. Sine-layered procedural motion as core gamedev literacy.
twitter.com/FreyaHolmer; youtube.com/@acegikmo.

Št'ava, O., B. Beneš, R. Měch, D. G. Aliaga, and P. Krištof. "Inverse
Procedural Modeling by Automatic Generation of L-systems." *Computer Graphics
Forum* 29, no. 2 (2010): 665–674. doi:10.1111/j.1467-8659.2009.01636.x.

Urs Bergmann, et al. "Synthesizing 3D Abstractions by Inverting Procedural
Buildings with Transformers." arXiv:2501.17044 (2025).
doi:10.48550/arXiv.2501.17044.

---

## Field note 2026-10-22 — Sketchit ASCII RPG: data-first hydrology

Source: Joey-shared YouTube Short (@The_Sketchit, "browser ASCII RPG - now with a day and night cycle!", uploaded Sep 3 2026). Verified by watching: a 3D RPG rendered entirely from monospace text glyphs in ONE self-contained HTML file (241 KB, ~5,000 lines of JS — the font is the only texture); day/night shading done with a glyph-density ladder (heavier/lighter characters instead of brightness).

The terrain technique worth keeping: the world is a heightmap grid and the river was NOT hand-carved — the grid was flooded and steepest-descent flow cut the valley itself. Simple elevation data in, believable world out.

Relevance to this pipeline: this is the same shape as the missing bake-time erosion operator for the C++ terrain kernel (Phase 1 noise is on main; erosion phases unbuilt) and it fits the sine-toolkit philosophy — small systemic operators, data-first, deterministic. Evaluate flood + steepest-descent river carving as the first bake-time erosion operator; the alternative code-only operator is the weigert SimpleHydrology droplet-erosion port (MIT, license-cleared 2026-10-15).
