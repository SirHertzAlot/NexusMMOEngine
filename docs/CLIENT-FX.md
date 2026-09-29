# Client FX

All effects in `apps/client/src/render/` are **visual-only**. Authoritative game
state comes from the server over the snapshot/delta protocol; FX consumes
mirrored positions and never feeds back into simulation.

## Layers

| Layer | File | What it does |
|---|---|---|
| Shared GLSL | `glsl.ts` | Procedural hash / value-noise / FBM / ridged-noise snippet library. Terrain and elemental shaders import from here (DRY) instead of duplicating noise code. |
| Terrain FX | `terrain-fx.ts` | `onBeforeCompile` injection on the chunk material: noise albedo (grass/dirt/rock), pulsing energy veins, shimmering water pools. Deterministic per-chunk via `ChunkRow.seed`. |
| Entity FX | `entity-fx.ts` | Spawn portal (expanding shockwave ring + vertical beam), persistent player selection ring, pulsing player aura sprite, camera-facing motion-trail ribbon, hover emissive highlight. |
| Elemental orbs | `element-fx.ts` | Six procedural `ShaderMaterial` orbs — water, fire, wind, earth, snow, lava — plus runtime canvas textures (soft glow, spark, text labels). No downloaded assets. |
| Showcase | `showcase.ts` | Toggleable in-world ring of the six labeled orbs with bob animation and periodic element-colored spawn bursts. Local/decorative; not server entities. |
| Sky and time of day | `sky/day-sky.ts`, `sky/time-of-day.ts` | A sky dome (gradient, sun disc and glow bright enough for bloom, horizon haze, stars at night) and the sun/moon and sky lights, set every frame from the world's time of day (the welcome's day clock and the server tick, so all clients agree). The scene fog takes the haze colour, so far terrain meets the horizon at every hour. Noon matches the old fixed lighting; nights keep a moonlight floor. Adapted from ProceduralTerrains (MIT; `apps/client/THIRD_PARTY_NOTICES.md`). |
| Screen effects | `post-fx.tsx`, `effects/underwater-effect.ts` | pmndrs postprocessing over the whole frame: multisampled antialiasing, bloom (only light above the threshold glows: orbs, beams, lava, not the sky), a light vignette, and the underwater look (tint, murk by depth, wobble) faded in by the camera's depth below the water surface (`WaterRenderer.surfaceAt`). The HUD's "effects off" renders the scene directly for weak GPUs. |

`entity-layer.ts` owns lifecycle (driven by `world-canvas.tsx`, the React
Three Fiber scene): constructs FX systems, routes authoritative
player/entity transforms into them, raycasts hover, and disposes everything.

## Gotchas

- **Ribbon/strip geometry must be `THREE.DoubleSide`.** The trail's triangle
  winding flips with travel direction relative to the camera, so with the
  default `FrontSide` every triangle can be back-facing and the whole mesh is
  culled even though geometry, material, and draw range are all valid. All FX
  materials use `DoubleSide` for this reason.
- Trail/ring/beam materials are `transparent`, `depthWrite: false`, additive;
  `renderOrder` keeps them above opaque geometry.
- `frustumCulled = false` on dynamic-geometry meshes whose bounds change every
  frame (trail), so a stale bounding sphere can't cull them.
