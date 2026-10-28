# Animation Runtime — Architecture, Library Verdicts, and Automation Hooks

**Date:** 2026-10-06 · **Status:** Research + architecture
**Audience:** AI builders implementing the animation backbone.
**One-line thesis:** The server simulates capsules and gameplay events; the
client renders skeletons. Everything between those two facts is tooling.

---

## 0. What already exists (do not rebuild)

The client already has a real animation foundation — this document extends it,
replaces nothing:

- `apps/client/src/render/character/character-animator.ts` — two-layer
  animator: **Base** (locomotion from the server's velocity + locomotion mode,
  crossfaded, playback scaled to ground speed) and **Action** (attack/block/
  hit clips over the base, whole-body or upper-body, can start mid-clip to
  match the server's start time). Clips play **in place**; the server moves
  the character. The file's own contract: *"Nothing here decides gameplay."*
- `apps/client/src/render/character/character-kit.ts` — modular characters:
  one rig, parts bound by bone name, one skeleton per character, toon-shaded
  and outlined by default.
- Clip pipeline: retargeted clip library from GLB sources with an
  `animations.json` manifest (v2).

The gaps this document closes: the **runtime library decision** (ozz),
**compression** (acl), the **motion-matching verdict**, the **server-side
animation contract**, IK, held frames, and the validator set.

---

## 1. The server/client animation split (architectural rule)

This is the load-bearing decision. Everything else follows.

| Concern | Server | Client |
|---|---|---|
| Character position | Authoritative (capsule + root motion) | Mirrors |
| Facing, velocity, locomotion mode | Authoritative | Mirrors |
| Gameplay events (hit frames, footstep cues, ability windows) | Authoritative, from authored event tracks | Plays effects/audio on receipt |
| Bone matrices | Never computed | Computed every frame |
| Clip selection | Decides *which* clip + start time | Blends and renders it |

**Sync protocol:** the server sends `(clipId, startTick, playbackRate,
layerMask)` — never bone data. The client maps that onto its clip library.
Bandwidth per character per change: a few bytes. This is why the current
animator's "start part-way through" support exists, and it's correct.

**Determinism note:** hit detection uses capsules + authored hit windows,
never sampled bone positions. Bone sampling is client-presentation and may
vary by platform (SIMD differences) without affecting gameplay — the same
separation the destruction pipeline uses (server decides the event, client
renders it).

## 2. Library verdicts

### 2.1 ozz-animation → ADOPT (native side + bake pipeline)

**What:** Open-source C++ skeletal animation runtime (guillaumeblanc),
MIT-licensed, data-oriented by design: `SamplingJob` computes local-space
poses, `BlendingJob` mixes them (full + partial per-joint weights), jobs are
intrinsically thread-safe with inputs/outputs only, SoA SIMD throughout,
renderer- and engine-agnostic, with an offline toolchain converting
glTF/FBX/Collada to optimized runtime structures. The runtime depends only on
C++11 + standard libraries — no OS-specific code.

**Why it fits this engine:** it is the exact "orchestrate best-in-class"
precedent set by Jolt — narrow interface, vendored behind a bulk boundary,
boring where it should be boring. The engine already proved the pattern.

**Where it lives (judgment call):**
- **Bake pipeline (primary):** retargeting, compression, validation, and
  root-motion extraction run through ozz's offline toolchain via a Node
  N-API addon — same shape as the Jolt and navigation addons. The existing
  `convert:animations` step grows into this.
- **Native clients/addons (secondary):** any future native client or
  headless sim-worker gets ozz directly.
- **Web client:** three.js `AnimationMixer` stays *for now*. ozz-to-WASM is
  the documented upgrade path (a Rust port already demonstrates WASM
  viability), gated on a measured comparison: per-character CPU cost at
  100+ visible characters, WASM vs. the current mixer. Do not migrate on
  faith; migrate on numbers.

**Not adopted:** ozz's sample framework renderers and importers — Assimp
remains the sole file importer; the editor keeps its own UX.

### 2.2 acl (Animation Compression Library) → ADOPT at bake time

**What:** Nicholas Frechette's (Ubisoft) MIT-licensed, self-contained
animation compression library with published performance metrics (CMU
database, Paragon database, decompression benchmarks).

**Why now:** an MMO multiplies the animation problem — hundreds of visible
characters × full clip sets × LODs. Uncompressed clips are a memory and
bandwidth budget line item, not a detail. acl compresses at bake; the client
decompresses the small hot path (or ozz consumes acl-compressed data —
the two compose).

**Gate:** the rubric applies — measured bytes-per-character at each quality
tier, error metrics within the authored tolerance, `low` tier never
regresses. Compression artifacts on held-frame stylized animation are *more*
visible than on realistic motion (clean silhouettes show pops), so the error
tolerance for this art direction is tighter than acl's defaults.

### 2.3 Motion matching → NOT NOW (documented revisit)

**What:** Clavet's GDC 2016 technique (*For Honor*): every few frames, search
a curated mocap database for the frame best matching current pose + desired
trajectory, jump there, warp procedurally to hit gameplay constraints.
Replaces hand-built locomotion state machines with data.

**Why not now — three concrete reasons:**
1. **Memory:** vanilla motion matching exceeds 0.5 GB and scales linearly
   with data. An MMO client cannot spend that on locomotion.
2. **Corpus:** it needs a large, curated, marked-up mocap database that
   does not exist for this game's rigs. No corpus, no matching.
3. **Scale:** per-character database search × hundreds of characters needs
   an acceleration structure and a measured per-frame budget first.

**The pragmatic path (recommended):** the existing hybrid already in the
codebase — parametric state machine for the responsive locomotion core
(speed-scaled crossfades exist today) + motion warping for contextual moves
(ledge grabs, mantling) later. Revisit motion matching when (a) a mocap
corpus exists, (b) the per-character CPU budget is measured, and (c) Learned
Motion Matching (Holden et al., SIGGRAPH 2020 — 70× compression of the
database) is evaluated as the memory answer.

### 2.4 IK → ADOPT pattern, not a library

Two-bone IK (feet planting, hand targets) and aim/look-at IK are commodity
math, not a library decision. ozz ships IK jobs for the native side; the web
client implements the same two solvers against the three.js skeleton.
**Foot planting is the locomotion quality gate** — without it, speed-scaled
playback slides visibly, and no amount of clip quality survives.

## 3. Stylization: held frames (DNA doc D9, implemented here)

The animator gains a per-clip `holdFrames` quantize: sample the authored
curve, then hold each pose for N render frames (Xrd's anime timing — game at
60 fps, character effectively at 20–30). Rules:

- Held frames are **presentation-track only** (combat-timeline rule):
  gameplay events fire on the unquantized timeline.
- The combat-timeline validator must understand quantized clips so it doesn't
  flag them as broken.
- Root motion stays unquantized — the capsule never stutters even when the
  pose holds. This is the detail that makes held frames feel intentional
  instead of laggy.

## 4. Backbone integration map

| Concern | Owner | Status |
|---|---|---|
| Clip library, two-layer animator | `character-animator.ts` | Exists — extend |
| Retargeting, compression, validation | Bake pipeline (`convert:animations` → ozz/acl N-API) | **New** |
| Root-motion extraction | Bake (ozz offline) → server reads metadata | **New** |
| Server anim state | `(clipId, startTick, rate, layerMask)` on the entity | **New** (protocol) |
| Hit detection | Capsules + authored windows (server) | Rule — never bones |
| Held frames | Animator quantize | **New** |
| Foot IK | Client solver (+ ozz jobs native) | **New** |
| Motion matching | — | Parked (§2.3) |
| Anim LOD (far characters) | Tick-rate scaling + clip reduction | **New** (MMO necessity) |

**Animation LOD deserves emphasis:** at MMO scale, animation is a CPU budget
item. Far characters sample at reduced tick rates, skip the Action layer,
and eventually freeze to a single pose impostor. The FX-lab budget harness
pattern applies — measured milliseconds per 100 characters per tier, not
vibes.

## 5. Automation roadmap (A-ANIM validators)

Bake-time checks on every clip, warnings-first:

- **A-LOOP:** loop-continuity check — first/last frame pose delta under
  tolerance, else flag (the #1 locomotion pop cause).
- **A-ROOT:** root-motion validation — total displacement matches the
  clip's declared travel speed (the animator scales playback to ground
  speed; a mismatch here *is* foot sliding).
- **A-SLIDE:** foot-slide measurement — during contact phases, foot joint
  world velocity must be near zero. Reports mm/frame; fails above threshold.
- **A-BONES:** bone budget — skeleton joint count × expected on-screen
  characters vs. the per-tier CPU budget.
- **A-EVENTS:** every gameplay-relevant moment (hit frame, footstep, cancel
  window) must have an authored event track entry — "the animator never
  guesses when the sword hits."

## 6. Non-goals

- **No mocap pipeline yet.** Motion matching's corpus requirement stands;
  hand-keyed + retargeted clips are the content path until it's met.
- **No facial animation system in this pass.** Bodies first; faces ride the
  SDF/blush machinery from the DNA doc.
- **No ragdoll-physics integration yet.** Jolt is vendored; active ragdoll
  is a later slice with its own cost gate.

---

## Works Cited

Blanc, Guillaume. ozz-animation. Open-source C++ 3D skeletal animation
library and toolset. MIT license. Runtime: SamplingJob, BlendingJob,
SoA SIMD, thread-safe jobs, renderer-agnostic; offline toolchain for
glTF/FBX/Collada. guillaumeblanc.github.io/ozz-animation/.

Clavet, Simon. "Motion Matching and the Road to Next-Gen Animation."
GDC 2016, Ubisoft Montréal (*For Honor*). Big-data locomotion: database
search on pose + trajectory, procedural warping to gameplay constraints.

Frechette, Nicholas. acl — Animation Compression Library. MIT license,
self-contained, published CMU/Paragon performance metrics.
github.com/nfrechette/acl.

Holden, Daniel, et al. "Learned Motion Matching." *SIGGRAPH 2020*.
Neural compression of motion-matching databases (~70×).

"Motion Matching" (Unreal: PoseSearch; layered hybrid proposals).
Unreal Engine forums and documentation — the hybrid state-machine +
contextual-matching pattern this document recommends.
