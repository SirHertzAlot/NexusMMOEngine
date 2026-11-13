# MuJoCo — engine mapping note

Source: Instagram reel by @index.opensource (2026-10-09), shared by Joey 2026-11-11.
Subject: MuJoCo (Multi-Joint dynamics with Contact), Google DeepMind's physics
engine for robotics and machine learning. Reel demos ran on MuJoCo 3.14.0.
License: Apache-2.0 (code and example models, per the reel's own sourcing).

## What the reel actually shows

- Articulated bodies as trees: a humanoid is 16 bodies / 21 joints, its whole
  pose captured by 28 numbers (root position/orientation + joint angles).
- Each step: find contacts, solve all contact forces together as soft
  constraints (one convex optimization; a time constant sets contact softness,
  friction caps sideways push), advance the state.
- Scale demo: 100 humanoids, ~2,700 degrees of freedom, 1,000+ contacts per
  step, faster than real time on a laptop.
- Same solver, soft bodies: a squishy block in a gripper, a collapsing house
  of cards, a figure dropped into a hammock. (The creators' overlays/graphs
  are their additions, not MuJoCo's renderer.)

## Mapping onto Nexus

- **Authoritative tick: PASS.** Jolt stays. MuJoCo solves a different problem
  — dense contact fidelity for small articulated scenes — not a 1,000-player /
  50,000-object region under contention. Its headline number (100 humanoids)
  is two-plus orders of magnitude below our target and a different shape of
  load. Nothing here offers the bit-identical determinism our Jolt + bulk SoA
  boundary is verified for, and a physics swap is never smuggled inside
  another change. Same reasoning that kept PhysX out of the tick.
- **Articulation model: REFERENCE, genuinely useful.** Pose-as-a-short-vector
  over a body tree (MJCF-style description) is the same data shape our
  animation system retargets into. A candidate reference for the animation
  pipeline's open creature/skeletal path (audit break B6) when that line is
  picked up.
- **Offline lab: ADAPT candidate, not scheduled.** Ragdoll / fall / secondary-
  motion prototyping and creature-locomotion experiments at bake time, where
  its contact quality is the point and determinism doesn't gate. Same lane as
  the Teskooano verdict: bake-time experiment, never the tick.
- **Soft bodies: noted, not proposed.** The hammock/gripper material borders
  the client cosmetic-physics module Joey parked on 2026-10-26. Recorded so
  the connection exists if he unparks it; not re-raised as a proposal.
- **RL-trained NPC locomotion: park.** MuJoCo's home turf, but our NPC layer
  is decision systems (ResidentSystem, Yuka), not learned controllers. No
  current need pulls this in.

## Verdict

REFERENCE overall, with an ADAPT candidate as an offline physics lab.
License is clean (Apache-2.0) if a spike is ever scheduled. Nothing
downloaded, nothing integrated, no change to the Jolt decision.

## Addendum — 2026-11-11, Joey's direction: cutscenes

Joey, same day: "We can use MuJoCo for more detailed scenes like cut
scenes." Recorded as the adopted use for MuJoCo in Nexus. This supersedes
the "offline lab, not scheduled" framing above for the cinematic lane only;
the tick verdict is unchanged.

Why cutscenes are its exact shape here: few actors, short duration, contact
fidelity is the point of the scene, and the physics never feeds authority —
the server script owns story outcomes (who lives, what breaks, what the
player gains); MuJoCo only decides how it *looks* while it happens.

Two delivery shapes:

1. **Baked (primary).** Simulate the scene in MuJoCo at author time, record
   per-frame joint/pose tracks, and ship them as clips through the existing
   animation intake (retarget onto our bone ontology, same as any other clip
   source). Playback is then identical on every client including phones,
   costs nothing at runtime, carries no WASM weight, and is deterministic by
   construction. Fits the engine's bake-time philosophy (cf. dungeon shells).
2. **Live WASM (reactive set pieces).** Browser builds exist: the community
   `mujoco_wasm` (zalo, on DeepMind's emscripten build) with a live three.js
   demo, and Google's own WASM dist described as moving to npm (Google AI
   dev.to write-up, 2026). Runs in a worker, rendered by three.js — the same
   shape as our client. Reserved for scenes that must react (debris, a fall
   that depends on where the player stands), small scenes only, behind the
   quality tiers, never authority.

Scene types this serves: boss intros with collapsing masonry, a character
knocked through a market stall, tavern brawls, creature entrances (doubles
as articulation reference for the B6 creature path), death cinematics and
ragdoll finales.

Status: direction adopted, nothing built. Next step is Joey's pick — spec
the cinematic lane, or spike the bake path first.

## Addendum 2 — 2026-11-11: spec chosen and delivered

Joey picked "Spec the cutscene lane first." The spec is delivered at
`~/workspace/your_files/mmo-engine-cinematics/CUTSCENE-LANE-SPEC.md`:
authority contract (server owns story, MuJoCo owns motion, nothing read
back, exit poses script-declared and enforced by an Arrival bake gate),
CinematicDef catalog + beat cue sheet, the bake pipeline with a two-run
determinism gate, the MJCF ↔ bone-ontology rig bridge shared with the A1
retargeter, server trigger via a new `playCinematic` verb + participation
component, live WASM lane sequenced last (C4) behind a measured Android
gate with mandatory baked fallback, and build order C0–C4 with the
props-only market-stall collapse as the C1 showcase. Open questions for
Joey are in §12 of the spec (group skip, live-in-v1, showcase pick, bake
host). Nothing built; implementation awaits his word per phase.

## Verification addendum — 2026-11-11, live-WASM claims checked

Checked against the live web before any spike is scheduled, so the lane's
second delivery shape rests on verified sources, not the reel's say-so:

- **zalo/mujoco_wasm is real, with a three.js demo app.** Documented
  end to end (DeepWiki on the repo): `examples/main.js` + `MuJoCoDemo`
  class, Emscripten virtual FS for model files, three.js scene + render
  loop, drag interaction, scenes loaded from MJCF XML.
  Source: https://deepwiki.com/zalo/mujoco_wasm/5-demo-application
- **Google's own WASM dist "moving to npm" is accurate as stated.**
  The Google AI dev.to write-up (Feb 2026) says the files in
  `mujoco/wasm/dist` (`mujoco_wasm.js` + `mujoco_wasm.wasm`) are being
  moved to npm, and the demo was modified to import them as a library.
  Source: https://dev.to/googleai/building-a-gemini-powered-robotics-simulator-in-the-browser-with-mujoco-wasm-hjj
- **Version-gap flag for the spike:** the third-party npm package
  `@cwiz89/mujoco-wasm` (stillonearth/MuJoCo-WASM) is pinned to MuJoCo
  **v2.3.3** — well behind the reel's 3.14.0. A spike must build from
  the official `mujoco/wasm/dist` (or zalo's repo), not grab that npm
  package on name alone.
- **Pattern corroboration:** kualia.ai's Training Lab runs MuJoCo WASM
  in a background worker, draws with three.js, and ships packed typed
  arrays of geom poses back to the main thread — the same worker shape
  the live lane would use.
  Source: https://www.kualia.ai/lab/simulation

Nothing above changes the verdict: bake-first stays primary, live WASM
stays reserved for reactive set pieces, and neither touches authority.
