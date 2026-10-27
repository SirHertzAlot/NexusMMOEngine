# Three.js Resources Directory Review — Top Picks

**Source:** threejsresources.com/tools directory (290 claimed, 371
listings across 30 categories — many cross-listed; surveyed 2026-10-09
via full category scroll).
**Method:** license first, then fit against our stack (R3F client,
vanilla-three.js editor, bake-time art pipeline, permissive-only,
cost/benefit gate). Only tools with a real job in our architecture made
this list; the directory's AI-model generators, no-code builders, and
showcase entries did not.
**Status:** recommendations, not locked decisions. Companion to
`THREEJS-TOOLING-REVIEW.md` (first batch).

## ADOPT

### gltf-transform — the bake pipeline's texture + cleanup stage

- **What:** donmccurdy's glTF 2.0 SDK (CLI + Node API): scene cleanup
  (`prune`, `dedup`, `join`, `instance`, `simplify`), geometry
  compression (draco, meshopt, quantization), texture conversion and
  resize (WebP, KTX2/Basis UASTC + ETC1S).
- **License:** MIT, verified against the repo (1,980 stars, active).
- **Why adopt:** this is the missing half of the compression story.
  gltfpack covers geometry; gltf-transform covers everything else —
  texture KTX2 conversion (the KTX2 eval from the conf deep dive now has
  its tool), dedup/join cleanup, and Draco as an alternative. One
  pipeline, two stages: gltfpack for geometry, gltf-transform for
  textures + cleanup, both recorded in the manifest.
- **Where it lands:** `packages/art` bake, after the gltfpack step.
  Textures deliberately excluded from the gltfpack phase stay excluded
  — they move here instead.

### Gobkit — CC0 placeholder characters

- **What:** 69 rigged and animated low-poly `.glb` models with a
  no-auth JSON manifest at `/api/free`.
- **License:** CC0, stated on the directory card. Public domain — no
  attribution, no restrictions.
- **Why adopt:** placeholder NPC/creature assets for prototyping
  animation, retargeting, and crowd systems before real art exists.
  Rigged + animated + CC0 is the exact combination that unblocks
  animation-pipeline testing today.

### lil-gui — tweak panel for the vanilla editor

- **What:** lightweight floating controller panel, the drop-in
  successor to dat.gui.
- **License:** MIT (well-established; confirm on adoption).
- **Why adopt:** Leva is React-first and already assigned to the R3F
  client dev overlay. The *editor* is vanilla three.js — lil-gui is its
  equivalent: zero-drama live tweaking for editor development.
- **Scope discipline:** same as Leva — dev tooling, never shipped.

## EVALUATE

### NixieFX — visual VFX editor + runtime

- **What:** local-first visual particle editor and runtime for
  production VFX in three.js (and PixiJS) web games.
- **License:** directory states MIT-licensed *runtime*; the editor's
  license needs verification before any commitment.
- **Why evaluate:** it is the thing three.quarks lacks — a visual
  editor. If the editor is clean and the runtime is competitive on the
  CPU-cost measurement already planned for three.quarks, this could
  replace or complement our VFX authoring story. Do not adopt on the
  directory card alone; run the same cost gate three.quarks faces.

### EZ-Tree — procedural trees (MIT, verified)

- **What:** procedural tree generator (dozens of tunable parameters)
  as both a library (`@dgreenheck/ez-tree`) and a web app; exports GLB
  and PNG sprites.
- **License:** MIT, verified via multiple sources.
- **Why evaluate:** feeds the octahedral-impostor work directly —
  procedural species in, baked atlases out. Notable: same author as
  three-pinata (David Greenheck), already a trusted name in our stack.
  Deterministic seeds make it bake-pipeline friendly.
- **Also noted in the same research:** agargaro's `InstancedMesh2`
  (MIT) — InstancedMesh + BVH frustum culling + LOD, reportedly 200k
  trees — is the scattering-side complement worth evaluating alongside.

### GLB Delivery Desk — batch GLB QA gates

- **What:** batch GLB inventory and handoff reports: file, geometry,
  image, and material checks.
- **Why evaluate:** a ready-made QA gate for the art pipeline,
  adjacent to our manifest validation. If its checks overlap the
  manifest, adopt the missing ones as validators rather than the tool.

### Meshamorphosis — batch FBX→GLB + Mixamo batching

- **What:** batch-converts FBX/OBJ/glTF to GLB; can batch-add Mixamo
  animation FBX files.
- **Why evaluate:** our animation pipeline retargets from GLB clip
  sources and Mixamo is the standard free source — batch ingest plus
  Mixamo batching slots into the bake's animation stage. License to
  verify.

### lygia — modular shader library

- **What:** granular, modular GLSL shader functions by
  patriciogonzalezvivo.
- **License:** MIT (verify on adoption).
- **Why evaluate:** a function-level library for the shader R&D
  bundle's experiments — import math, not frameworks. Fits the
  "reimplement, don't vendor" posture at the smallest possible unit.

## BOOKMARK (no action)

- **GLTF Report (gltf.report):** donmccurdy's web diagnostic for GLB
  files (supports BASIS/KTX2). Manual QA companion to the bake.
- **Kenney / Quaternius (CC0):** placeholder game assets — nature,
  medieval, animated characters.
- **Polyhaven / AmbientCG (CC0/free):** HDRIs and PBR textures for
  lighting and material prototyping.
- **Mixamo (free):** character models and animations; the standard free
  source for the animation pipeline's clip library.
- **VAT Blender addon:** vertex-animation-texture generation — a
  research note for the crowd-animation problem, not a tool to adopt
  today.

## PARK

- **TSL Graph / Nodetoy / tsl-textures:** visual shader editors tied
  to the TSL/WebGPU path — parked with the WebGPU decision itself.
- **Three.js DevTools:** browser scene inspector — parked alongside
  Needle Inspector pending license checks; complements Spector.js.
- **AI 3D generators (Rodin, Tripo, Meshy, Genaimo, etc.):** our art
  is supplied input and style consistency is a design pillar;
  generated assets are a style risk with murky training-data
  licensing. Parked explicitly, not overlooked.

## Fit summary

| Tool | Verdict | Lands in | License |
|---|---|---|---|
| gltf-transform | ADOPT | bake: textures + cleanup | MIT ✓ verified |
| Gobkit | ADOPT | placeholder assets | CC0 ✓ stated |
| lil-gui | ADOPT | editor dev overlay | MIT (confirm) |
| NixieFX | EVALUATE | VFX authoring | runtime MIT ✓ stated; editor verify |
| EZ-Tree | EVALUATE | procgen → impostor bake | MIT ✓ verified |
| InstancedMesh2 | EVALUATE | forest scattering | MIT (per research) |
| GLB Delivery Desk | EVALUATE | art QA gates | verify |
| Meshamorphosis | EVALUATE | animation bake ingest | verify |
| lygia | EVALUATE | shader R&D | MIT (verify) |

The single biggest find is **gltf-transform**: it completes the
compression story gltfpack started (geometry → gltfpack, textures +
cleanup → gltf-transform) and answers the KTX2 eval with the tool that
performs it.
