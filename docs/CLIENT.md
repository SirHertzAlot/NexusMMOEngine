# The client

The browser client is a **mirror**. It renders what the server sends and
sends back what the player pressed. No game logic runs in it, and nothing it
computes is ever authoritative. That rule is what makes the rest of the
engine's design work, and it is the first thing to understand before you
change anything here.

- Stack: React 19 + React Three Fiber 9 + drei, over three.js r186.
- Entry: `apps/client/`. Run it with `npm start` (or `npm run client`), on
  `http://localhost:5173`.
- The networking half is `packages/mirror`, shared with the editor: connect,
  fold snapshots and deltas, interpolate. See
  [Message catalog](MESSAGE-CATALOG.md) for the wire.

## What the client is allowed to do

| Allowed | Not allowed |
|---|---|
| Interpolate between authoritative states so motion looks smooth | Decide where an entity actually is |
| Predict the local player's walk, then reconcile to the server | Keep a prediction the server disagreed with |
| Run cosmetic physics (corpse ragdolls, debris) | Run physics that any other player can see the result of |
| Draw effects, weather, sky, water, UI | Apply damage, move items, change stats |

If you find yourself wanting an exception, the answer is a server system or a
rules hook instead. [Building a game on this engine](BUILDING-A-GAME.md) covers where to
put the logic.

## Prediction and interpolation

`apps/client/src/physics/` holds both halves:

- `snapshot-interpolator.ts` buffers authoritative states and plays them back
  one tick behind, so an entity moves smoothly between 30 Hz updates.
- `walker-prediction.ts` moves the local player immediately on input and
  reconciles when the server's version arrives.

Everything else on screen is interpolated, not predicted. Input therefore
costs at least a round trip plus one interpolation tick (about 33 ms) before
other players see it. That is a deliberate trade and it is the main reason
this engine suits MMO pacing rather than twitch combat — see
[Performance and constraints](PERFORMANCE.md#choices-and-what-they-cost).

## Cosmetic physics

The client's physics is **PhysX** (`physx-js-webidl`). `createClientPhysicsWorld()`
in `apps/client/src/physics/index.ts` gives you a world; `physx-world.ts` is
the implementation and `physics-world.ts` is the seam it satisfies. PhysX is
what this engine's client is built and benchmarked on, and it is what the rest
of this page means by "the physics".

It was picked by measurement, not preference. On one 128 m heightfield with
300 static prop boxes and 200 awake ragdoll rigs, PhysX cost 15.7 ms per tick
against Rapier's 32.9 and JoltPhysics.js's 41.1, for about 2.0 MB gzipped
(roadmap item *Client physics library*). `rapier-world.ts` is still in the
tree as the second implementation of that seam, still covered by tests, and
`createClientPhysicsWorld("rapier")` still selects it — but PhysX is the
supported path and the one to build against.

Units are metres, y up. The caller passes a frame `dt` and PhysX splits
it into `PHYSICS_SUBSTEPS` (2) collision steps, matching the server's tick.
A ragdoll rig is 11 parts and 10 ball joints (`ragdoll-rig.ts`,
`corpse-ragdolls.ts`).

`npm run bench:physics -w @mmo-engine/client` re-runs the backend comparison
(one 128 m heightfield, 300 static prop boxes, one dynamic walker, N rigs, 60 Hz,
two substeps, single thread; median of 3 runs of 300 ticks after 60 warm-up
ticks). It writes `apps/client/scripts/physics-bench-results.json`. A version bump on
any of the three can move the numbers, so re-run it rather than trusting the
figures above. `jolt-physics` stays a dev dependency purely so the comparison
can include the server's engine.

The server's physics is separate and always Jolt in C++
([Architecture](ARCHITECTURE.md)).

## Rendering

Everything in `apps/client/src/render/` is **visual only**. It consumes
mirrored positions and never feeds back into the simulation.

| Layer | Files | What it does |
|---|---|---|
| Shared GLSL | `glsl.ts` | Hash, value-noise, FBM and ridged-noise snippets. Terrain and elemental shaders import from here instead of duplicating noise code. |
| Terrain FX | `terrain-fx.ts` | `onBeforeCompile` injection on the chunk material: noise albedo, pulsing energy veins, shimmering water pools. Deterministic per chunk via `ChunkRow.seed`. |
| Entity FX | `entity-fx.ts` | Spawn portal, selection ring, player aura, motion-trail ribbon, hover highlight. |
| Elemental orbs | `element-fx.ts`, `showcase.ts` | Six procedural `ShaderMaterial` orbs (water, fire, wind, earth, snow, lava) with runtime canvas textures. No downloaded assets. |
| Water | `water.ts`, `water-material.ts` | One shader pass, no reflection targets. Three crossing swell trains plus ripples tilt the normals; the sky is reflected by evaluating the sky dome's own function (`sky/sky-glsl.ts`) in the reflected direction, Fresnel-weighted, so the water mirrors the hour. GGX sun glint, Beer-Lambert depth colour, and a moving shore-foam band from a depth texture built off the world map at 16 m cells. |
| Sky and time of day | `sky/day-sky.ts`, `sky/time-of-day.ts` | Sky dome (gradient, sun disc, horizon haze, stars) and the sun/moon lights, set every frame from the world's time of day — the welcome's day clock plus the server tick, so every client agrees. Scene fog takes the haze colour. Adapted from ProceduralTerrains (MIT; `apps/client/THIRD_PARTY_NOTICES.md`). |
| Weather | `fx/weather.ts`, `fx/particle-fx.ts`, `fx/particles.json` | three-nebula particles in one GPU point-sprite draw call. Snow, rain and ash fall in a camera-following box while staying in world space. What falls where is data: the `biomes` table gives each biome a kind and a share of weather spells, and the spell is hashed from the world tick and the biome, so every client sees the same shower. |
| Terrain surfaces | `terrain/surfaces.ts`, `terrain/terrain-material.ts` | CC0 photo-scanned ground materials fetched by `npm run surfaces:fetch` into `apps/client/public/surfaces/`, never committed. Blends each biome's material between the four nearest map cells, rock on slopes (triplanar), snow above the snow line. Without the files the terrain keeps flat biome colours. |
| Screen effects | `post-fx.tsx`, `effects/underwater-effect.ts` | pmndrs postprocessing: multisampled AA, bloom above a threshold, light vignette, and the underwater look faded in by camera depth below `WaterRenderer.surfaceAt`. The HUD's **effects off** renders the scene directly for weak GPUs. |

`entity-layer.ts` owns lifecycle, driven by `world-canvas.tsx` (the R3F
scene): it constructs the FX systems, routes authoritative transforms into
them, raycasts hover, and disposes everything.

### Three rendering gotchas that cost real time

- **Ribbon and strip geometry must be `THREE.DoubleSide`.** A trail's triangle
  winding flips with travel direction relative to the camera, so with the
  default `FrontSide` every triangle can be back-facing and the whole mesh is
  culled while geometry, material and draw range all look valid.
- Trail, ring and beam materials are `transparent`, `depthWrite: false` and
  additive; `renderOrder` keeps them above opaque geometry.
- Set `frustumCulled = false` on dynamic-geometry meshes whose bounds change
  every frame (the trail), so a stale bounding sphere cannot cull them.

## Assets and cross-origin isolation

Large asset decoding moves off the main thread through a `SharedArrayBuffer`
pipeline, which needs the page to be cross-origin isolated (COOP/COEP
headers). `apps/client/src/assets/sab-support.ts` detects every leg of this
and reports which one is missing; the Vite dev config already sets the
headers. Without isolation the pipeline falls back to the main thread —
correct, just slower. The details are in
[internals/CLIENT-SAB-ASSET-PIPELINE.md](internals/CLIENT-SAB-ASSET-PIPELINE.md).

## Performance on real machines

The repository has **no frame-rate measurements for the player client**; the
numbers in [Performance and constraints](PERFORMANCE.md) are all server-side. Instanced
props draw one call per model, plus one per level-of-detail mesh in use, and a
quality governor lowers resolution when frames drop and raises it again.
`npm run bench:client-frame -w @mmo-engine/client` is the harness to start
from if you want numbers for your own content.

The HUD's `gpu` line reports which GPU the browser handed the page. On laptops
with integrated and dedicated graphics, that is usually the explanation for a
slow client.

## Related

- [Getting started](GETTING-STARTED.md) — controls, and what you see without the licensed art packs.
- [Architecture](ARCHITECTURE.md#replication) — how snapshots and deltas reach the client.
- [Art pipeline](ART-PIPELINE.md) — getting models and animations in.
