# The Stylized AAA DNA — Common Technique Backbone for the Engine

**Date:** 2026-10-06 · **Status:** Research companion · **R&D-INDEX item 8**
**Audience:** AI builders implementing the renderer backbone; the art team owns the soul.
**Scope rule:** This document covers *technique* DNA only — the reusable rendering
machinery underneath the creative work. It does not prescribe any game's look.

---

## 0. What "DNA" means here

Every beloved stylized game has a unique soul — character design, palette,
timing, world-building — that cannot and should not be copied. Underneath the
soul, though, the same dozen techniques recur across Arc System Works,
miHoYo/HoYoverse, Nintendo, and the broader anime-stylized AAA space. Those
recurring techniques are the DNA: small, cheap, well-understood rendering
decisions that separate "3D model with a toon shader slapped on" from "looks
hand-drawn."

The single most important finding from the primary sources: **the DNA is
artist-driven tooling, not exotic GPU features.** Junya Christopher Motomura
(Arc System Works, GDC talk on *Guilty Gear Xrd*'s art style) stated it
plainly — the techniques were "nothing innovative technology wise" and "could
have been done years ago"; what made Xrd look 2D was artist intention plus the
right staff with the right tools (NeoGAF summary of GDC Vault talk 1022031).
The engine's job is therefore to make the DNA *cheap to author and hard to
break* — which is a backbone and automation problem, exactly as specified.

Cost note (applies to every strand below): Xrd's full character shader ran at
60 fps on PS4 "easily" because the shader is not resource intensive; only the
PS3 port needed toning down. Stylized DNA is a *budget win*, not a budget cost
— it replaces expensive PBR machinery (normal maps, dense lights, SSR) with
cheap lookups. The rubric's frame-ms gate still applies, but expect these to
pass on the `low` tier.

---

## 1. The twelve strands

### D1 — Banded diffuse via 1D ramp lookup (the cel core)

**What:** Replace smooth N·L diffuse with a stepped lookup: `diffuse =
ramp(saturate(NdotL * 0.5 + 0.5))`. The ramp is a tiny 1D texture (often
hand-painted, 3–5 bands). Shadow *color* comes from the ramp, not from
multiplying by black — painted shadows are what keep stylized shading from
looking muddy.

**Who:** Universal. Gooch et al.'s 1998 paper formalized the cool-to-warm ramp
variant (already the basis of Exp 5's "Gooch first" plan).

**Backbone mapping:** Exp 5 material library. Every lit stylized material gets
a `shadowRamp` slot (1D LUT, default 4-band) and a `rampFeather` for the
band edge softness. Ramps are assets, versioned like textures.

**Automation hook (A-RAMP):** A bake-time generator that builds a ramp LUT
from a palette triple (light / mid / shadow colors) so artists pick colors,
not curve points. Validator: ramps must be ≤ 8 bands and monotonically
non-decreasing in luminance (catches accidental band inversion).

### D2 — Hand-authored normals instead of normal maps (Xrd's big one)

**What:** Xrd's characters (~40k triangles) used **no normal maps at all**.
Artists manually edited vertex normals so the models shaded correctly from any
light angle, eliminating unintentional shading artifacts. The shading response
is *authored*, not simulated.

**Who:** Arc System Works, *Guilty Gear Xrd* (GDC talk, Motomura).

**Backbone mapping:** The art pipeline's asset-intake validator. This is a
workflow rule with a shader consequence: the toon shader must shade well with
*only* vertex normals + ramp, no tangent-space detail required.

**Automation hook (A-NORM):** Intake linter with two checks — (a) flag any
character material carrying a normal map when the project style is anime/cel
("did you mean to author the normals instead?"), (b) a "normal comb" preview
in the editor that renders vertex normals as colors so artists can spot
shading discontinuities before baking. This is the highest-leverage automation
in the document: it encodes Xrd's core discipline as a default.

### D3 — SDF face shadows (Genshin's signature)

**What:** Faces don't use N·L shading — it looks wrong on anime faces from
most angles. miHoYo's approach: a precomputed 2D signed-distance field of the
face (in face UV space); the shader thresholds the SDF against the light
direction to place a clean, art-directable shadow shape. Reproduced in the
open-source Genshin-like shader work (kaze-mio/UnityGenshinToonShader lists
"Face Shadow, based on SDF Light Map" as a supported feature; the
Blender-miHoYo-Shaders project wires `Face_Shadow` and `FaceLightmap` textures
through the face material).

**Who:** miHoYo / HoYoverse (*Genshin Impact*, *Honkai* series).

**Backbone mapping:** Character material gets a dedicated `faceMode` branch:
SDF shadow + blush mask + reduced diffuse (per the miHoYo talk notes: "reduce
diffuse shading shadow" on faces, "vertex color mask controls diffuse
intensity"). The SDF texture is a generated asset, not hand-painted per frame.

**Automation hook (A-SDF):** A face-SDF baker: given a head mesh with a
"face" UV region, render the face mask to a texture and compute its SDF at
bake time. Regenerate on mesh change. This turns Genshin's most imitated
technique into a one-click pipeline step.

### D4 — Packed data lightmaps (Genshin's channel packing)

**What:** Genshin packs multiple material responses into one "light map":
R/B channels drive specular response, G carries baked AO, A carries a
material-type ID. One texture fetch feeds diffuse, specular, occlusion, and
branching.

**Who:** miHoYo/HoYoverse (documented in UnityGenshinToonShader's feature
list: "Light Map (R / B for specular, G for AO, A for material type)").

**Backbone mapping:** The engine's material data convention. Define the
canonical channel packing in the material spec so every toon/stylized material
in every tool agrees. Custom materials may repack, but the default packing is
the path of least resistance.

**Automation hook (A-PACK):** Intake validator that checks lightmap channel
usage against the declared packing (catches "AO baked into R by accident").
A debug view mode that visualizes each channel separately.

### D5 — Rim light (fresnel, art-directed)

**What:** A fresnel-term rim (`pow(1 - NdotV, k)`) tinted by a chosen color,
often masked by depth or brush textures and modulated by AO/shadow so rims
don't fire inside shadowed regions. miHoYo's talk notes describe "high quality
rim light" from directional light or IBL cube-map, "using fresnel masked with
brush," with AO and shadow occlusion applied.

**Who:** Universal in stylized AAA; documented in the miHoYo rendering talk
notes.

**Backbone mapping:** Standard slot on the stylized lit material: rim color,
rim power, rim mask source. Depth-based variant (like the Genshin-like
shader's "Rim Light, based on Depth Texture and Fresnel") for characters.

**Automation hook:** None needed beyond the slot — but the FX-lab budget
harness (§4 of the editor companion) should include a rim-light toggle in its
per-tier measurements, since rim is often the first thing cut on `low`.

### D6 — Outlines (inverted hull + screen-space)

**What:** Two production-proven methods:
- **Inverted hull:** render back faces extruded along normals in an unlit
  outline color, before the main mesh. Cheap, stable, art-directable per
  object (the Genshin-like shader lists "Outline, based on Back Facing").
  Documented cleanly in the Babylon thin-instance outline ADR (vertex
  displaces `position + normal * thickness`; outline renders in an earlier
  group).
- **Screen-space:** Sobel on depth + normals in a post pass (Blender "Outline
  by Normal" tutorial; several URP edge-detection implementations). Catches
  interior edges the hull misses; costs a full-screen pass.

**Who:** Universal. Xrd/Genshin-style games typically use hull for characters
and screen-space for world edges.

**Backbone mapping:** The renderer owns an outline pass with both methods
available; materials opt in per object. Outline color is *not* always black —
it should react to light (the MMDGenshin shader notes explicitly darken
outlines as lights dim).

**Automation hook (A-HULL):** Reuse the existing manifold-mesh validator from
the destruction pipeline (Exp 12 intake check): inverted hulls break on
non-manifold geometry, so the same check gates outline eligibility. Report
"outline-safe / needs repair" at intake.

### D7 — Anisotropic hair specular (Kajiya-Kay)

**What:** Hair reads as hair because of the elongated highlight along the
strand direction, not because of strand geometry. Kajiya-Kay: `specular =
pow(sinTH, power)` where `sinTH = sqrt(1 - (T·H)²)`, T = strand tangent,
H = half-vector. Dual-lobe (primary + secondary shifted highlight) is the
production standard.

**Who:** Industry standard since Kajiya & Kay 1989; still the reference in
modern hair shaders (northprojekt/hair-rendering-in-unity documents the exact
formula; recent MMD shader work pairs dual-lobe Kajiya-Kay/Scheuermann with
colored transmission).

**Backbone mapping:** Hair material in the Exp 5 library with tangent source
(UV flow or authored tangents), dual-lobe parameters, and transmission tint.

**Automation hook (A-TANGENT):** Validator that checks hair-card UVs flow
root-to-tip consistently (the #1 broken-hair-highlight cause); a debug view
rendering tangents as color.

### D8 — Wrap lighting / fake subsurface

**What:** `diffuse = saturate((NdotL + wrap) / (1 + wrap))` — wraps light
around the terminator so skin, wax, foliage don't go dead black. The cheap
stand-in for subsurface scattering that every stylized game uses.

**Backbone mapping:** Single `wrap` scalar on the stylized lit material.
Foliage gets a stronger wrap + backlight translucency term (the GrassField
evaluation in the main bundle already covers blade translucency).

### D9 — Held-frame / limited animation

**What:** Xrd's characters animate without interpolation — keyframed poses
held for 2–3 frames at 60 fps — to emulate 2D anime timing. The *game* runs at
60 fps; the *character* moves at anime rate. This is a presentation-track
decision, not a simulation one.

**Who:** Arc System Works (*Guilty Gear Xrd*; confirmed by players
frame-stepping replays).

**Backbone mapping:** The animation system's presentation layer (cf. the
editor companion §8: presentation tracks are schema-marked and never touch
simulation). Support a per-clip "hold" quantize: sample the authored curve,
then quantize to N-frame holds at runtime.

**Automation hook:** None — it's an authoring control. But the combat-timeline
validator (§8) should understand held frames so it doesn't flag quantized
clips as "missing inbetweens."

### D10 — Stylized VFX language (mesh + flipbook + dissolve)

**What:** Stylized games' effects read clearly because they're built from
*geometry* (expanding rings, arcs, cones) with scrolling procedural UVs and
flipbook textures — not from thousands of soft particles. Dissolve, fresnel
fades, and vertex-shader motion do the heavy lifting. The OpenGraphic VFX
section catalogs the vocabulary: dissolve, hologram shields, glitch, smear
frames, matcap, scan, growth, interior mapping.

**Who:** Universal across stylized action games.

**Backbone mapping:** Exp 7 (GPU particles) + the VFX graph: first-class
support for mesh emitters, flipbook sampling, dissolve-by-noise, and
fresnel-fade materials. The three.quarks evaluation (already adopted as the
authored-VFX runtime) covers the CPU-authored side.

**Automation hook (A-VFX):** A "VFX readability" checklist in the FX lab:
every effect gets a thumbnail strip at 3 distances + a frame-ms reading
(extends the editor companion §4 harness). Effects that are invisible past
10 m get flagged — the most common stylized-VFX failure.

### D11 — Gradient sky + ramped height fog

**What:** Stylized skies are gradient ramps (2–3 stops, often with a painted
sun disc and stylized clouds), not physical atmosphere. Fog is height-based
with a *color ramp*, so distance melts into the sky gradient instead of gray.
The WaterFloor/sky evaluations in the main bundle already point this way;
this strand makes it canonical.

**Backbone mapping:** Sky and fog are first-class engine systems with ramp
assets, not shader one-offs. Season/time-of-day presets (from the GrassField
evaluation) drive the same ramps.

### D12 — Color grading LUT as the unifying pass

**What:** The final 5% that makes everything cohere: a single color-grading
LUT applied in post. Every screenshot that "looks like the game" has it;
without it, individually-correct materials look disjointed.

**Backbone mapping:** Post chain ends with a LUT slot; LUTs are assets with
preview in the editor. The `low` tier keeps the LUT (it's nearly free) and
cuts volumetrics instead.

---

## 2. Backbone integration map

| DNA strand | Engine owner | Experiment / system |
|---|---|---|
| D1 banded diffuse + ramps | Material library | Exp 5 (extends Gooch plan) |
| D2 authored normals | Art pipeline intake | New: A-NORM linter |
| D3 SDF face shadows | Character material | New: A-SDF baker |
| D4 packed lightmaps | Material spec | New: A-PACK validator |
| D5 rim light | Lit material slots | Exp 5 |
| D6 outlines | Renderer outline pass | New: A-HULL check (reuses Exp 12 manifold validator) |
| D7 Kajiya-Kay hair | Hair material | Exp 5; A-TANGENT validator |
| D8 wrap lighting | Lit material scalar | Exp 5 |
| D9 held frames | Animation presentation | Timeline validator (§8 companion) |
| D10 stylized VFX | VFX graph + FX lab | Exp 7; three.quarks; A-VFX checklist |
| D11 sky/fog ramps | Environment system | Exp 6/9 extensions |
| D12 grading LUT | Post chain | Quality tiers (`quality.ts`) |

## 3. Automation roadmap (phased)

**Phase 1 — intake validators (cheap, immediate):** A-NORM (normal-map flag +
normal-comb preview), A-PACK (channel packing check), A-HULL (manifold check
for outlines), A-TANGENT (hair UV flow check). All run at asset intake; all
are warnings-first, errors only for hard breaks.

**Phase 2 — bakers (bake-time generation):** A-SDF (face SDF from mesh),
A-RAMP (ramp LUT from palette triple). Run on asset change; outputs are
versioned assets.

**Phase 3 — lab integration:** A-VFX readability strip in the FX lab;
rim-light tier measurements; outline method picker (hull vs screen-space) with
measured cost per scene.

## 4. Non-goals (stated explicitly)

- **No style prescription.** The DNA is the *machinery*; the soul (character
  design, palette, timing) belongs to the art team and Joey's supplied assets.
- **No PBR replacement.** The anime-vs-PBR open question (main bundle §7)
  stands; several DNA strands (ramps, wrap, grading) apply to stylized PBR too.
- **No engine plugins adopted from this research.** OpenGraphic is a map, not
  a shopping list — every adoption still goes through the rubric's
  cost/benefit gate and the server-authoritative contract where applicable.

---

## Works Cited

Arc System Works. *Guilty Gear Xrd's Art Style: The X Factor Between 2D and
3D*. GDC Vault, talk 1022031, presented by Junya Christopher Motomura.
Summarized via NeoGAF thread "Guilty Gear Xrd's Artstyle GDC Talk,"
www.neogaf.com/threads/guilty-gear-xrds-artstyle-gdc-talk.1026430/. Key
technical points: ~40k-triangle characters, no normal maps, hand-edited vertex
normals, "nothing innovative technology wise," 60 fps on PS4.

Blender-miHoYo-Shaders. Festivities, GitHub. Face/body material wiring
(`Face_Shadow`, `FaceLightmap`, shadow/specular ramps) replicating miHoYo
shading. github.com/festivities/Blender-miHoYo-Shaders.

Gooch, Amy, et al. "A Non-Photorealistic Lighting Model for Automatic Technical
Illustration." *SIGGRAPH 1998*. Cool-to-warm ramp shading basis.

HoyoToon. jamestiotio, GitHub. Unity shader replicating HoYoverse shading:
real-time/baked lighting, stencil hair transparency, VFX shaders, automated
setup scripts. github.com/jamestiotio/HoyoToon.

Increasinglyhuman. "ADR-002: Inverted-Hull Outline Technique."
babylon-thin-instance-outline docs. Vertex displacement along normals, render
before source mesh. github.com/increasinglyhuman/babylon-thin-instance-outline.

Kajiya, James T., and Timothy L. Kay. "Rendering Fur with Three Dimensional
Textures." *SIGGRAPH 1989*. Anisotropic Kajiya-Kay specular basis for hair.

Kaze-mio. UnityGenshinToonShader. Genshin-like URP toon shader feature list:
packed light map (R/B specular, G AO, A material type), SDF face shadow, rim
light, back-face outline. github.com/kaze-mio/UnityGenshinToonShader.

MMDGenshin. Hoyotoon, GitHub releases. Outline darkening with light, face
material soft-shadow logic. github.com/Hoyotoon/MMDGenshin/releases.

Motomura, Junya Christopher. See Arc System Works GDC talk above.

Northprojekt. hair-rendering-in-unity. Kajiya-Kay formula documentation and
hair-card best practices. github.com/northprojekt/hair-rendering-in-unity.

OpenGraphic. Gforcex, GitHub. Curated graphics/game-engine open-source list
(2,288 stars); Stylize section (NPR, Low Poly) used as the research map.
github.com/Gforcex/OpenGraphic.
