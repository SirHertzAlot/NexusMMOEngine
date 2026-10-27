# Newton physics — evaluation for the client-side cosmetic physics slot (2026-10-26)

Evaluated for: the proposed **client-side cosmetic physics module**
(ragdolls, debris, cloth, secondary motion — presentation only, never
feeding server authority), behind the engine's existing swappable
physics seam. Also considered: authoritative server slot (already
Jolt's, determinism-verified) and bake-time use.

## What Newton is (state as of Oct 2026)

- GPU-accelerated physics engine for **robotics simulation and
  robot-learning (sim-to-real)**, created by NVIDIA + Google DeepMind +
  Disney Research; a **Linux Foundation** project since Sep 2025.
- **1.0 GA at GTC, 2026-03-17; 1.6.0 on 2026-09-10** — monthly release
  cadence, healthy governance, low bus-factor risk.
- **License: Apache-2.0** — passes the permissive gate.
- Built on **NVIDIA Warp**: physics is written in **Python**, JIT-compiled
  to CPU or CUDA kernels. Platforms: Linux (x86-64, aarch64), Windows
  (x86-64), macOS (CPU only). NVIDIA GPU (Maxwell+, driver 545+) is the
  design target; CPU execution is supported as a fallback.
- Solvers behind one interface: **MuJoCo Warp** (primary), XPBD, VBD
  (cloth, cables, deformables), Featherstone, SemiImplicit, and
  Disney's experimental Kamino (closed-loop mechanisms). Plus SDF
  collision, hydroelastic contacts, MPM granular material, OpenUSD
  scene description.
- Headline performance: up to **475× MJX on manipulation / 252× on
  locomotion** — measured on an RTX PRO 6000 Blackwell across
  **thousands of parallel training environments**. That is the workload
  the engine exists for: RL fleets, not one persistent world ticking.

## Verdict for the client cosmetic slot: DO NOT ADOPT — blocked, not beaten

**There is no browser runtime.** Warp compiles Python to CUDA and
native CPU code; Newton ships as a pip package. No WebAssembly build,
no WebGPU backend, no JavaScript/TypeScript binding exists. Our client
is a web client (Vite + React 19 + R3F/three.js) — Newton cannot be
embedded in it at all today. This is a hard platform blocker, not a
quality judgment: the solver lineup (MuJoCo-grade contacts, VBD cloth
and cables, SDF collision) is exactly the feature set the cosmetic
slot wants, in a package that cannot run where the slot lives.

For the authoritative server slot it also fails, for the familiar
reasons: wrong runtime (Python/Warp inside a Node/C++ server),
GPU-parallel design with no cross-platform bit-determinism contract —
the same wall as PhysX and the f32 integrate kernels. Jolt stays.

## Where Newton could earn a place later

- **Bake-time, on a GPU workstation:** pre-simulating cloth, soft-body
  and ragdoll motion into baked clips/vertex data for the animation
  pipeline (its VBD cloth + MuJoCo contacts are best-in-class for
  this), or physics-validating procgen dressing offline. Needs a
  concrete asset need + a CUDA bake box; neither exists yet.
- **Creature-brain research, speculatively:** if NPC brains ever grow
  a learned-policy tier (today: FSM/BT/GOAP by design), Newton +
  Isaac Lab is the robotics RL stack. No current requirement points
  here.

Revisit trigger: a Warp/Newton WebGPU or WASM target shipping, or a
funded bake-time cloth/ragdoll requirement.

## The slot itself: fill it with a browser engine — Rapier vs Jolt-WASM

Joey approved the client cosmetic module concept (2026-10-26). Two
candidates can actually run in the client, both permissive, both with
author-maintained WASM bindings:

| | Rapier (@dimforge/rapier3d) | Jolt WASM (JoltPhysics.js) |
|---|---|---|
| License | Apache-2.0 | MIT (same as our server Jolt) |
| Language/API | Rust→WASM, TypeScript-first API, @react-three/rapier exists | C++→WASM port of the exact server engine |
| Cross-platform determinism | **Yes, out of the box** in official WASM packages | Requires `CROSS_PLATFORM_DETERMINISTIC` at build time — **not set** in prebuilt packages; we'd own a custom WASM build (we already build Jolt natively) |
| Feel consistency with server | Different solver — cosmetic divergence from server physics is acceptable (never authoritative) | Same solver family as the authoritative sim |
| Cost | compat build embeds WASM ≈ +1.65 MB gzip (three 0.186-era measurement); split .wasm loading improves caching | WASM ~1–2 MB class; plus our build pipeline ownership if determinism flag is wanted |
| Ecosystem 2026 | The default three.js game choice; character controller, joints, heightfields | Smaller web-game community; strong in VR demos |

Why determinism matters even for cosmetics: our presentation rule
(server decides the event + seed; clients render) — three-pinata
already follows it. A cross-platform-deterministic cosmetic sim means
**every player sees the same ragdoll, the same debris field** from the
same server event, instead of per-device divergence. Rapier gives
that for free; Jolt-WASM gives solver consistency instead, at the
price of a custom build to also get determinism.

**Recommendation:** spike both against the module's real budget —
a few hundred active cosmetic bodies near the player, quality-tier
gated (low tier: module off), running in the client's existing worker
pattern — and pick on measured frame cost + bundle size. Prior: Rapier
wins on determinism + TS ergonomics; Jolt-WASM wins if server-feel
consistency proves visibly better in the spike.

## Sources

- Newton 1.0 GA / 1.6.0, Linux Foundation, Apache-2.0, Warp 1.17,
  platform + GPU requirements — collegica.org robotics survey (crawled
  Oct 2026); NVIDIA GTC 2026 coverage (blockchain.news, Mar 2026).
- Solver lineup + architecture — Senua Media Newton deep dive
  (Oct 2026); Newton documentation.
- Browser determinism comparison (Rapier ✓ out of box, Jolt flag,
  PhysX fixed-platform) — PlayCanvas developer manual, "Alternatives
  to ammo.js" (2026).
- Rapier bundle weight with three 0.186.1 — webcodingcenter.com
  Three.js vs Babylon.js costing (Oct 2026).
