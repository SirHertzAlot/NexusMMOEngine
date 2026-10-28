# CPU Lightmap / Probe Baker — Project Brief

**Status:** Scoping brief only (2026-10-23). No code written, nothing vendored,
no repo changes. A developer can start from this document; Joey's word starts
the build.
**Origin:** `~/workspace/your_files/mmo-engine-graphics/CPP-AAA-GRAPHICS-RESEARCH.md`
— the trio is that report's #1 ADOPT ("the bake-time GI trio"), re-verified
live against GitHub on 2026-10-23 (see the gate table in §5).

---

## 1. Purpose and scope

Build one new stage for the art bake pipeline: a **CPU lightmap and light-probe
baker** for static geometry, composed from three permissive libraries:

- **xatlas** — generates the unique, non-overlapping lightmap UV set (UV2).
- **Embree** — CPU ray tracing: direct light, shadow visibility, and indirect
  bounce sampling per lightmap texel and per probe.
- **OIDN** — ML denoising (`RTLightmap` filter mode), so the baker can run at
  low samples-per-texel and still ship clean lightmaps.

### In scope

- Per-asset lightmaps for static geometry: structures, props, dungeon pieces —
  the content the settlement/world bakes place in quantity.
- Scene-level light probes: a grid (or per-structure set) of irradiance probes
  baked against the placed scene, so dynamic objects (characters, creatures,
  dropped items) pick up matching ambient light at runtime.
- Bake-time only. The baker runs on the dev/bake machine alongside the
  existing bake tools. **Zero runtime cost** beyond what the client already
  pays for any textured material: lightmap textures are data, and probe
  lookup is a client shader concern (see open questions, §8).

### Out of scope

- No runtime renderer work; nothing under the client's render loop changes as
  part of this brief.
- No dynamic/moving-object lightmaps (characters and creatures use probes).
- No pipeline redesign: the baker slots between existing stages (§3) and
  speaks the pipeline's existing currency — glTF in, glTF + sidecar data out.
- No vendoring until every gate in §5 passes.

---

## 2. Cost / benefit gate (standing rule)

**Benefit.** The game's placed content is overwhelmingly static: towns of
300+ structures, props, resource nodes, dungeon geometry. Baking their
lighting once buys soft shadows, bounce, and grounded ambient occlusion on
hardware the runtime renderer could never ray-trace on — including the
low-end clients the perf budgets protect — for the cost of texture memory
and a second UV channel. Probes extend the same baked look to everything
that moves.

**Cost.** One more bake stage (bake time per asset/scene, to be measured in
the pilot — no honest number exists yet), lightmap texture memory at
runtime, and real pipeline complexity: UV2 must survive every later stage
intact (§3, gate G4).

**Verdict shape.** Worth building *if* the pilot (§7) shows bake times and
texture sizes compatible with the existing bake budgets. That is a
measurement, not an assumption.

---

## 3. Where the stage sits in the existing pipeline

Existing adopted stages (unchanged):

| Stage | Tool | Job |
|---|---|---|
| Cleanup / texture conversion | gltf-transform | Normalize incoming GLBs, convert textures |
| Animation bake | ozz-animation (N-API) + ACL | Skeletal runtime data + clip compression |
| Procedural content | EZ-Tree | Bake-time trees |
| Geometry encode | gltfpack (meshoptimizer) | Final geometry encode for delivery |
| World / settlement bake | engine bake scripts | Placed scenes, towns, world data |

The baker inserts as **one stage with two passes**, after cleanup and
before geometry encode:

```
glTF source
  → gltf-transform (cleanup, texture conversion)          [existing]
  → PASS A: xatlas — generate UV2 (lightmap UV set)       [NEW]
  → PASS B: Embree bake + OIDN denoise                    [NEW]
        · per-asset lightmaps (static meshes)
        · scene probe bake (placed scenes from world/settlement bake)
  → texture conversion incl. lightmaps (KTX2)             [existing stage, extended input]
  → gltfpack (geometry encode)                            [existing]
  → delivery artifacts
```

Why this position:

- **UV2 before encode, not after.** Lightmap charts decide their own vertex
  splits (chart seams). The encoder must receive geometry that already has
  UV2 and must preserve it — encoding first and unwrapping after would put
  the unwrap on already-welded/simplified geometry and fight the encoder.
- **After cleanup.** The baker should consume the same normalized geometry
  every other stage sees, so material/light decisions are made once.
- **Probe pass consumes placed scenes.** Probes are scene-level: the probe
  pass takes the settlement/world bake's placed static geometry (the same
  scene data the server spawns) as its ray-tracing world, and emits probe
  data keyed to that scene.
- **Animation stages are untouched.** Skinned/animated assets skip Pass A/B
  entirely (flagged dynamic in the manifest) and rely on probes at runtime.

What the stage hands its neighbors:

- To texture conversion: raw lightmap images (linear HDR) to be encoded
  like any other texture.
- To gltfpack: geometry with a UV2 attribute + a manifest entry per asset
  (lightmap texture id, texel density, UV2 bounds).
- To the world/settlement bake: a probe sidecar per scene (§4).

---

## 4. Inputs and outputs

### Inputs

- Cleaned glTF/GLB per static asset (post-gltf-transform), with materials
  (base color / emissive at minimum — albedo modulates bounce).
- A lighting rig per bake: sun direction + color/intensity, sky/ambient
  term, and any emissive surfaces flagged as lights. For per-asset bakes
  this is a standard rig; for scene bakes it is the world's rig (matching
  the client's day lighting at the reference hour — which hour is an open
  question, §8).
- Baker settings per asset class: lightmap resolution/texel density,
  samples per texel (pre-denoise), probe spacing for scene bakes.
- For scene/probe bakes: the placed scene (structure/prop transforms over
  terrain) from the world/settlement bake.

### Outputs

- **UV2 attribute** added to the asset's geometry (second UV channel,
  lightmap-only; UV0 untouched).
- **Lightmap textures**: one per asset (or atlas per asset class), linear
  HDR intermediate (EXR or float PNG) handed to texture conversion for
  KTX2 encode; the delivered artifact is the encoded texture + manifest
  entry.
- **Probe sidecar** per scene: probe positions + spherical-harmonics
  irradiance coefficients (order 2 / 9 coefficients per channel is the
  standard starting point — an estimate to confirm in the pilot), in the
  pipeline's usual sidecar form (JSON manifest + binary payload, matching
  how other baked scene data ships).
- **Bake report** per run: per-asset bake time, samples used, denoise on/off,
  output sizes — the numbers the cost/benefit gate gets re-checked against.

---

## 5. Per-library gates — verified 2026-10-23

All three libraries were re-checked live against GitHub today (repo
metadata + the GitHub license endpoint, which reads the actual LICENSE
file in the repo). **License gate: PASS for all three.** No gate currently
fails; the verification steps (V) are build-time smoke tests that must
pass before vendoring, per the standing rule that a license reading alone
doesn't clear a dependency.

| Library | Role | License (evidence, 2026-10-23) | Release status (2026-10-23) | Windows |
|---|---|---|---|---|
| Embree | Ray tracing core | **Apache-2.0** — GitHub license endpoint + repo metadata, file `LICENSE.txt`, repo `RenderKit/embree` | v4.4.1 (2026-04-02); repo pushed 2026-10-23 — actively maintained | **Yes** — official release ships `embree-4.4.1.x64.windows.zip` |
| OIDN | Denoiser | **Apache-2.0** — GitHub license endpoint + repo metadata, file `LICENSE.txt`, repo `RenderKit/oidn` | v2.5.1 (2026-08-18); repo pushed 2026-10-05 — active | **Yes** — official release ships `oidn-2.5.1.x64.windows.zip` |
| xatlas | Lightmap UVs | **MIT** — GitHub license endpoint + repo metadata, file `LICENSE`, repo `jpcy/xatlas` | No tagged releases (source-drop library); last push 2024-06-16 — stable/maintenance, expected for a finished 2-file library | **Yes (source)** — 2-file C++11 (`xatlas.h`/`xatlas.cpp`), no platform dependencies; builds under MSVC in principle |

### Gate checklist (all must pass before anything is vendored)

- **G1 — License (all three): PASS 2026-10-23**, evidence above. Re-run the
  same check at pin time against the exact pinned version's LICENSE file;
  licenses are read at the pin, not from this brief.
- **G2 — Canonical source:** OIDN's repo **moved**: `OpenImageDenoise/oidn`
  now redirects to **`RenderKit/oidn`**. Pin and cite the RenderKit URL;
  the graphics research doc still carries the old address (worth a
  one-line correction there when convenient — not changed by this brief).
  Embree already lives under `RenderKit/`; xatlas stays at `jpcy/xatlas`.
- **G3 — Windows build smoke test (per library):** each library compiles
  (or its prebuilt Windows x64 binary links) under VS Build Tools 2026 and
  runs a hello-world-scale call: Embree traces one ray against one
  triangle; OIDN denoises one small image; xatlas unwraps one mesh.
  xatlas has no prebuilt binary, so its smoke test is a straight MSVC
  compile of the two files — expected trivial, still must be demonstrated.
- **G4 — Pipeline survival test:** a pilot asset goes through the full
  chain (cleanup → UV2 → bake → texture conversion → gltfpack) and the
  delivered GLB still carries an intact UV2 + lightmap reference.
  gltfpack preserving the second UV channel and chart seams is the single
  most likely failure point in the whole project; test it first, before
  building the baker proper.
- **G5 — OIDN footprint:** the research doc sizes the OIDN runtime at
  ~50–80 MB. That is a bake-machine cost only (the library never ships to
  players), but confirm the actual v2.5.1 Windows package size at pin time
  and record it in the bake report.

### Adjacent note (not one of the three, not gated here)

Correct tangent-space normal baking would want MikkTSpace, whose zlib
license sits outside the MIT/Apache-2.0/BSD allowlist — the graphics
research already flags it as needing a one-line waiver. The lightmap
baker does **not** depend on it (lightmaps bake irradiance/shadow, not
tangent-space normals); it is listed here only so the waiver question is
not mistaken as a baker blocker.

---

## 6. Integration shape — options at scoping level

The baker is bake-time only, so it never has to ship inside the server or
the client. Two shapes:

### Option A — Standalone bake tool (recommended first)

A small native CLI (C++ executable) the bake scripts invoke per asset /
per scene, exactly as the pipeline already shells out to its other tools.
Embree + OIDN link into the tool; xatlas compiles in as two files.

- **Pros:** zero new native surface in the runtime or the editor; the
  established pattern (bake-time tools are already standalone or N-API in
  this project, e.g. the sim-lab bake server and EZ-Tree at bake time);
  crash/hang in a bake can't take down anything else; version pins are
  per-tool.
- **Cons:** geometry crosses a process boundary (files in/out — already
  the pipeline's normal currency, so this cost is mostly theoretical);
  debugging spans two processes.

### Option B — N-API native addon

The baker as a Node addon (the ozz-animation / terrain-kernel pattern),
called in-process from the bake scripts or the editor.

- **Pros:** in-memory geometry handoff; the editor could bake from inside
  its art pipeline UI without shelling out.
- **Cons:** native-addon build matrix (Node 25 ABI, VS 2026) for a tool
  that runs a handful of times per bake; a baker crash is a host crash;
  larger vendored surface for zero runtime benefit.

**Recommendation:** Option A. Promote to B only if editor-integrated
baking becomes a real workflow need — the stage boundary (glTF + sidecars
in/out) is identical either way, so the promotion is mechanical later.

---

## 7. Pilot (the first buildable slice, once approved)

1. G4 first: hand-run xatlas on one structure GLB, push it through
   gltfpack, confirm UV2 survives. (Kills the project's biggest risk for
   the price of an afternoon.)
2. G3 smoke tests for Embree and OIDN on Windows (VS Build Tools 2026).
3. Minimal Option-A tool: one asset in → UV2 + lightmap (Embree direct
   light + one bounce, low samples) → OIDN denoise → EXR out.
4. Measure: bake seconds per asset, lightmap sizes at the chosen texel
   density, denoise quality vs samples (the cost/benefit numbers §2
   needs).
5. One scene probe bake against a baked town scene; probe sidecar out.
6. Only then: pipeline wiring (manifest entries, bake-script step) and
   the client-side consumption check (§8, Q1).

---

## 8. Risks and open questions for Joey

**Risks**

- **R1 — UV2 loss downstream.** If gltfpack (or any later stage) drops or
  rewrites the second UV channel, lightmaps detach from geometry
  silently. Mitigated by G4 + a manifest validation check (the editor's
  art pipeline already validates manifests — extend it to assert UV2
  presence on assets flagged `static-baked`).
- **R2 — Texel density vs texture memory.** Towns place hundreds of
  structures; per-asset lightmaps at generous density could balloon
  delivered size. Needs the pilot's measurements and a per-class budget
  (props small, hero structures large) before defaults are set.
- **R3 — Bake-time growth.** Settlement bakes already take minutes; a
  probe bake per town adds to that. Acceptable if it stays a bake-machine
  cost only — measured in the pilot.
- **R4 — Stylized look mismatch.** The art direction is low-poly stylized.
  Realistic GI could fight the look instead of grounding it. The pilot
  should bake one town asset at low intensity and be judged by eye, like
  every other art intake — a soft, low-contrast bake is a settings
  choice, not a different baker.

**Open questions**

- **Q1 — Client consumption.** three.js materials support lightmaps
  natively (`lightMap` + a second UV channel), and probes need a small
  shader-side lookup. Verifying the current client build actually samples
  delivered lightmaps (and what it would take for probe lookup) is a
  client check this brief does not perform — the baker's outputs are
  standard either way, but the *value* lands only when the client reads
  them. Confirm before the full build, ideally alongside pilot step 6.
- **Q2 — Reference lighting rig.** Lightmaps freeze one lighting state.
  The world has a day cycle (a day is 2,400 s). Bake at a fixed reference
  hour (late morning reads best and keeps shadows informative) and let
  the runtime sun modulate on top — or bake neutrally (AO + sky ambient
  only) so the cycle never disagrees with the bake? This is a look
  decision, and it is Joey's.
- **Q3 — Probe density.** Per-structure probes (cheap, coarse) vs a
  regular world grid (smoother, bigger sidecars). Pilot data should
  inform this; default to per-structure for v1.
- **Q4 — Which content bakes first.** Structures are the obvious first
  class. Dungeon interiors arguably gain more (enclosed spaces are where
  baked bounce reads strongest). Order affects pilot asset choice only.

---

## 9. What this brief does not do

- It implements nothing and vendors nothing.
- It does not change the graphics research doc, the pipeline, or any
  existing stage.
- It does not authorize a push, a branch, or a build. It is the document
  Joey approves (or edits) before any of that starts.

---

*Evidence note: license, release, and Windows-binary facts in §5 were read
from GitHub's repo metadata and license endpoints on 2026-10-23. Star
counts and the OIDN size figure quoted from the graphics research are
that document's numbers, labeled as such where used. Bake-time and
texture-size figures do not exist yet; §7 exists to produce them.*
