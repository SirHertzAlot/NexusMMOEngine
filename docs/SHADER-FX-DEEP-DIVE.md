# Shader & FX R&D Deep Dive — NexusMMOEngine Client

**Target:** three.js r186 (`three/webgpu` + `three/tsl`, WebGL2 fallback).
**Starting point:** the client already has a serious FX stack — shared GLSL noise
library (`glsl.ts`), `onBeforeCompile` terrain injection, spawn portals / trails /
selection rings, six elemental orbs, a water shader with sky-function reflection
and GGX sun glint, day/night sky dome, three-nebula GPU weather particles,
photo-scanned terrain surfaces with triplanar blending, pmndrs post (selective
bloom, vignette, underwater), and a `toon/` directory. This R&D **extends** that
stack; nothing here replaces working systems.

**Art direction (recommended):** stylized PBR — standard physical shading with
the style in the *inputs* (hand-painted textures, painted bevels, disciplined
roughness), WoW-style VFX readability, Oblivion-Remaster-grade lighting quality.
True Lumen-style real-time GI is not available in any web renderer; everything
below is chosen to be shippable in a browser.

---

## 1. TSL — the shader authoring language

**What:** the Three Shading Language. Write a shader once in TypeScript-ish
node functions; it compiles to WGSL (WebGPU) and GLSL (WebGL2 fallback).
Since r171 it's production-ready with automatic fallback — no detection code.

**Why first:** every technique below is authored in TSL. And when the
in-editor node-graph shader builder arrives, TSL is its compilation target —
R&D done in TSL ports directly into the editor later.

**Code — dissolve material with HDR edge glow (TSL):**

```ts
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec3, vec4, float, uv, time, texture, smoothstep, mix } from 'three/tsl';

// _NoiseTexture: any tiling Perlin/RGBA noise texture
const dissolveAmount = uniform(float(0));   // 0..1 progress
const edgeColor = uniform(vec3(1.0, 0.45, 0.1)); // HDR-ish orange
const edgeWidth = uniform(float(0.06));

const dissolveNode = Fn(() => {
  const noise = texture(_NoiseTexture, uv()).r;
  const solid = noise.sub(dissolveAmount);            // >0 where still solid
  const edge = smoothstep(dissolveAmount, dissolveAmount.add(edgeWidth), noise);
  const col = mix(edgeColor.mul(4.0), vec3(0.02), solid.step(0.0)); // hot edge
  return vec4(col, solid.step(0.0));                   // alpha 0 where dissolved
})();

const mat = new THREE.MeshStandardNodeMaterial();
mat.colorNode = dissolveNode.rgb;
mat.opacityNode = dissolveNode.a;
mat.transparent = true;
```

~20 ALU + 1 texture sample per the standard recipe. Drive `dissolveAmount`
from gameplay (enemy death, teleport) — the edge glow is what sells it.
**Perf:** trivial. **Integrates:** `entity-fx.ts` death/teleport effects.

---

## 2. Area lights via LTC (the Oblivion-Remaster lighting upgrade)

**Paper:** Heitz, Dupuy, Hill, Neubelt (2016), *Real-Time Polygonal-Light
Shading with Linearly Transformed Cosines*, SIGGRAPH.
Project page: <https://eheitzresearch.wordpress.com/415-2/> ·
Reference code (BSD-3): <https://github.com/selfshadow/ltc_code>

**What:** analytic integration of polygonal area lights — soft shadow edges
and long GGX reflections fall out of the maths instead of a pile of point
lights. three.js already uses LTC internally for `RectAreaLight`; the R&D is
*more* of them, placed like a cinematographer: tavern interiors, portal
glow, forge light — rectangles, not points.

**Code — what we get for free today:**

```ts
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
RectAreaLightUniformsLib.init();
const forge = new THREE.RectAreaLight(0xff7733, 5, 4, 3);
forge.position.set(x, y, z);
forge.lookAt(0, 0, 0);
scene.add(forge);
```

**R&D experiment:** scene with 6–10 rect lights in a tavern interior vs.
equivalent point-light version; measure frame time and take golden stills.
**Verdict gate:** if >2ms at 1080p on the test GPU, fall back to 3 rect +
baked emissive. **Integrates:** `sky/time-of-day.ts` (sun as area light at
dawn/dusk), interior scenes.

---

## 3. Ambient occlusion — GTAO

**Paper:** Jimenez, Wu, Pesce, Jarabo (2016), *Practical Realtime Strategies
for Accurate Indirect Occlusion*.
**Reference implementation (MIT):** <https://github.com/amplifycreations/amplifyocclusion>
(Amplify Occlusion — was commercial, now open source; HBAO first, GTAO second.)

**What:** GTAO integrates visibility over the hemisphere per pixel — far
fewer halos and light leaks than classic SSAO, at comparable cost. Our
terrain (chunks, caves, overhangs) is exactly where AO sells depth.

**R&D path:** three.js ships `SSAOPass`; evaluate it first (one import, one
pass). If quality disappoints on terrain crevices, port the GTAO slice
integration from the Amplify reference into a TSL post node. **Verdict
gate:** half-res AO, bilateral upsample; must stay <1.5ms at 1080p.
**Integrates:** `post-fx.tsx` chain.

---

## 4. Stylized PBR inputs (the WoW look, technically)

**Reference:** Overwatch/Blizzard technical breakdowns (80.lv, frame
analysis). Core finding: **PBR underneath, style in the inputs.**

- **Painted bevels:** large soft bevels painted into normal/albedo maps give
  "dramatic rim light for free" — rim response baked into the material, not
  a fresnel term. Cheaper than real rim and art-directable.
- **Skin/creature SSS fake:** a dedicated "blood map" (subdermal color mask);
  the shader mixes it in on backlit/thin areas. No screen-space blur pass.
- **Specular-only detail:** micro-detail lives only in roughness/specular
  channels — flat readable albedo at distance, sparkle up close. Also kills
  specular aliasing: inflate roughness with distance (normal-map filtering
  101 — mip the roughness up as the normal map mips down).

**Code — painted rim + SSS mask on a standard material (TSL):**

```ts
const rimStrength = uniform(float(0.6));
const sssColor = uniform(vec3(0.9, 0.25, 0.15)); // blood map tint

mat.emissiveNode = Fn(() => {
  const vdn = normalView.dot(viewDirection).clamp(0.0, 1.0);
  const rim = vdn.oneMinus().pow(3.0).mul(rimStrength);
  const sss = texture(sssMask, uv()).r.mul(backlit); // backlit: NdotL<0 mask
  return rim.mul(rimTint).add(sss.mul(sssColor));
})();
```

**R&D experiment:** one hero creature with painted-bevel normals + SSS mask
vs. flat PBR; golden stills at noon/dusk/night. **Integrates:** character
pipeline (`render/character/`), creature materials.

---

## 5. Toon shading + outlines (we have `toon/` — sharpen it)

**Foundations:** cel shading = quantize the lighting equation (NdotL through
a 1D ramp texture — different ramps, different styles); shadows as *color*,
not darkness (anime: purple/blue-shifted base; western: warm-shifted).

**Outlines, two proven methods:**
- **Inverted hull** (~5 ALU/vertex): render backfaces, offset along normals
  in the vertex shader, flat dark color. Cheap, robust, no post pass.
- **Post-process depth+normal edges:** Sobel on depth + normal buffers;
  catches creases the hull misses. Costs a fullscreen pass.

**Code — ramp cel on TSL:**

```ts
// ramp: 1D texture, e.g. 4-step cartoon ramp
const ndl = normalView.dot(lightDir).clamp(0.0, 1.0);
const cel = texture(rampTex, vec2(ndl, 0.5)).r;
mat.colorNode = albedo.mul(shadowColor.mix(lightColor, cel));
```

**R&D experiment:** inverted hull on characters + ramp cel on props;
compare against post-process outlines for cost. **Verdict gate:** hull wins
unless crease detail is visibly lacking. **Integrates:** `toon/`.

---

## 6. Vegetation wind (WoW's actual formula)

**Reference:** open WoW reimplementation research — the shipped formula:

```glsl
// vertex shader
float sway = sin(uTime + dot(position.xy, vec2(0.071, 0.049)));
transformed.x += sway * 0.22 * windWeight;   // 0.22 = max deflection
transformed.z += sway * 0.22 * windWeight * 0.6;
// fragment: distance fade
float fade = smoothstep(0.72 * uDrawDist, uDrawDist, dist);
```

Lighting clamped to 0.55–1.0 (never fully dark), alpha blend back-to-front,
batched per chunk in a single pass with chunk-bounds culling.

**Code — TSL version for our grass (instanced):**

```ts
mat.positionNode = Fn(() => {
  const sway = time.add(positionLocal.xy.dot(vec2(0.071, 0.049))).sin();
  const w = sway.mul(0.22).mul(windWeight); // windWeight: per-instance attr
  return positionLocal.add(vec3(w, 0.0, w.mul(0.6)));
})();
```

**R&D experiment:** instanced grass clumps with this sway vs. static;
measure with 10k instances. **Integrates:** terrain grass system
(`instanced-props.ts`).

---

## 7. GPU particles via TSL compute (weather/spells at scale)

**What:** three-nebula (current) is CPU-driven. TSL compute moves particle
integration to the GPU: `instancedArray` + `storage` buffers, one dispatch.

**Code — compute particle drift (TSL):**

```ts
import { instancedArray, storage, instanceIndex, time, deltaTime } from 'three/tsl';

const COUNT = 50000;
const pos = instancedArray(COUNT, 'vec3'); // storage buffer
const vel = instancedArray(COUNT, 'vec3');

const integrate = Fn(() => {
  const i = instanceIndex;
  const p = pos.element(i);
  const v = vel.element(i);
  v.addAssign(vec3(0.0, -9.8, 0.0).mul(deltaTime)); // gravity
  v.addAssign(windField(p));                          // curl-ish wind
  p.addAssign(v.mul(deltaTime));
  // respawn in the camera-following box when below ground
  If(p.y.lessThan(0.0), () => { p.assign(respawnPos(i)); });
})().compute(COUNT);
```

**R&D experiment:** 50k GPU weather particles vs. nebula CPU path; frame
time + draw calls (target: 1 dispatch + 1 draw). Keep nebula for small
hero effects (splashes, bursts) where CPU control is handy.
**Integrates:** `fx/weather.ts`, spell effects.

---

## 8. Temporal AA (the sharpness upgrade)

**Recipe:** Karis (2014), *High Quality Temporal Supersampling*, SIGGRAPH
Advances in Real-Time Rendering — Halton(2,3) camera jitter, history
reprojection via the motion-vector (velocity) buffer, 3×3 neighborhood
clamping to reject ghosting. (Karis gives no millisecond figures; his
cost claim is qualitative: "high performance.")
**Numbers:** Yang, Liu & Salvi (2020), *A Survey of Temporal
Antialiasing Techniques*, Computer Graphics Forum 39(2) §7 Table 1
([survey PDF](http://behindthepixels.io/assets/files/TemporalAA.pdf)):
UE4's TAA pass costs **0.14ms @1080p → 0.52ms @4K on RTX 2080 Ti** —
i.e., cheap for what it buys.

**What:** jitter the camera with a Halton sequence, reproject history by
motion vectors, clamp neighborhoods to reject ghosting. Kills shimmer on our
vegetation/terrain detail and stabilizes speculars — the two noisiest things
in our frame.

**R&D path:** three.js WebGPU examples include TAA; evaluate the TSL TAA
node first. **Verdict gate:** ghosting test (fast camera pan past high
contrast edges); if ghosting is visible, fall back to SMAA. **Integrates:**
`post-fx.tsx` (replaces/augments current MSAA).

---

## 9. Sky, water, volumetrics — targeted upgrades

- **Sky:** we have a good day/night dome. R&D: precomputed atmospheric
  scattering LUT (Bruneton & Neyret's classic model — the industry standard
  reference) for the horizon silver-lining at dawn. Only if the current dome
  looks flat in stills.
- **Water:** already strong (sky-function reflection, GGX glint,
  Beer-Lambert depth, shore foam). R&D, in order: foam advection along flow
  direction; rain ripple normals. Skip Tessendorf FFT waves — beautiful but
  GPU-heavy for an MMO client.
- **Light shafts / volumetrics:** true volumetrics are out; the cheap
  classic is radial-blur shafts from the sun/moon disc + height fog
  (we have scene fog — extend its height falloff). One fullscreen pass,
  masked to bright pixels.

---

## 10. Optimization guardrails (non-negotiable)

From current best practice, enforced per experiment:
- **<100 draw calls/frame.** InstancedMesh for repeats, BatchedMesh for
  varied geometry sharing materials, merged static geometry.
- **Share material instances** — never create materials in loops.
- **Textures:** KTX2 (UASTC quality / ETC1S size), atlased, Draco/Meshopt
  geometry.
- **AO, shafts, TAA at half res** where the technique allows, bilateral
  upsample.
- **Quality tiers:** `quality.ts` already scales — every new effect
  registers a tier (off/low/high) there, no exceptions.

---

## R&D program (ordered experiments — verdict each)

Borrowing the Render-Tech-Lab format: every experiment ends with a
reproducible benchmark, golden stills, and a gain/cost verdict. No
experiment merges without one.

1. **TSL pipeline proof** — port one existing ShaderMaterial (an elemental
   orb) to TSL; WebGPU + WebGL2 fallback both render identically.
2. **Lighting rig** — ACES + soft shadows + rect-area tavern test (LTC).
3. **TAA evaluation** — ghosting test; TAA vs SMAA verdict.
4. **GTAO vs SSAOPass** — terrain crevice stills; <1.5ms gate.
5. **Material library v1** — rim/SSS/dissolve/cel-ramp on hero assets.
6. **Wind vegetation** — instanced grass, 10k instances.
7. **GPU weather** — 50k compute particles vs nebula.
8. **Shafts + fog** — radial-blur shafts, height fog.

## Papers & references

| # | Work | Why |
|---|------|-----|
| 1 | Heitz et al. 2016, *Real-Time Polygonal-Light Shading with Linearly Transformed Cosines* ([project](https://eheitzresearch.wordpress.com/415-2/), [code BSD-3](https://github.com/selfshadow/ltc_code)) | Analytic area lights — the lighting-quality upgrade |
| 2 | Jimenez et al. 2016, *Practical Realtime Strategies for Accurate Indirect Occlusion* ([MIT reference impl](https://github.com/amplifycreations/amplifyocclusion)) | GTAO — best cost/quality AO for our terrain |
| 3 | Karis 2014, *High Quality Temporal Supersampling* (recipe) + Yang, Liu & Salvi 2020, *A Survey of Temporal Antialiasing Techniques* ([survey PDF](http://behindthepixels.io/assets/files/TemporalAA.pdf), CGF 39(2) §7 Table 1) | TAA — 0.14ms @1080p → 0.52ms @4K (UE4, RTX 2080 Ti); kills vegetation/specular shimmer |
| 4 | Bruneton & Neyret, *Precomputed Atmospheric Scattering* (classic) | Reference model if our sky dome needs more depth |
| 5 | Overwatch/Blizzard breakdowns (80.lv, frame analysis) | Stylized-PBR input discipline: painted bevels, SSS masks, specular-only detail |

**Version note:** TSL examples target the `three/webgpu` + `three/tsl` API
stable since r171. Pin the three.js version for the R&D branch and verify
each snippet against the pinned docs — the API is stable but young.
