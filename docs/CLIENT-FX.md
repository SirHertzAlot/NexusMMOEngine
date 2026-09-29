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
| Water | `water.ts`, `water-material.ts` | One shader pass, no reflection targets: three crossing swell trains plus close-up ripples tilt the normals; the sky is reflected by evaluating the sky dome's own function (`sky/sky-glsl.ts`, same uniforms) in the reflected direction, weighted by Fresnel, so the water mirrors the hour; a GGX sun glint; Beer-Lambert depth colour (clear, see-through shallows to dark deep water) and a broken, moving shore-foam band, both from a water-depth texture built from the world map (16 m cells, so the shallows follow the map's shoreline); the scene fog. From below, the surface glows with the light above. |
| Sky and time of day | `sky/day-sky.ts`, `sky/time-of-day.ts` | A sky dome (gradient, sun disc and glow bright enough for bloom, horizon haze, stars at night) and the sun/moon and sky lights, set every frame from the world's time of day (the welcome's day clock and the server tick, so all clients agree). The scene fog takes the haze colour, so far terrain meets the horizon at every hour. Noon matches the old fixed lighting; nights keep a moonlight floor. Adapted from ProceduralTerrains (MIT; `apps/client/THIRD_PARTY_NOTICES.md`). |
| Weather and splashes | `fx/particle-fx.ts`, `fx/weather.ts`, `fx/particles.json` | three-nebula particles, one GPU point-sprite draw call. Snow, rain and ash fall in a box that follows the camera (particles stay in world space) and fade in and out over `fadeSeconds`. What falls where is data: the `biomes` table gives each biome a kind and the share of weather spells it falls in; the spell is decided from the world tick and the biome (a hash), so every client sees the same shower. Splashes burst where the player swims and moves. Forces are divided by 100 (nebula's pixel scale) so the data stays in metres. |
| Terrain surfaces | `terrain/surfaces.ts`, `terrain/terrain-material.ts`, `scripts/fetch-surfaces.mjs` | Photo-scanned CC0 ground materials (Poly Haven, ambientCG; prepared by ProceduralTerrains), fetched by `npm run surfaces:fetch` into `apps/client/public/surfaces/` and never committed. The terrain blends each biome's material between the four nearest map cells (height-weighted), rock on slopes (triplanar), snow above the snow line, with normal maps, roughness and AO. Without the files the terrain keeps its flat biome colours. |
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
