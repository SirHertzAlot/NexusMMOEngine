# Three.js Conf 2026 (Paris) — Deep Dive Findings

**Source event:** the first dedicated three.js conference, Paris 2026.
**Reports used:** Codrops/Tympanus conference write-up (2026-09-10),
ICS Media conference report (entry 260925). Talk recordings referenced
where noted.
**Written:** 2026-10-09. Status: research; verdicts below are recommendations,
not locked decisions.

## 1. The talks that matter

### 1a. Anderson Mancini — ambitious WebGPU under a strict budget

Mancini showed how techniques borrowed from games let him build rich
WebGPU environments under a hard technical budget — the whole experience
around **~6MB**. The headline technique: **octahedral impostors** for
rendering large numbers of trees efficiently. His stated method: start
with the visual goal, set the technical limits early, then find creative
ways around them.

Why this talk matters to us: it is our cost/benefit gate, presented on
stage. The 6MB figure is an existence proof that aggressive budgeting
produces richness, not poverty.

### 1b. Renaud Rohlinger (UTSUBO) — "Waves of Connection," Expo 2025 Osaka

An interactive installation: up to six visitors interact with a huge
digital body of water, **~1M particles in real time with WebGPU**,
inspired by Hokusai's waves. (Note: he controlled the hardware as well
as the software — installation numbers don't transfer 1:1 to consumer
laptops.)

Transferable techniques from the talk:

- **Measure rendering costs in milliseconds**, then attack draw calls,
  depth processing, and overdraw one at a time.
- **Single-triangle sphere impostors:** each particle is one triangle;
  the shader makes it read as a sphere. Same impostor philosophy as §2.
- **Deferred particle shading:** after overdraw from overlapping
  particles stayed expensive, they changed approach — first record the
  visible particle's ID and depth per pixel, *then* compute color and
  shading. Overdraw collapses because shading runs once per pixel, not
  once per overlapping particle.
- The techniques ship as Three.js BLOCKS (library + AI-assistant skills).

### 1c. Misha Kiiatkin — hand-painted low-poly to three.js

Pipeline talk for a game: simple low-poly models + hand-painted textures,
optimized via **texture atlases, KTX2 compression, and geometry
batching** — keeping the creative process fast without sacrificing style.

Why it matters: it validates our art-pipeline direction (bake-time
optimization, manifest discipline) and nominates **KTX2 as a bake output
format** to evaluate.

### 1d. GSAP 4 — announced by Cassie Evans

First major version since GSAP 3 (November 2019). Feature details were
thin at announcement; nothing in the reports changes a technical decision
today. Relevance to us is narrow: editor UI and client HUD tweens, not
the 3D engine (our animation runtime is ozz/three.js mixer). Verdict:
**watch**, revisit when the feature list and license terms are public.

## 2. Deep dive: octahedral impostors

The problem: forests are the classic MMO perf killer. Thousands of
trees × thousands of polygons, each an instanced draw with alpha-tested
foliage = vertex cost plus catastrophic overdraw.

The technique, in brief:

1. **Bake:** render the tree from N viewpoints distributed on a sphere
   (hemisphere is enough for trees — nobody views them from below) into
   a texture atlas: albedo + object-space normal + depth per view.
2. **Encode directions octahedrally:** a 3D view direction maps to a 2D
   UV via octahedral projection, packing the sphere into a square atlas
   grid with low distortion.
3. **Runtime:** each distant tree is **one camera-facing quad**. The
   shader decodes the view direction, finds the 3 nearest atlas cells,
   and blends them with barycentric weights — smooth angular transitions,
   no popping. Baked depth drives a parallax offset so the quad reads as
   volume; baked normals mean it still lights correctly (and can sway —
   wind animation survives as a vertex-shader bend).
4. **Result:** Microsoft Flight Simulator's forests are essentially this
   everywhere except near the camera. One quad + a few texture taps per
   tree, at any distance.

Lineage: the canonical reference is Ryan Brucks, "Advanced Octahedral
Impostor System" (Epic, 2015–2017; ships as UE4/5's built-in Impostor
Baker). Prior art includes Max & Ohsaki 1995 (precomputed z-buffer tree
views), Crytek's GDC 2013 vegetation impostors (~32 hemi views), and
Häggström's thesis on real-time vegetation LOD chains. Live
implementations to study (not vendor): `wojtekpil/Godot-Octahedral-
Impostors`, Bevy's `bevy_octahedral`, and `korbindeman/thalos` (Rust/WGSL;
reports trees reaching 2.2→3.6 km at a quad apiece).

## 3. Papers and references (ranked)

1. **Brucks, Ryan. "Octahedral Impostors."** shaderbits.com, 2015–2017.
   The canonical reference — the math plus the production UE
   implementation. Start here. (Blog post, not a formal paper; it is
   still the document the field cites.)
2. **Max, Nelson & Ohsaki, Keiichi. "Rendering trees from precomputed
   z-buffer views."** Eurographics Rendering Workshop, 1995. The
   original precomputed-view tree paper; the conceptual ancestor.
3. **Häggström (thesis). "Real-Time Rendering of Vegetation."** Clean
   coverage of LOD chains, impostors, and the underlying math.
4. **Crytek. "Vegetation Impostors."** GDC 2013. The ~32-hemi-view
   production approach; good bake-density reference point.
5. **"SpeedTree integration in CryEngine 3."** GPU Gems 3. Best primer
   on tree LOD chains end to end (mesh LODs → cards → impostors).
6. **NTUST. "Real-time appearance-driven memory-efficient dense canopy
   synthesis."** 2026. Related but distinct: compresses canopy
   appearance into proxy light fields with perceptual validation. Worth
   reading for the *evaluation method* (user studies on perceived
   realism) more than the technique.
7. **three.js discourse: "A forest of octahedral impostors."** Practical
   three.js-specific discussion, including the no-popping condition:
   substitute the impostor only where it occupies ≤ the bake
   resolution's screen space.

## 4. Where we benefit — verdicts

### ADOPT (as technique, reimplemented): octahedral impostor baker

This is the single biggest find. It fits our architecture on every axis:

- **Bake-time, like everything expensive we do.** The atlas baker runs
  at bake; the runtime is a quad and a shader. Deterministic output,
  golden-testable.
- **Presentation-only, like splats.** The server never knows or cares —
  clean for the authoritative contract.
- **Plugs into style-driven procgen:** the corpus analyzer already
  extracts per-family style profiles; the impostor baker consumes the
  same tree families and emits one atlas per species.
- **Completes the LOD chain:** full mesh → reduced mesh → composite
  cards → octahedral impostor, mapped onto the existing 4-tier quality
  presets. The discourse thread's no-popping condition becomes a bake
  validator.
- **License-clean by construction:** we reimplement from Brucks'
  write-up (standing rule: reimplement, don't vendor). No dependency.

Cost gates before it earns its place: atlas memory per species (with
KTX2), bake time per species, and the distance threshold where the swap
is invisible — all measured, per the rubric.

### ADOPT SELECTIVELY: Rohlinger's particle discipline

- **Deferred particle shading (ID+depth prepass, shade once per pixel)**
  is directly applicable to our VFX layer (three.quarks): overdraw is
  the dominant particle cost, and this is the structural fix. Evaluate
  against the current CPU-cost measurement work.
- **Single-triangle sphere impostors** for round particles — same
  philosophy as §2, trivial to trial.
- **Measure in ms** is already our discipline; the talk is corroboration,
  not news.
- Caveat: the 1M-particle number is WebGPU compute on controlled
  hardware. The *techniques* transfer to our WebGL2-first client; the
  *number* does not. Do not cite it as our budget.

### EVALUATE: KTX2 as bake output

Nominated by Kiiatkin's talk; also the natural container for impostor
atlases. Gate: decode cost on target hardware vs. current formats, and
toolchain fit with the manifest-validated art pipeline.

### WATCH: GSAP 4

Revisit for editor/client-HUD tweening when features and license are
public. Not a 3D-engine decision.

## 5. Concrete next steps (proposed, not scheduled)

1. **Impostor baker spike:** bake albedo+normal+depth octahedral atlas
   for one procgen tree species; runtime quad + decode shader in the
   client; A/B stills vs. full mesh at the swap distance. Gates: atlas
   bytes, bake seconds, invisibility of the swap.
2. **VFX overdraw audit:** measure current particle overdraw cost in
   three.quarks scenes; trial the ID+depth prepass on the worst case.
3. **KTX2 eval:** decode benchmarks on target hardware; toolchain fit
   check against the art pipeline manifest.

None of these are scheduled work — they are the ranked backlog this
deep dive produces.
