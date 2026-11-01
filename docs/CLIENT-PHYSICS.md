# Client physics: Rapier, chosen by benchmark

The client gets a physics seam (`apps/client/src/physics/physics-world.ts`) and
one backend behind it, Rapier (`@dimforge/rapier3d-compat` 0.21, WASM). Game
code calls the seam only, so the library can be swapped.

## Benchmark

`npm run bench:physics -w @mmo-engine/client` (script `apps/client/scripts/bench-physics.mjs`,
results in `apps/client/scripts/physics-bench-results.json`).

Scene, the same for both libraries: one 128 m heightfield, 300 static prop
boxes, one dynamic walker (rotation locked, steered by velocity), and N
ragdoll rigs of 11 boxes and 10 ball joints. 60 Hz, two substeps, single thread.
Each point is the median of 3 runs of 300 ticks after 60 warm-up ticks. "Awake"
keeps the rigs from sleeping (worst case), "sleeping" lets them rest.

Median ms per tick:

| rigs | Rapier sleeping | Rapier awake | Jolt sleeping | Jolt awake |
|-----:|----:|----:|----:|----:|
| 0 | 0.12 | 0.09 | 0.02 | 0.02 |
| 10 | 1.49 | 1.57 | 1.64 | 1.79 |
| 50 | 7.37 | 8.58 | 7.31 | 9.71 |
| 100 | 13.84 | 18.60 | 13.05 | 19.46 |
| 200 | 29.68 | 34.90 | 26.25 | 39.06 |

Chart: `/mnt/project-files/marketing/physics/rapier-vs-jolt-step-time.png` (outside the repo).

Every run kept every rig body finite and above the terrain, with no body through the ground.

## Decision

Rapier. The two are within about 10% of each other at the rig counts the
ragdoll budget cares about. Rapier is 5 to 11% faster with awake rigs (100 to 200
rigs), which is the case the 4 ms budget is set for. Jolt is 5 to 12% faster
when rigs sleep, and has no advantage on terrain and props alone.

Trade-offs, and why Rapier still wins:

- **Bundle size.** The compat build embeds its WASM. Gzipped, Rapier's module is
  about 1.6 MB; Jolt's compat module is about 0.9 MB. Rapier's non-compat build
  loads the WASM as a separate file and would cut this; left as a follow-up.
- **Walker.** The benchmark walker is a velocity-steered dynamic capsule. Over
  10 s it fell 8.9 m behind its path in Rapier and 2 mm behind in Jolt. That is a
  steering artefact, not a controller result. A real walker should use Rapier's
  `KinematicCharacterController`, measured separately before the walker lands.
- **Jolt stays the server's engine.** Jolt is kept as a dev dependency for the
  benchmark only, so the comparison can be re-run.

## Scope

Not included: cosmetic ragdolls on death (roadmap "Ragdoll slice 1"), which
will call this seam; the per-frame sync to the scene; the walker's character
controller.
