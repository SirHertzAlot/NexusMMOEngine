# Scholarly Findings — Shader & FX R&D

Compiled 2026-10-01. **Citation-audited 2026-10-01** (see Audit Log at the
end). Sources span university-hosted material (.edu course notes and
papers), industry publications (EA/DICE, NVIDIA, Sony GDC), ACM/SIGGRAPH
peer-reviewed papers, and standard oceanography references. Every entry is
labeled with its source type — the original draft overstated the .edu
coverage, and the audit corrected that. Each finding is quoted or closely
paraphrased from its source, then mapped to what it means for the
NexusMMOEngine client and which R&D experiment it feeds.

---

## 1. The philosophy: convey meaning, not light

**Source:** CMU 15-466, Non-Photorealistic Rendering notes —
<http://graphics.cs.cmu.edu/courses/15-466-f18/notes/npr.html>

> "The idea of non-photorealistic rendering gets to the very heart of what
> computer graphics *is*. That is, it isn't the goal of computer graphics to
> simulate light, it is the goal of computer graphics to convey meaning."

The notes frame NPR around three operations: **abstraction** (remove
unimportant detail), **ambiguity** (remove important detail deliberately),
and **emphasis** (highlight important detail). The key *problem* they name
for games is **temporal continuity** — stylized effects must be stable
frame-to-frame, which is why temporal stability matters more for a
stylized look than for a realistic one (shimmer destroys the style).
*[Author inference: the notes never mention TAA. The TAA connection is
ours; Experiment 3 tests it.]*

**What this means for us:** our art direction gets a one-sentence test —
every shader choice should answer "what meaning does this convey?" The
post-process edge highlighting they recommend (depth + normal discontinuity
filter) comes with honest caveats we should respect: resolution-dependence,
the 1-pixel-edge problem, and tuning cost. Prefer inverted-hull outlines on
characters (resolution-independent) and reserve screen-space edges for
static illustrative moments.

**Feeds:** Experiment 5 (material library), Experiment 3 (TAA evaluation).

---

## 2. Gooch shading — hue shift without dynamic range

**Source:** Gooch, Gooch, Shirley & Cohen (1998), *A Non-Photorealistic
Lighting Model For Automatic Technical Illustration*, University of Utah —
<https://www2.cs.utah.edu/gdc/publications/papers/gooch98.pdf>
(also <https://users.cs.northwestern.edu/~bgooch/PDFs/gooch98.pdf>).
Peer-reviewed: SIGGRAPH '98, DOI 10.1145/280814.280950.

> "Phong-shaded 3D imagery does not provide geometric information of the
> same richness as human-drawn technical illustrations."

The paper's core move: use **both luminance and hue** to indicate surface
orientation — cool blue for surfaces facing away, warm tan for surfaces
facing the light — blending between `kcool` and `kwarm` by the cosine term
(l·n) (in modern notation, `mix(kcool, kwarm, NdotL)`; the paper's Eq. 2
uses (1±l·n)/2 weights). The killer
insight for us:

> "…adding a somewhat artificial hue shift to shading helps imply shape
> without requiring a large dynamic range."

*(Ellipses: the paper's sentence opens "As artists have discovered," —
dropped for brevity.)*

Shading is deliberately kept to **mid-tones**, reserving extreme lights and
darks for edge lines and highlights so they stay prominent. The paper also
covers a metal variant of the model.

**What this means for us:** this is the cheapest AAA-stylized upgrade we
have. A Gooch term costs one `mix()` and two uniforms, works on any
material, and — critically for an MMO — it keeps characters readable in
dark caves and bright snow without blowing out the tone mapper. It pairs
with cel ramps: Gooch for the hue story, ramp for the tone steps.
Prototype it on the player-frame character first (highest screen time).

**Feeds:** Experiment 5 (material library v1). ~5 ALU, 0 textures.

---

## 3. Scalable real-time stylized animation

**Source:** Lake et al. (2000), *Stylized Rendering Techniques For Scalable
Real-Time 3D Animation* — via UT Austin CS354 lecture notes —
<https://www.cs.utexas.edu/~theshark/courses/cs354/lectures/cs354-20.pdf>

The lecture frames the scalability question directly: stylized techniques
must survive real-time budgets *at scale*. Companion finding from the same
lecture, on what creates a style at all:

> "Style is shaped by: **Strokes, Textures, Lighting, Simulation**."

(Haeberli '90, *Paint by Numbers*, is cited as the stroke-based root.)

**What this means for us:** treat "style" as four independent dials, not one
shader. Our R&D already covers three (textures: surfaces pipeline; lighting:
rig; simulation: wind/particles). The missing dial is **strokes** — and the
lecture's stroke taxonomy (width, density, orientation, color, opacity,
texture) is the design vocabulary for a future in-editor stroke system.
For now: the scalability framing justifies our per-experiment perf gates —
a technique that can't hold 60fps with 100 players on screen isn't a style,
it's a demo.

**Feeds:** all experiments (gating philosophy); future editor stroke tools.

---

## 4. Sky, atmosphere & clouds — the Frostbite lineage

**Source:** Hillaire, S. (2016), *Physically Based Sky, Atmosphere and Cloud
Rendering in Frostbite*, SIGGRAPH 2016 Course ("Physically Based Shading in
Theory and Practice") —
<https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf>
— 62 pages of **written** course notes (quotable at fine grain, unlike
slide decks). **Source type: industry course notes (EA/DICE) — not
peer-reviewed, not .edu.**

Compelling findings:

- **Single-channel noise** for clouds (§5.4): *"we simply use a single
  component volume texture representing the final single channel noise.
  This made cloud a lot faster to render thanks to the reduction of
  required memory bandwidth still giving the same final visual result."*
  A direct optimization we can steal if we ever do volumetric-ish clouds.
- **Cloud shadows** baked to a 2D transmittance texture, projected onto
  the world — *and feeding GI* (§5.9: *"volumetric cloud shadows are baked
  into a 2D texture storing transmittance and projected onto the world…
  also sampled when updating input to our dynamic global illumination
  system"*). **Cost correction:** the widely quoted **0.91ms at 720p on
  Xbox One** is the cost of the **main cloud-view rendering pass**
  (half-resolution cloud buffer, worst-case horizon view, ⅗ cloud
  coverage, 16 samples/pass, multi-scattering N=2 — Table 4, §5.10). It
  is *not* the shadow-bake pass: **no timing is published for the
  shadow bake anywhere in the notes.** Do not budget cloud shadows at
  0.91ms.
- **Caveat, quoted exactly** (§5.9): *"The projection is very simple and
  assumes a overall flat planet around the camera, which is reasonable to
  assume for typical planets."* The source is more permissive than our
  first draft claimed — it does not say large terrain breaks it. *[Author
  inference, kept: our world is large and seamless, so if we bake cloud
  shadows we will still use chunk-local (or spherical) projection rather
  than one planar projection — cheap insurance against the assumption.]*

**Companion paper:** Bouthors, Neyret, Max, Bruneton & Crassin (2008),
*Interactive Multiple Anisotropic Scattering in Clouds*, I3D 2008 —
doi:10.1145/1342250.1342277 *(DOI string corroborated via hgpu.org and an
independent HAL citation; doi.org returned 403 from the audit environment,
so end-to-end resolution is unconfirmed)*. Peer-reviewed (ACM I3D
symposium). The Monte-Carlo reference behind real-time cloud claims —
per-order transport tabulated by Monte-Carlo with a 5% confidence
interval at the 95% level (10M parameter samples, ~25GB raw; Appendix A
of the authors' text) — with the verdict that still stands:
Henyey–Greenstein phase functions are *"loin de donner des résultats
visuels précis"* — far from giving accurate visual results (§2.2; our
English rendering of the French original). If our sky work ever touches
clouds: don't trust HG alone.

**What this means for us:** our day/night dome is good; the next step is
*not* full volumetrics but Hillaire's two cheap wins — noise-optimized
cloud layer + projected cloud shadows. Both fit our perf budget; the
projection gets the chunk-local treatment by design.

**Feeds:** Experiment 8 follow-on (sky depth); cloud-shadow experiment.

---

## 5. Spherical harmonics & precomputed radiance transfer — ambient for free

**Sources** (reading-list mirrors at National Taiwan University,
`csie.ntu.edu.tw` — note: **.edu.tw is a Taiwan academic domain, not
.edu**; the mirrors' live status could not be confirmed from the audit
environment (HTTP 401, likely bot-blocking), so canonical sources are
given below):

- Green, R. (2003), *Spherical Harmonic Lighting: The Gritty Details* —
  **GDC 2003 industry talk + whitepaper (Sony R&D), not peer-reviewed**
  — the practical SH cookbook. (Original Sony URL defunct; NTU mirror
  secondary.)
- Ramamoorthi & Hanrahan (2001), *An Efficient Representation for
  Irradiance Environment Maps* — **peer-reviewed, SIGGRAPH 2001** —
  **9 coefficients** capture diffuse irradiance (the paper's abstract:
  *"only 9 coefficients… in order to achieve average errors of only
  1%"*). This is the paper behind every IBL ambient term. (Canonical:
  ACM DL / Stanford graphics lab; NTU mirror secondary.)
- Sloan, Kautz & Snyder (2002), *Precomputed Radiance Transfer for
  Real-Time Rendering in Dynamic, Low-Frequency Lighting Environments* —
  **peer-reviewed, SIGGRAPH 2002** — bake complex light transport once,
  relight dynamically. (Canonical: ACM DL / ppsloan.org.)
- Sloan, Hall, Hart & Snyder (2003), *Clustered Principal Components for
  Precomputed Radiance Transfer* — **peer-reviewed, SIGGRAPH 2003** —
  PRT that scales. (Canonical: ACM DL / ppsloan.org.)

**What this means for us:** two concrete upgrades. First, our ambient light
can move from a flat hemisphere color to **9-coefficient SH irradiance**
sampled from the sky dome — the sky already changes with time of day, so
the ambient would follow it *for free*, grounding characters in the scene
at dawn/dusk/night. That's maybe 20 lines in the lighting rig. Second,
PRT is the long-term answer for static-geometry GI (caves, taverns): bake
once per chunk, relight as the day cycle moves. Park PRT behind Experiment
2's verdict — only if the LTC rig leaves perf headroom.

**Feeds:** Experiment 2 (lighting rig — SH ambient now; PRT later).

---

## 6. Water — the canon, the costs, and two warnings

**Sources:**

- Tessendorf, J. (2001/2004), *Simulating Ocean Water*, SIGGRAPH course
  notes, Clemson University —
  <https://people.computing.clemson.edu/~jtessen/reports/papers_files/coursenotes2004.pdf>
  **(course notes, not peer-reviewed; .edu ✓)**. The canon: spectrum
  sampling → inverse-FFT displacement, choppiness, Jacobian folding.
  On performance, Tessendorf's actual words: *"512 × 512 FFTs can be
  generated at **nearly** interactive rates"* — on a **1+ GHz CPU** (not
  GPU), circa-2004 hardware.
- Finch, M. (2004), *Effective Water Simulation from Physical Models*,
  GPU Gems ch. 1 **(industry book chapter, NVIDIA — not .edu)** —
  Gerstner/trochoid shaping: crests sharpen, troughs flatten, no
  numerical derivatives needed. (Finch sums **four** geometric waves and
  gives **no millisecond figures** — he is not the source of any timing
  claim below.)
- Yuksel, House & Keyser (2007), *Wave Particles* — **peer-reviewed,
  ACM Trans. Graph. 26(3) / SIGGRAPH 2007** (not .edu) — Lagrangian
  alternative: wave-energy particles advected over the domain, rasterized
  to displacement. Worth knowing if FFT ever proves too rigid.
- Bruneton, Neyret & Holzschuch (2010), *Real-time Realistic Ocean
  Lighting using Seamless Transitions from Geometry to BRDF*, Computer
  Graphics Forum 29(2):487–496, §7.3 — **peer-reviewed** — the true
  source of the cost figure below. *(Cited via a detailed secondary
  quotation of §7.3; the direct PDF fetch timed out in the audit
  environment. The quoted numbers are arithmetically self-consistent.)*

**The numbers that justify our current approach** (Bruneton et al. 2010,
§7.3, on an **NVIDIA GeForce 8800 GTS** — launched November 2006):
**19.2ms at 1024×768**, viewed horizontally from 4m up — breaking down
as **11.1ms** for wave position/normal/slope-variance plus **8.1ms**
for shading (the figure is the full water pipeline, not the wave sum
alone). 19.2/16.67 ≈ 1.15 — 15% over a 60fps frame *for water alone*,
on hardware two decades old. Same passage: 87fps (11.5ms) at 1000m,
130fps (7.7ms) at 8000m. Our three-swell-train approach is the right
call; Tessendorf FFT is there if we ever need open-ocean hero shots.

**Two warnings that apply directly to our shoreline work:**

1. **[Author engineering guidance — no scholarly source.]** **Never add
   energies at the shore.** Cross-fade wave energy *down* as the shore
   foam band comes up — added energy doubles wave height exactly where
   shoaling already boosts it, producing a wall of water. None of the
   cited sources cover this (Tessendorf explicitly excludes breaking
   waves, spray, and foam); it stands as our own rule, enforced in
   Experiment 9's acceptance stills.
2. **Fetch-limited water** (verified oceanography: JONSWAP is the
   fetch-limited spectrum — Hasselmann et al. 1973; MIT OCW notes
   describe it as developed *"for the limited fetch North Sea"*). Our
   world has lakes, not oceans: long-period swells never develop in
   sheltered water. *[Author application: lakes get high-frequency chop
   and capillary ripple, not ocean swell — use a separate, cheaper lake
   spectrum.]*

**Feeds:** water R&D (foam advection, lake spectrum split).

---

## 7. Reading list (in R&D order)

| # | Source | Type | Use |
|---|--------|------|-----|
| 1 | Gooch et al. 1998 (Utah) — `gooch98.pdf` | Peer-reviewed (SIGGRAPH 98); .edu ✓ | Hue-shift shading, ~5 ALU |
| 2 | CMU 15-466 NPR notes | Course notes; .edu ✓ | Style philosophy, edge-highlight caveats |
| 3 | Lake et al. 2000 (via UT Austin CS354 slides) | Course slides (secondary); .edu ✓ | Scalability framing, style-as-four-dials |
| 4 | Hillaire 2016, Frostbite sky course | Industry course notes (EA/DICE); **not** .edu | Cloud noise opt, projected cloud shadows |
| 5 | Ramamoorthi & Hanrahan 2001 | Peer-reviewed (SIGGRAPH 01); NTU mirror secondary (.edu.tw ≠ .edu, live status unverified) | 9-coeff SH irradiance for ambient |
| 6 | Green 2003 | GDC industry talk/whitepaper (Sony); NTU mirror secondary | SH implementation cookbook |
| 7 | Tessendorf 2001/04 (Clemson) | Course notes; .edu ✓ | Ocean canon, FFT cost figures |
| 8 | Bruneton, Neyret & Holzschuch 2010 | Peer-reviewed (CG Forum 29(2)) | The 19.2ms water figure (11.1 + 8.1) |
| 9 | Finch 2004, GPU Gems 1 | Industry book chapter (NVIDIA); **not** .edu | Gerstner shaping we already use |
| 10 | Yang, Liu & Salvi 2020, TAA survey | Peer-reviewed STAR (CG Forum 39(2)) | True home of the 0.14→0.52ms TAA numbers |
| 11 | Karis 2014 | SIGGRAPH course talk; **not** peer-reviewed | TAA recipe (Halton jitter, motion-vector reprojection, neighborhood clamp) — no cost numbers |
| 12 | Sloan et al. 2002/2003 | Peer-reviewed (SIGGRAPH 02/03); NTU mirrors secondary | PRT for static-geometry GI (later) |
| 13 | Bouthors et al. 2008 (I3D) | Peer-reviewed (ACM I3D 08) | Cloud scattering reference + HG caveat |
| 14 | Yuksel et al. 2007 | Peer-reviewed (ACM TOG / SIGGRAPH 07) | Wave particles (alternative, parked) |
| 15 | UT Austin CS354 (Haeberli '90 cited within) | Course slides (secondary); .edu ✓ | Stroke-based style vocabulary (editor future) |
| — | Hasselmann et al. 1973 (JONSWAP) | Standard oceanography | Fetch-limited spectrum for lakes |

---

## Audit Log — 2026-10-01

Three independent verifiers fetched every primary source (`browser.open`
on the URL or PDF, `browser.search` where fetches failed) and checked
reachability, .edu status, quoted passages, and numbers. Corrections
applied to this doc:

1. **Header honesty:** the original claimed compilation "from
   university-hosted sources (.edu domains)." False for most of the
   bibliography — corrected to describe the actual mix, with per-entry
   type labels.
2. **CMU §1:** the "TAA matters more for stylized looks" sentence was
   presented as following from the notes; the notes never mention TAA.
   Re-attributed as author inference.
3. **Gooch §2:** quote given ellipsis convention for the dropped
   lead-in; `mix()` marked as modern notation (paper: Eq. 2,
   (1±l·n)/2); venue + DOI added.
4. **Hillaire §4:** canonical EA URL added; industry/not-.edu labeled;
   0.91ms re-attributed to the main cloud-view pass (shadow-bake cost
   unpublished); "large terrain breaks it" replaced with the source's
   actual flat-planet sentence, our caution kept as labeled inference;
   single-channel-noise quote restored with its elided clause; Bouthors
   DOI caveat noted.
5. **SH/PRT §5:** NTU mirrors labeled .edu.tw (academic, not .edu) with
   unverified live status; canonical sources given; Green labeled GDC
   industry talk; venues/peer-review status per paper.
6. **Water §6:** 19.2ms re-attributed to Bruneton et al. 2010 §7.3
   (GeForce 8800 GTS, 11.1 + 8.1 breakdown, 1000m/8000m figures);
   Tessendorf perf line corrected to his exact words (CPU, "nearly"
   interactive); Finch labeled industry chapter (4 waves, no ms
   figures); Yuksel labeled peer-reviewed; shore-energy warning
   relabeled as author guidance; JONSWAP verified, lake application
   labeled as ours.
7. **TAA numbers:** the 0.14ms @1080p → 0.52ms @4K figures belong to
   Yang, Liu & Salvi (2020) §7 Table 1 (UE4, RTX 2080 Ti) — not Karis
   2014, whose cost claim is qualitative only. Karis's recipe confirmed
   as motion-vector (not depth) reprojection.
8. **NTU mirror URLs** (cited 2016 reading list, live status
   unverified): Green2003SHL, Ramamoorthi2001AER, Sloan2002PRT,
   Sloan2003CPC under `csie.ntu.edu.tw/~cyy/courses/rendering/papers/`.

Standing rule from this audit: **a number without a citable source and
hardware attribution does not enter this bundle.** Borrowed numbers
never gate a merge — only our measured numbers on named hardware do
(see `SHADER-EXPERIMENTS.md` §0.4).
