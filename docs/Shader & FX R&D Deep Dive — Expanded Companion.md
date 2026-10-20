# Shader & FX R&D Deep Dive — Expanded Companion

**Target:** three.js r186 (`three/webgpu` + `three/tsl`, WebGL2 fallback)
**Purpose:** This document expands the original R&D plan with source-backed API details, corrected code, fallback behavior analysis, and concrete implementation paths. API notes are sourced from official three.js docs, examples, and community references, but all code snippets are candidate TSL sketches — compile-check each against the pinned r186 branch before merging. The official WebGPURenderer guide still marks it experimental, though its maturity has greatly improved.

---

## Critical corrections to the original document

Before diving into the expanded sections, these corrections are important enough to flag up front:

### 1. GTAONode already ships in three.js — no port from Amplify needed

The original document says: "If quality disappoints on terrain crevices, port the GTAO slice integration from the Amplify reference into a TSL post node."

**Reality:** three.js ships a full `GTAONode` at `three/addons/tsl/display/GTAONode.js`. It implements the Jimenez et al. 2016 algorithm directly, with a new "Quadratic Ray Stepping" distance model introduced in r186. The API includes `radius`, `samples`, `scale`, `thickness`, `resolutionScale` (default 1.0, 0.5 recommended), and `useTemporalFiltering` (requires `TRAANode`). There is also a `DenoiseNode` for non-temporal noise reduction. The R&D task changes from "port the algorithm" to "evaluate the built-in node and tune its parameters."

```js
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { pass, mrt, normalView, screenUV } from 'three/tsl';
import { builtinAOContext } from 'three/tsl';

const renderPipeline = new THREE.RenderPipeline(renderer);

// Pre-pass: render scene with MRT to capture normals + depth in one pass
const prePass = pass(scene, camera);
prePass.setMRT(mrt({ output: normalView }));
const prePassNormal = prePass.getTextureNode();
const prePassDepth = prePass.getTextureNode('depth');

// Scene pass (beauty)
const scenePass = pass(scene, camera);

// GTAO
const aoPass = ao(prePassDepth, prePassNormal, camera);
aoPass.resolutionScale = 0.5;        // half-res, bilateral upsample
aoPass.radius = 0.5;                // tune for terrain scale
aoPass.samples = 16;               // higher = better quality, triggers recompile
// aoPass.useTemporalFiltering = true; // requires TRAANode in the pipeline

// Apply AO to the scene
scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
renderPipeline.outputNode = scenePass;
```

If MRT is unavailable, normals are automatically reconstructed from depth values in the shader — no manual fallback needed ([three.js GTAONode docs](https://threejs.org/docs/pages/GTAONode.html)).

### 2. TRAANode already ships — TAA is ready to evaluate

The original document says: "evaluate the TSL TAA node first." The node exists: `TRAANode` at `three/addons/tsl/display/TRAANode.js`.

```js
import { traa } from 'three/addons/tsl/display/TRAANode.js';

// Requires beauty, depth, and velocity texture nodes from a scene pass
const traaNode = traa(beautyNode, depthNode, velocityNode, camera);
// Properties:
//   depthThreshold: 0.0005  — history invalidation threshold
//   edgeDepthDiff: 0.001    — 3x3 neighborhood edge detection
//   maxVelocityLength: 128  — velocity-based history invalidation
//   useSubpixelCorrection: true — reduces blur under motion (can cause square artifacts)
```

**Critical constraint:** MSAA must be disabled when TRAA is in use. This means the current MSAA approach in `post-fx.tsx` must be replaced, not augmented — TRAA is the replacement, not an addition.

To get velocity data, the scene pass needs MRT with a velocity output. The `pass()` function supports this via `setMRT()`. One known issue: `InstancedMesh` velocity via `VelocityNode` treats all instances as a single stationary object, causing ghosting on moving instances. If the engine uses instanced units (mobs, props), per-instance velocity must be added — a community solution exists using 8 additional instance attributes ([Reddit: per-instance TAA velocity for InstancedMesh](https://www.reddit.com/r/threejs/comments/1rus2v8/building_an_rts_with_threejs_webgpu_perinstance/)).

### 3. RectAreaLight code is wrong for the WebGPU path

The original document's RectAreaLight code uses `RectAreaLightUniformsLib.init()`, which is the `WebGLRenderer` API. For `WebGPURenderer`, the LTC setup is different:

```js
// CORRECT for WebGPURenderer (three/webgpu):
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import * as THREE from 'three/webgpu';

THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());

const forge = new THREE.RectAreaLight(0xff7733, 5, 4, 3);
forge.position.set(x, y, z);
forge.lookAt(0, 0, 0);
scene.add(forge);
```

The `RectAreaLightTexturesLib` provides FP16 and FP32 LTC lookup textures (`LTC_FLOAT_1`, `LTC_FLOAT_2`, `LTC_HALF_1`, `LTC_HALF_2`). Use FP16 on mobile/tier-low for bandwidth savings ([three.js RectAreaLight docs](https://threejs.org/docs/pages/RectAreaLight.html), [RectAreaLightTexturesLib docs](https://threejs.org/docs/pages/RectAreaLightTexturesLib.html)).

**Limitation:** RectAreaLight has no shadow support and only works with PBR materials (`MeshStandardMaterial` / `MeshStandardNodeMaterial`). If shadows are needed from a rectangular source, use a soft-shadow point/spot light approximation instead.

### 4. GPU compute has a partial WebGL2 fallback — test per kernel

The original document's Section 7 (GPU particles) implies WebGPU is required. The actual situation is more nuanced:

- **TSL compute with `instancedArray` / `storage` / `compute()`:** The WebGL2 backend can emulate some compute patterns via **transform feedback**. Some buffer-update kernels (position, velocity integration) may run on both backends — the official compute particles example simulates 200,000 particles and is reported to run on both WebGPU and WebGL2. However, every kernel must be tested with `forceWebGL: true` before assuming compatibility.
- **Features that are WebGPU-only and do NOT fall back:**
  - Workgroup shared memory (`workgroupArray`, `workgroupBarrier`)
  - Storage textures
  - Indirect draws / indirect dispatch (`IndirectStorageBufferAttribute`)
  - Atomics (in practice — WebGPU only supports integer atomics, and the WebGL2 transform-feedback path cannot emulate indexed atomic reads)
  - Subgroup operations (`subgroupAdd`, `subgroupMin`, etc.)

**Impact on the R&D plan:** The 50k GPU weather particle experiment may target both backends if the compute kernel sticks to basic `instancedArray` read/write — but test it. The curl-noise wind field and respawn logic should work fine. If the kernel uses workgroup shared memory for spatial hashing (e.g., neighbor lookups for flocking), that path is WebGPU-only and needs a CPU fallback for WebGL2.

```js
// Candidate sketch — may work on both WebGPU and WebGL2 (transform feedback emulation).
// TEST with forceWebGL: true before assuming compatibility.
const integrate = Fn(() => {
  const i = instanceIndex;
  const p = pos.element(i);
  const v = vel.element(i);
  v.addAssign(vec3(0.0, -9.8, 0.0).mul(deltaTime));
  p.addAssign(v.mul(deltaTime));
  If(p.y.lessThan(0.0), () => { p.assign(respawnPos(i)); });
})().compute(COUNT);

// WebGPU-ONLY (workgroup shared memory) — no WebGL2 fallback:
const sharedData = workgroupArray('float', workgroupSize);
// ... no WebGL2 fallback
```

Verify by testing with `forceWebGL: true` in the renderer constructor ([three.js WebGPURenderer guide](https://threejs.org/manual/pages/webgpurenderer), [three.js forum: TSL and WebGL2 vs WebGPU](https://discourse.threejs.org/t/tsl-and-webgl2-vs-webgpu/87974), [Utsubo: WebGPU migration guide](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)).

### 5. PostProcessing was renamed to RenderPipeline in r183

The original document references `post-fx.tsx` and the pmndrs post chain. Since r183, the WebGPU post-processing class is `RenderPipeline` (formerly `PostProcessing`). `EffectComposer` and pmndrs/postprocessing do not work with `WebGPURenderer` — they are WebGL-only. The TSL node-based pipeline is the only path for WebGPU post-processing ([Cinevva: Three.js r183 RenderPipeline](https://app.cinevva.com/news/2026-03-18-threejs-r183-render-pipeline)).

### 6. TSL has built-in height fog — no custom shader needed

The original document mentions "extend [scene fog's] height falloff" for volumetric shafts. TSL already ships `exponentialHeightFogFactor(density, height)`:

```js
import { fog, exponentialHeightFogFactor, color } from 'three/tsl';

scene.fogNode = fog(
  color(0x8899aa),
  exponentialHeightFogFactor(0.02, 0.0) // density, height threshold
);
```

This gives exponential fog below a world-space Y threshold — exactly what the original doc describes, with no custom shader work ([three.js TSL docs](https://threejs.org/docs/pages/TSL.html)).

### 7. TSL has a built-in outline node

The original document's Section 5 (toon outlines) discusses inverted hull vs. post-process depth+normal edges. Three.js also ships a TSL `outline()` function for outline effects around selected objects, which could serve as a third option for selection/interaction outlines (distinct from art-style outlines):

```js
import { outline } from 'three/tsl';
// outline(scene, camera, params) — creates OutlineNode for selected objects
```

### 8. WaterMesh exists for WebGPU

The original document's water system is custom. For reference, three.js ships `WaterMesh` for `WebGPURenderer` (the `Water` class is WebGL-only). `WaterMesh` is TSL-based with `UniformNode` properties for `sunColor`, `sunDirection`, `waterColor`, `distortionScale`, `resolutionScale`, and `waterNormals`. The engine's custom water shader is already more advanced (sky-function reflection, GGX glint, Beer-Lambert depth) — `WaterMesh` is a simpler reference, not a replacement ([three.js WaterMesh docs](https://threejs.org/docs/pages/WaterMesh.html)).

### 9. Atmospheric scattering has a three.js package

The original document lists Bruneton & Neyret's precomputed atmospheric scattering as a reference "if the current dome looks flat." There is now `@takram/three-atmosphere`, an npm package implementing Bruneton's model with WebGPU support, including a 4D scattering LUT and Hillaire's multiple-scattering improvement. It has a node-based architecture (`AtmosphereLUTNode`) and is actively maintained. Verify the package's license and production-readiness before bundling ([npm: @takram/three-atmosphere](https://www.npmjs.com/package/@takram/three-atmosphere), [takram/three-geospatial WebGPU docs](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/WEBGPU.md), [Bruneton's reference implementation](https://github.com/ebruneton/precomputed_atmospheric_scattering)).

### 10. r186-specific changes that affect this R&D

- `PCFSoftShadowMap` was removed — the renderer warns and falls back to `PCFShadowMap`. If the engine uses soft shadows, verify shadow quality and consider a custom shadow blur.
- `distanceExponent` and `distanceFallOff` on `GTAONode` are deprecated — the new "Quadratic Ray Stepping" distance model doesn't need them.
- `render()` on an uninitialized `WebGPURenderer` throws an error. Ensure `await renderer.init()` completes before any render call, or use `setAnimationLoop()` which handles init automatically.
- `rangeFog` and `viewportResolution` TSL exports were removed.

([Utsubo: What's new in Three.js 2026](https://www.utsubo.com/blog/threejs-2026-what-changed))

---

## Expanded sections

### Section 1: TSL — the shader authoring language

#### Verified API status

TSL is production-ready since r171 (November 2024). In r186, `WebGPURenderer` is the default renderer path with near zero-config setup and automatic WebGL2 fallback. TSL compiles to WGSL on the WebGPU backend and GLSL on the WebGL2 backend — one shader covers both ([PlayCanvas vs Three.js comparison](https://app.cinevva.com/guides/playcanvas-vs-threejs), [three.js WebGPURenderer guide](https://threejs.org/manual/pages/webgpurenderer)).

**What this means for the engine:** The existing GLSL noise library (`glsl.ts`) and `onBeforeCompile` terrain injection **cannot** be used with `WebGPURenderer` — not on the WebGPU backend, not on the WebGL2 fallback. Both paths require node materials and TSL. The migration is mandatory if switching to `WebGPURenderer`. However, the `WebGLRenderer` path remains maintained and can be used as a transitional target with the `WebGLNodesHandler` bridge for limited node material support.

#### Node material classes available

| Class | Use case |
|---|---|
| `MeshBasicNodeMaterial` | Unlit, textures, vertex displacement |
| `MeshStandardNodeMaterial` | PBR (metallic-roughness), the workhorse |
| `MeshPhysicalNodeMaterial` | PBR + clearcoat, sheen, transmission, SSS |
| `MeshToonNodeMaterial` | Cel-shaded with gradient map |
| `LineBasicNodeMaterial` | Lines |
| `SpriteNodeMaterial` | Sprites |
| `PointsNodeMaterial` | GPU point sprites |

#### Key node properties on `MeshStandardNodeMaterial`

| Property | Type | Description |
|---|---|---|
| `colorNode` | `Node<vec3>` | Overrides diffuse color |
| `opacityNode` | `Node<float>` | Overrides opacity |
| `emissiveNode` | `Node<vec3>` | Overrides emissive (default from `emissive`/`emissiveIntensity`/`emissiveMap`) |
| `roughnessNode` | `Node<float>` | Overrides roughness |
| `metalnessNode` | `Node<float>` | Overrides metalness |
| `normalNode` | `Node<vec3>` | Overrides surface normal |
| `positionNode` | `Node<vec3>` | Vertex displacement |
| `aoNode` | `Node<float>` | Ambient occlusion influence on diffuse/ambient |

To modify rather than replace a property, use `materialEmissive`, `materialRoughness`, etc. — these reference the existing value and let you chain operations on top ([three.js MeshStandardNodeMaterial docs](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)).

#### TSL pipeline proof — corrected dissolve material

The original document's dissolve snippet is close but has issues: `_NoiseTexture` is undeclared, and `positionLocal`/`viewDirection`/`normalView` need explicit imports. Here is a corrected version (candidate TSL sketch — compile-check against r186):

```js
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec3, vec4, float, uv, time, texture,
         smoothstep, mix } from 'three/tsl';
// Note: normalView, viewDirection, positionLocal, dot, pow, oneMinus, step
// are available as TSL functions/nodes — verify exact import names against r186 docs.

// Uniforms
const dissolveAmount = uniform(0);          // 0..1 progress
const edgeColor = uniform(vec3(1.0, 0.45, 0.1));
const edgeWidth = uniform(0.06);
const noiseTexture = uniform(null);          // assign a THREE.Texture

const dissolveNode = Fn(() => {
  const noise = texture(noiseTexture, uv()).r;
  const solid = noise.sub(dissolveAmount);
  const edge = smoothstep(dissolveAmount, dissolveAmount.add(edgeWidth), noise);
  const col = mix(edgeColor.mul(4.0), vec3(0.02), solid.step(0));
  return vec4(col, solid.step(0));
})();

const mat = new THREE.MeshStandardNodeMaterial();
mat.colorNode = dissolveNode.rgb;
mat.opacityNode = dissolveNode.a;
mat.transparent = true;
```

#### Integration plan

| Task | File | Notes |
|---|---|---|
| Port one elemental orb ShaderMaterial to TSL | `entity-fx.ts` | Prove WebGPU + WebGL2 render identically |
| Port dissolve material | `entity-fx.ts` | Death/teleport effect |
| Port shared noise library from GLSL to TSL | `glsl.ts` | Critical foundation — all TSL effects depend on this |
| Verify `onBeforeCompile` terrain injection → TSL | terrain system | Largest migration risk |

---

### Section 2: Area lights via LTC

#### Verified API

`RectAreaLight` works with `WebGPURenderer` and uses LTC internally. The initialization differs from `WebGLRenderer`:

```js
// WebGPURenderer path:
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import * as THREE from 'three/webgpu';

THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
```

The `RectAreaLightTexturesLib` provides FP32 and FP16 LTC textures. For quality tiers, use FP32 on high and FP16 on low/mobile.

#### Constraints

- No shadow support — RectAreaLight cannot cast shadows
- Only PBR materials (`MeshStandardMaterial` / `MeshStandardNodeMaterial`) respond to it
- The `lookAt()` method orients the light's face toward the target

#### R&D experiment design

Build a tavern interior test scene with:
- 6-10 `RectAreaLight` instances (forge glow, window light, torch strips, portal glow)
- Equivalent point-light version for comparison
- ACES tone mapping + soft shadows (PCFShadowMap in r186)
- Measure frame time at 1080p on the test GPU

**Verdict gate:** If >2ms at 1080p, fall back to 3 rect lights + baked emissive on static geometry. The LTC cost scales with the number of rect lights — each adds a per-pixel integration pass.

#### Integration points

| Location | Use |
|---|---|
| `sky/time-of-day.ts` | Sun as area light at dawn/dusk (large rect, warm color) |
| Interior scenes | Tavern/forge/dungeon lighting |
| Portal effects | Rect light at portal position, tinted to element color |

---

### Section 3: Ambient occlusion — GTAO (built-in, not a port)

#### What changed

The original document planned to port GTAO from the Amplify reference. **three.js already ships `GTAONode`** — the R&D task is evaluation and tuning, not implementation.

#### Verified API

```js
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { pass, mrt, normalView, screenUV } from 'three/tsl';
import { builtinAOContext } from 'three/tsl';

// MRT pre-pass for normals + depth (single render pass)
const prePass = pass(scene, camera);
prePass.setMRT(mrt({ output: normalView }));
const prePassNormal = prePass.getTextureNode();
const prePassDepth = prePass.getTextureNode('depth');

// GTAO node
const aoPass = ao(prePassDepth, prePassNormal, camera);
```

#### Properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `radius` | `UniformNode<float>` | — | AO sampling radius in world units |
| `samples` | `UniformNode<float>` | — | Sample count; changing triggers shader recompile |
| `scale` | `UniformNode<float>` | — | AO intensity scale |
| `thickness` | `UniformNode<float>` | — | Max occluder distance |
| `resolutionScale` | `number` | `1` | Use `0.5` for half-res (recommended for perf) |
| `useTemporalFiltering` | `boolean` | `false` | Requires `TRAANode` in pipeline; reduces noise but introduces ghosting |

**r186 changes:** `distanceExponent` and `distanceFallOff` are deprecated. The new "Quadratic Ray Stepping" distance model handles falloff automatically.

**Fallback:** If MRT is unavailable, normals are reconstructed from depth in the shader — no manual fallback code needed.

**Temporal filtering:** When `useTemporalFiltering = true`, GTAO uses the temporal rotation sequence `[60, 300, 180, 240, 120, 0]` degrees to jitter samples across frames. This requires `TRAANode` in the pipeline. If temporal filtering is disabled, a `DenoiseNode` may be needed for noise reduction ([three.js GTAONode docs](https://threejs.org/docs/pages/GTAONode.html), [DeepWiki: Post-Processing Pipeline](https://deepwiki.com/mrdoob/three.js/3.6-post-processing-pipeline)).

#### Performance budget

Target: half-res (`resolutionScale = 0.5`), bilateral upsample, <1.5ms at 1080p. The MRT pre-pass adds one scene render but saves a separate normal-render pass.

#### Verdict gate

Golden stills of terrain crevices, cave entrances, and overhangs at noon and dusk. Compare against:
1. No AO (baseline)
2. SSAOPass (if still on WebGLRenderer path)
3. GTAO without temporal filtering
4. GTAO with temporal filtering + TRAA

---

### Section 4: Stylized PBR inputs

#### Verified Overwatch findings

Timothy Bermanseder's frame analysis of Overwatch confirmed ([80.lv: Overwatch Technical Overview](https://80.lv/articles/overwatch-technical-overview)):

- **PBR underneath, style in the inputs.** Overwatch was a testbed for PBR workflow, pursuing a film/Pixar look.
- **Painted bevels** were baked into textures — large soft bevels gave objects a softer, rounder finish and produced "a dramatic rim-light feeling for completely free" without additional modeled geometry or a real-time rim shader.
- **Specular-only detail.** Subtle micro-detail was placed only in the specular/roughness channels. This kept materials readable and simple at a distance, with detail appearing up close when illuminated.
- **Corner pieces** covered seams, broke up repetition, and created a chunkier, more three-dimensional world. The team avoided sharp 90-degree angles.
- **Layered materials** blended tiling textures with static props (puddles in cobblestones, sand in bricks, moss on rocks) to avoid stale-looking scenes.
- **Cubemap reflections** were used in windows, puddles, and on slightly metallic surfaces for depth.
- **Texture sizes:** Some characters used 1024x2048 (non-square) to accommodate long UV islands without diagonal painting and aliasing.

The SSS/blood-map technique in the original document is not confirmed from the Overwatch analysis — it comes from general stylized-character best practice. The principle is sound: a subdermal color mask mixed in on backlit/thin areas provides a cheap SSS fake without a screen-space blur pass.

#### Corrected TSL code — painted rim + SSS mask

```js
// Candidate TSL sketch — based on r186 node material API. Compile-check before merge.
import { Fn, uniform, vec3, float, uv, texture, mix } from 'three/tsl';
// Note: normalView, viewDirection, dot, pow, oneMinus are TSL nodes — verify imports.

const rimStrength = uniform(0.6);
const rimTint = uniform(vec3(1.0, 0.9, 0.8));
const sssColor = uniform(vec3(0.9, 0.25, 0.15));
const sssMaskTex = uniform(null);    // blood map texture
const backlitMask = uniform(null);   // NdotL < 0 mask texture

mat.emissiveNode = Fn(() => {
  // Rim: fresnel-based, pow(3) for sharp falloff
  const vdn = dot(normalView, viewDirection).clamp(0, 1);
  const rim = oneMinus(vdn).pow(3).mul(rimStrength);

  // SSS: blood map tinted on backlit areas
  const sss = texture(sssMaskTex, uv()).r.mul(texture(backlitMask, uv()).r);

  return rim.mul(rimTint).add(sss.mul(sssColor));
})();
```

#### R&D experiment

One hero creature with:
- Painted-bevel normal maps (large soft bevels in normal map, not geometry)
- SSS blood map on thin areas (ears, nose, fingers)
- Specular-only micro-detail in roughness map
- Inflated roughness at distance (mip the roughness up as normal map mips down)

Compare against flat PBR at noon, dusk, and night. Golden stills.

---

### Section 5: Toon shading + outlines

#### Three paths available

| Method | Cost | What it catches | TSL support |
|---|---|---|---|
| Inverted hull | ~5 ALU/vertex | Silhouette only | `positionNode` offset on a `BackSide` material |
| Post-process depth+normal edges | 1 fullscreen pass | Silhouette + creases | Custom TSL post node using `pass()` depth+normal |
| `outline()` TSL node | Built-in | Selected objects only | `three/tsl` `outline()` function |

#### Inverted hull — verified approach

Render a copy of the mesh with `side: THREE.BackSide`, offset vertices along normals in the vertex shader, flat dark color. The key detail from community implementations: **smoothed normals matter** — hard-edged models extruded along per-face normals tear the hull open at every corner. If the mesh has hard edges, generate smoothed normals for the outline pass ([polyfork.dev: Three.js shaders](https://polyfork.dev/threejs-shaders), [ronja-tutorials: Inverted Hull](https://deepwiki.com/ronja-tutorials/ShaderTutorials/8-outline-and-masking-effects)).

```js
// Candidate TSL sketch — compile-check against r186.
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec3, normalLocal, positionLocal } from 'three/tsl';

const outlineWidth = uniform(0.02);

const outlineMat = new THREE.MeshBasicNodeMaterial();
outlineMat.side = THREE.BackSide;
outlineMat.colorNode = uniform(vec3(0, 0, 0));
outlineMat.positionNode = Fn(() => {
  return positionLocal.add(normalLocal.mul(outlineWidth));
})();
```

#### MeshToonMaterial — zero-code cel shading

Three.js ships `MeshToonMaterial` with a `gradientMap` property for cel-shading bands. The gradient map must use `NearestFilter` to prevent interpolation between bands ([three.js MeshToonMaterial docs](https://threejs.org/docs/pages/MeshToonMaterial.html), [salivity: Three.js cel shading](https://salivity.github.io/three.js/article/three-js-cel-shading-with-mesh-toon-material)):

```js
// 4-step cartoon ramp
const colors = new Uint8Array([0, 80, 160, 255]);
const gradientMap = new THREE.DataTexture(colors, 4, 1, THREE.RedFormat);
gradientMap.minFilter = THREE.NearestFilter;
gradientMap.magFilter = THREE.NearestFilter;
gradientMap.needsUpdate = true;

const toonMat = new THREE.MeshToonMaterial({
  color: 0x44aacc,
  gradientMap: gradientMap
});
```

For the TSL path, verify whether a `MeshToonNodeMaterial` class exists in r186 — the node-based equivalent of `MeshToonMaterial` may have a different name. If it exists, it allows overriding the gradient ramp via a `texture()` node for more control (different ramps per material, animated ramp transitions). If not, use `MeshToonMaterial` directly or build a custom cel-shading node on `MeshStandardNodeMaterial` via `colorNode`.

#### R&D experiment

| Test | Method | Target |
|---|---|---|
| Character outlines | Inverted hull on characters | `toon/` |
| Prop cel shading | `MeshToonMaterial` with 4-step ramp | Props, environmental objects |
| Crease detection | Post-process depth+normal Sobel | Test if hull misses creases |
| Selection outlines | `outline()` TSL node | Interaction/selection system |

**Verdict gate:** Inverted hull wins for character outlines unless crease detail is visibly lacking. Use post-process edges only if the hull misses internal creases that matter visually.

---

### Section 6: Vegetation wind

#### Verified grass rendering approach

The standard technique uses `InstancedMesh` with one shared blade geometry drawn thousands of times in a single draw call. Per-instance position, rotation, and scale are set via a 4x4 transform matrix. Wind sway is added in the vertex shader, displacing only the top vertices (interpolated by blade local Y so the base stays planted) ([threejsresources.com: Three.js grass guide](https://threejsresources.com/guides/grass), [al-ro: 100k instanced grass](https://al-ro.github.io/projects/grass/)).

#### Two-octave wind — improved formula

The original document's WoW formula uses a single sine. Community best practice recommends two octaves: a slow broad sway plus a faster, smaller flutter. The WoW formula's constants (`0.071, 0.049`, max deflection `0.22`) are good starting points:

```js
// Candidate TSL sketch — compile-check against r186.
// IMPORTANT: phase should use world/instance XZ position, not positionLocal.xy,
// so neighboring blades sway together in waves rather than all identically.
// windWeight should be an instanced attribute (per-blade), not a uniform,
// if per-blade variation is desired.
import { Fn, time, positionLocal, vec3, vec2, dot, sin } from 'three/tsl';
// Note: worldPosition or instanceMatrix-derived XZ should be used for phase.
// Verify exact TSL node names for world-space position access.

const windSpeed = uniform(1.0);
// windWeight: set as an instanced attribute on the InstancedMesh, not a uniform

mat.positionNode = Fn(() => {
  // Phase from world XZ (not local XY) so neighbors sway together
  // const worldXZ = ... // derive from instanceMatrix or worldPosition
  // Octave 1: slow broad sway (WoW formula constants)
  const sway1 = sin(time.mul(windSpeed).add(
    /* worldXZ.dot(vec2(0.071, 0.049)) */
  ));

  // Octave 2: faster, smaller flutter
  const sway2 = sin(time.mul(windSpeed.mul(3.0)).add(
    /* worldXZ.dot(vec2(0.13, 0.08)) */
  )).mul(0.3);

  const totalSway = sway1.add(sway2);
  const w = totalSway.mul(0.22); // .mul(windWeight) if per-instance

  // Only displace top of blade (interpolate by local Y)
  const heightFactor = positionLocal.y.clamp(0, 1);

  return positionLocal.add(vec3(
    w.mul(heightFactor),
    0,
    w.mul(0.6).mul(heightFactor)
  ));
})();
```

#### Scaling strategy

| Instance count | Strategy |
|---|---|
| <10k | Single `InstancedMesh`, one draw call |
| 10k-50k | Chunk into tiles, frustum + distance cull |
| >50k | GPU-driven placement via compute shader (WebGPU), CPU fallback (WebGL2) |

For distance-based fade, use `smoothstep` on view distance. Lighting should be clamped to 0.55-1.0 (never fully dark) for grass readability.

---

### Section 7: GPU particles via TSL compute

#### Verified compute API

The TSL compute system uses `instancedArray` for storage buffers, `instanceIndex` for the compute invocation index, and `Fn(() => {...})().compute(count, [workgroupSize])` to define and dispatch compute kernels ([three.js TSL docs](https://threejs.org/docs/pages/TSL.html), [Makio64: advanced-threejs-tsl-webgpu-rendering](https://github.com/Makio64/advanced-threejs-tsl-webgpu-rendering)).

```js
// Candidate TSL sketch — based on official TSL compute docs and Makio64 reference.
// TEST with forceWebGL: true before assuming WebGL2 compatibility.
import { Fn, instanceIndex, instancedArray, uniform, deltaTime } from 'three/tsl';

const COUNT = 50000;
const pos = instancedArray(COUNT, 'vec3');
const vel = instancedArray(COUNT, 'vec3');

const integrate = Fn(() => {
  const i = instanceIndex;
  const p = pos.element(i);
  const v = vel.element(i);

  v.addAssign(vec3(0.0, -9.8, 0.0).mul(deltaTime));  // gravity
  p.addAssign(v.mul(deltaTime));

  If(p.y.lessThan(0.0), () => {
    p.assign(respawnPos(i));
    v.assign(vec3(0));
  });
})().compute(COUNT);

// Execute before the render that reads the buffers:
renderer.compute(integrate);
```

**Call `renderer.compute()` inside `setAnimationLoop()`, before the render that reads the data.**

#### Advanced compute patterns (WebGPU-only)

From the Makio64 reference, these patterns are available but **WebGPU-backend-only**:

| Pattern | TSL functions | Speedup | WebGL2? |
|---|---|---|---|
| Subgroup reductions | `subgroupAdd`, `subgroupMin`, `subgroupMax`, `subgroupBallot`, `subgroupShuffle` | 32-64x vs barriers | No |
| Workgroup shared memory | `workgroupArray`, `workgroupBarrier` | ~100x vs global access | No |
| Atomics | `atomicAdd`, `atomicMin`, `atomicMax`, etc. | 10-50x slower than regular writes | No |
| Vectorized access | `vec4` storage buffers | 4x throughput | Yes (transform feedback) |
| Work-per-thread | `Loop()` with `instanceIndex.mul(workPerThread)` | 2-8x for memory-bound | Yes |
| PBO async readback | `.setPBO(true)` + `renderer.getArrayBufferAsync()` | Non-blocking readback | No |

#### Performance optimization for 50k+ particles

- Use `vec4` storage instead of separate `float` channels for 4x throughput
- Use `workPerThread = 4` to reduce dispatch overhead on memory-bound workloads
- Avoid atomics — use reduction passes instead
- Use ping-pong buffers for iterative simulations (avoid read-write hazards)
- Query device limits for max workgroup size: `renderer.backend.device.limits.maxComputeWorkgroupSizeX`

#### Fallback strategy

| Feature | WebGPU | WebGL2 (transform feedback) |
|---|---|---|
| Basic position/velocity integration | Yes | Yes |
| Curl-noise wind field | Yes | Yes (if no workgroup memory) |
| Spatial hashing / neighbor lookup | Yes (workgroup shared memory) | No — CPU fallback |
| Indirect draw (GPU-driven culling) | Yes | No |
| Atomics (safe concurrent writes) | Yes | No |
| Subgroup ops | Yes | No |

**R&D plan:** Keep three-nebula for small hero effects (splashes, bursts) where CPU control is handy. Use TSL compute for weather (rain, snow, ambient particles) at scale. The 50k weather particle kernel should stick to basic `instancedArray` read/write so it works on both backends.

---

### Section 8: Temporal AA (TRAANode)

#### Verified API

`TRAANode` ships at `three/addons/tsl/display/TRAANode.js`. It requires beauty, depth, and velocity texture nodes — all obtainable from a `pass()` scene render with MRT ([three.js TRAANode docs](https://threejs.org/docs/pages/TRAANode.html)).

```js
// Candidate sketch — TRAANode docs show the constructor signature, but the
// exact MRT velocity output node name and pass() API details need verification.
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { pass, mrt } from 'three/tsl';
// Verify: the velocity output node name in mrt() — 'velocity' is a guess.

const scenePass = pass(scene, camera);
// scenePass.setMRT(mrt({ output: velocity })); // verify exact API
const beauty = scenePass.getTextureNode();
const depth = scenePass.getTextureNode('depth');
// const velTex = scenePass.getTextureNode('velocity');

// TRAA
// const traaNode = traa(beauty, depth, velTex, camera);
// traaNode.useSubpixelCorrection = true;
// traaNode.depthThreshold = 0.0005;
// traaNode.maxVelocityLength = 128;

// renderPipeline.outputNode = traaNode;
```

**Critical:** MSAA must be disabled when TRAA is in use. Set `antialias: false` on the renderer constructor. This replaces the current MSAA approach.

#### Properties

| Property | Default | Description |
|---|---|---|
| `depthThreshold` | `0.0005` | Depth delta above which history is invalid |
| `edgeDepthDiff` | `0.001` | 3x3 neighborhood depth diff for edge detection |
| `maxVelocityLength` | `128` | Pixel velocity above which history is invalid |
| `useSubpixelCorrection` | `true` | Reduces blur under subpixel motion; can cause square pattern artifacts |

#### Known issue: InstancedMesh velocity

The `VelocityNode` treats `InstancedMesh` as a single stationary object. Moving instances appear ghosted. If the engine uses instanced mobs/props, per-instance velocity must be injected — a community solution uses 8 additional instance attributes (previous position, current position) to compute per-instance motion vectors ([Reddit: per-instance TAA velocity](https://www.reddit.com/r/threejs/comments/1rus2v8/building_an_rts_with_threejs_webgpu_perinstance/)).

#### Fallback: SMAA

If TRAA ghosting is visible in the fast-camera-pan test, fall back to SMAA:

```js
// Candidate sketch — verify import path and function signature against r186.
// The TSL docs list smaa() and fxaa() functions but the exact addon paths
// and argument shapes should be checked.
import { smaa } from 'three/addons/tsl/display/SMAANode.js'; // verify path
// renderPipeline.outputNode = smaa(scenePass); // verify args
```

SMAA provides subpixel morphological anti-aliasing without temporal reprojection — no ghosting, but less effective on vegetation/specular shimmer. FXAA is also available as a lighter alternative (`fxaa()` from `three/addons/tsl/display/FXAANode.js`), but it operates in sRGB space and should be applied after tone mapping ([three.js TSL docs](https://threejs.org/docs/pages/TSL.html)).

#### Verdict gate

Ghosting test: fast camera pan past high-contrast edges (character silhouettes against bright sky, portal edges). If ghosting is visible and unacceptable, fall back to SMAA. TRAA is most valuable for vegetation and terrain detail shimmer — the two noisiest things in the frame.

---

### Section 9: Sky, water, volumetrics — targeted upgrades

#### Sky: precomputed atmospheric scattering

The engine has a day/night dome. If it looks flat in stills, the upgrade path is `@takram/three-atmosphere` — a production-ready npm package implementing Bruneton's precomputed atmospheric scattering with:

- 4D scattering LUT (transmittance, single Rayleigh + red Mie, multiple scattering)
- Hillaire's multiple-scattering improvement (2D LUT, isotropic approximation)
- Raymarching of scattered light between camera and scene objects (eliminates float precision artifacts)
- WebGPU node-based architecture (`AtmosphereLUTNode`)
- TSL implementation that compiles to both WGSL and GLSL

The package is part of `@takram/three-geospatial` and has WebGPU support documented ([npm: @takram/three-atmosphere](https://www.npmjs.com/package/@takram/three-atmosphere), [takram WebGPU docs](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/WEBGPU.md), [Bruneton's reference](https://github.com/ebruneton/precomputed_atmospheric_scattering), [Bruneton & Neyret paper](https://inria.hal.science/inria-00288758/document), [Hillaire 2020](https://sebh.github.io/publications/egsr2020.pdf)).

The silver-lining at dawn/dusk — the horizon glow effect — falls out of the physics automatically when using a proper atmospheric model.

#### Water: targeted upgrades (in priority order)

The engine's water shader is already strong (sky-function reflection, GGX glint, Beer-Lambert depth, shore foam). Targeted upgrades:

1. **Foam advection along flow direction.** Use a world-locked GPU field that stores current velocities (m/s in XZ). Advect foam and ripple normals along the flow using the two-phase flow-map trick (two samples half a cycle apart, cross-faded so nothing stretches). Reference: [Tidewater Three.js water kit](https://gettidewater.com/docs/) implements this pattern.

2. **Rain ripple normals.** A procedural normal-map layer driven by time and a noise texture, applied as a perturbation to the water normal. Cheap — one texture sample + a few ALU.

3. **Skip Tessendorf FFT waves.** Beautiful but GPU-heavy for an MMO client. The current Gerstner/normal-map approach is sufficient. If FFT is ever desired, the Tidewater kit implements a cascaded FFT ocean with three spectrum bands as a reference.

#### Light shafts / volumetrics

True volumetrics are out for a browser MMO. The cheap classic approach:

1. **Radial-blur god rays** from the sun/moon disc. three.js ships `GodRaysShader` as an addon (WebGL/EffectComposer path). For WebGPU, implement as a TSL post node: render the scene, threshold bright pixels, radial blur from sun screen position, additive blend back. One fullscreen pass, masked to bright pixels.

2. **Height fog.** Use the built-in TSL `exponentialHeightFogFactor(density, height)` — no custom shader needed:

```js
import { fog, exponentialHeightFogFactor, color } from 'three/tsl';

scene.fogNode = fog(
  color(0x8899aa),
  exponentialHeightFogFactor(0.02, 0.0)
);
```

This gives exponential fog below a world-space Y threshold. Everything below the height value gets fog; the density controls falloff rate ([three.js TSL docs](https://threejs.org/docs/pages/TSL.html)).

---

### Section 10: Optimization guardrails (expanded)

#### Draw call management

| Technique | When to use | API |
|---|---|---|
| `InstancedMesh` | Many identical meshes (grass, rocks, props) | `new THREE.InstancedMesh(geometry, material, count)` |
| `BatchedMesh` | Varied geometry sharing materials | `new THREE.BatchedMesh(maxGeometryCount, maxVertexCount, maxIndexCount, material)` |
| Merged static geometry | Static world geometry that never moves | `BufferGeometryUtils.mergeGeometries()` |
| Indirect draws (WebGPU only) | GPU-driven culling + draw | `geometry.setIndirect()` |

Target: <100 draw calls/frame. Share material instances — never create materials in loops.

#### Texture and geometry compression

| Format | Use case | Notes |
|---|---|---|
| KTX2 UASTC | Quality-critical textures (hero assets, UI) | Higher quality, larger size |
| KTX2 ETC1S | Size-critical textures (terrain, props) | Smaller, slight quality loss |
| Draco | Geometry compression | Use `DRACOLoader` |
| Meshopt | Geometry compression | Better ratio than Draco for some meshes, use `MeshoptDecoder` |

#### Resolution scaling for post-processing

| Effect | Recommended resolution | Notes |
|---|---|---|
| GTAO | Half-res (`resolutionScale = 0.5`) | Bilateral upsample preserves edges |
| Light shafts | Half-res | Bright-pixel threshold mask |
| TRAA | Full-res | Temporal reprojection needs full res |
| Bloom | Quarter-res | Already handled by pmndrs bloom |
| Vignette | Full-res | Trivial cost |

#### Quality tier registration

Every new effect must register a tier in `quality.ts`:

```ts
// quality.ts
export const qualityTiers = {
  gtao: { off: false, low: { samples: 8, resolutionScale: 0.5 }, high: { samples: 16, resolutionScale: 0.5 } },
  traa: { off: false, low: false, high: true },  // off/low use SMAA, high uses TRAA
  rectLights: { off: 0, low: 3, high: 8 },       // count per scene
  gpuWeather: { off: 5000, low: 15000, high: 50000 }, // particle count
  atmosphericScattering: { off: false, low: false, high: true },
};
```

---

## WebGL continuity plan

The current engine uses `WebGLRenderer` with pmndrs `EffectComposer` for post-processing (selective bloom, vignette, underwater). This stack remains functional on the `WebGLRenderer` path. The WebGPU branch uses `RenderPipeline` with TSL nodes — `EffectComposer` and pmndrs/postprocessing do not work with `WebGPURenderer`.

**Transition strategy:**

1. Maintain the existing `WebGLRenderer` + pmndrs stack as the production path during R&D.
2. Build the `WebGPURenderer` + `RenderPipeline` path in parallel on an R&D branch.
3. Port post-processing effects one at a time to TSL nodes (bloom, vignette, underwater) using the TSL equivalents (`bloom()`, custom vignette node, underwater color node).
4. When the TSL pipeline reaches feature parity and passes the benchmark gates, switch the production renderer to `WebGPURenderer`.
5. Keep `forceWebGL: true` as a fallback for browsers without WebGPU support — the TSL pipeline runs on both backends.

The `WebGLNodesHandler` bridge on `WebGLRenderer` can provide limited node material support during transition, but it does not add `RenderPipeline` support and must be checked feature-by-feature.

---

## License checklist

Before borrowing code from reference implementations, verify license compatibility:

| Source | License | Notes |
|---|---|---|
| LTC reference code ([selfshadow/ltc_code](https://github.com/selfshadow/ltc_code)) | BSD-3-Clause | Compatible with most projects; include attribution |
| Amplify Occlusion ([amplifycreations/amplifyocclusion](https://github.com/amplifycreations/amplifyocclusion)) | MIT | Open source; was commercial, now MIT |
| @takram/three-atmosphere ([npm](https://www.npmjs.com/package/@takram/three-atmosphere)) | Check package LICENSE | Verify before bundling |
| Makio64 advanced rendering ([repo](https://github.com/Makio64/advanced-threejs-tsl-webgpu-rendering)) | Check repo LICENSE | Reference for patterns, not direct copy unless licensed |
| Tidewater water kit ([gettidewater.com](https://gettidewater.com/docs/)) | Commercial source zip | Purchase required; do not copy patterns without license |
| three.js itself | MIT | Core library and addons |

---

## R&D branch structure

### Feature flags in quality.ts

All experimental effects gate behind quality tiers. No effect ships without a tier registration.

### Benchmark harness

Each experiment produces:
1. **Reproducible benchmark** — frame time (min/avg/p99), draw call count, GPU memory, on a fixed test scene
2. **Golden stills** — screenshots at noon, dusk, night, and a stress-test camera angle
3. **WebGPU vs WebGL2 comparison** — run with `forceWebGL: true` and verify visual parity
4. **Gain/cost verdict** — documented in a per-experiment markdown file

### Backend detection

```js
import * as THREE from 'three/webgpu';
const renderer = new THREE.WebGPURenderer({ antialias: false });
await renderer.init();

const isWebGPU = renderer.backend.isWebGPUBackend;
const isWebGL = renderer.backend.isWebGLBackend;
// renderer.isWebGPURenderer is true on BOTH backends — don't use it for detection
```

Use this to gate WebGPU-only features (workgroup memory, indirect draws, subgroup ops) behind runtime checks ([Utsubo: WebGPU migration guide](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)).

---

## Prioritized roadmap

### Phase 0: TSL proof + harness (1-2 weeks)

- **Port shared GLSL noise library (`glsl.ts`) to TSL** — this is the foundation for everything. Every TSL effect depends on it.
- **Port terrain `onBeforeCompile` injection to TSL** — this is the largest migration risk. The terrain system uses `onBeforeCompile` for triplanar blending, photo-scanned surfaces, and chunk-based material injection. `WebGPURenderer` does not support `onBeforeCompile` on either backend. This is likely harder than porting an elemental orb and should be treated as a first-class Phase 0 task.
- Port one elemental orb `ShaderMaterial` to `MeshStandardNodeMaterial` + TSL
- Verify WebGPU + WebGL2 fallback render identically
- Set up benchmark harness (frame time, draw calls, golden stills)
- Set up backend detection (`renderer.backend.isWebGPUBackend`)

**Gate:** TSL noise library produces identical visual output to GLSL version on both backends. Terrain renders identically with TSL node materials.

### Phase 1: Lighting + AA + AO baseline (2-3 weeks)

- ACES tone mapping + PCFShadowMap (PCFSoftShadowMap removed in r186)
- RectAreaLight tavern test with `RectAreaLightTexturesLib.init()` + `RectAreaLightNode.setLTC()`
- TRAA evaluation: ghosting test, per-instance velocity for InstancedMesh
- GTAO evaluation: `GTAONode` with half-res, terrain crevice stills
- If TRAA + GTAO temporal filtering: verify the combined pipeline (GTAO feeds TRAA)

**Gate:** TAA verdict (TRAA vs SMAA), GTAO verdict (<1.5ms, visual quality), rect light verdict (<2ms for 6-10 lights).

### Phase 2: Material library v1 (2-3 weeks)

- Dissolve material with HDR edge glow (TSL)
- Painted rim + SSS mask on hero creature (TSL `emissiveNode`)
- Cel-ramp toon material (`MeshToonMaterial` or `MeshToonNodeMaterial`)
- Inverted hull outlines on characters
- Selection outlines via `outline()` TSL node

**Gate:** Golden stills at noon/dusk/night. Painted-bevel creature vs flat PBR comparison.

### Phase 3: Vegetation + weather at scale (2-3 weeks)

- Instanced grass with two-octave wind (10k instances, single draw call)
- GPU weather particles via TSL compute (50k, basic `instancedArray` — works on both backends)
- Compare GPU weather vs three-nebula CPU path
- Keep three-nebula for small hero effects

**Gate:** 50k GPU particles at <1ms compute + 1 draw call. 10k grass in 1 draw call.

### Phase 4: Sky + water + volumetric polish (2-3 weeks)

- Evaluate `@takram/three-atmosphere` for sky dome upgrade (if current dome looks flat)
- Foam advection along flow direction (two-phase flow-map trick)
- Rain ripple normals
- Radial-blur god rays as TSL post node
- Height fog via `exponentialHeightFogFactor()`

**Gate:** Dawn/dusk silver-lining stills. Water foam streaks visible. God rays masked to bright pixels only.

---

## Papers & references (expanded)

| # | Work | URL | Why |
|---|---|---|---|
| 1 | Heitz et al. 2016, Real-Time Polygonal-Light Shading with LTC | [project](https://eheitzresearch.wordpress.com/415-2/), [code BSD-3](https://github.com/selfshadow/ltc_code) | Analytic area lights — the lighting-quality upgrade |
| 2 | Jimenez et al. 2016, Practical Realtime Strategies for Accurate Indirect Occlusion | [MIT reference impl](https://github.com/amplifycreations/amplifyocclusion) | GTAO — now built into three.js as `GTAONode` |
| 3 | Karis 2014, High Quality Temporal Supersampling | [survey PDF](http://behindthepixels.io/assets/files/TemporalAA.pdf) | TAA — now built into three.js as `TRAANode` |
| 4 | Bruneton & Neyret, Precomputed Atmospheric Scattering | [paper](https://inria.hal.science/inria-00288758/document), [reference impl](https://github.com/ebruneton/precomputed_atmospheric_scattering) | Sky dome upgrade; `@takram/three-atmosphere` is a production three.js implementation |
| 5 | Hillaire 2020, A Scalable and Production Ready Sky and Atmosphere Rendering Technique | [PDF](https://sebh.github.io/publications/egsr2020.pdf) | Multiple-scattering LUT improvement used by `@takram/three-atmosphere` |
| 6 | Overwatch/Blizzard technical breakdown | [80.lv](https://80.lv/articles/overwatch-technical-overview) | Stylized-PBR input discipline: painted bevels, specular-only detail, corner pieces |
| 7 | three.js GTAONode docs | [docs](https://threejs.org/docs/pages/GTAONode.html) | Built-in GTAO with temporal filtering, Quadratic Ray Stepping (r186) |
| 8 | three.js TRAANode docs | [docs](https://threejs.org/docs/pages/TRAANode.html) | Built-in temporal AA with subpixel correction |
| 9 | three.js TSL docs | [docs](https://threejs.org/docs/pages/TSL.html) | Compute API, fog nodes, AA nodes, outline node |
| 10 | three.js WebGPURenderer guide | [guide](https://threejs.org/manual/pages/webgpurenderer) | Backend selection, WebGL2 fallback, migration limitations |
| 11 | Makio64: advanced-threejs-tsl-webgpu-rendering | [repo](https://github.com/Makio64/advanced-threejs-tsl-webgpu-rendering) | Compute patterns: subgroups, workgroup memory, atomics, vec4 throughput |
| 12 | three.js RectAreaLight docs | [docs](https://threejs.org/docs/pages/RectAreaLight.html) | LTC setup for WebGPU (`RectAreaLightTexturesLib`) |
| 13 | Utsubo: WebGPU + Three.js Migration Guide | [guide](https://www.utsubo.com/blog/webgpu-threejs-migration-guide) | Backend detection, compute fallback, migration checklist |
| 14 | Utsubo: What's New in Three.js 2026 | [article](https://www.utsubo.com/blog/threejs-2026-what-changed) | r186 changes: PCFSoftShadowMap removed, deprecated TSL exports |
| 15 | Cinevva: Three.js r183 RenderPipeline | [article](https://app.cinevva.com/news/2026-03-18-threejs-r183-render-pipeline) | PostProcessing renamed to RenderPipeline |
| 16 | three.js grass guide | [guide](https://threejsresources.com/guides/grass) | Instanced grass setup, wind shader, scaling strategy |
| 17 | @takram/three-atmosphere | [npm](https://www.npmjs.com/package/@takram/three-atmosphere) | Production-ready Bruneton atmospheric scattering for three.js |
| 18 | three.js WaterMesh docs | [docs](https://threejs.org/docs/pages/WaterMesh.html) | WebGPU water with TSL UniformNode properties |
| 19 | Tidewater Three.js water kit | [docs](https://gettidewater.com/docs/) | Foam advection, flow-map trick, wake fields |
| 20 | DeepWiki: Three.js Post-Processing Pipeline | [wiki](https://deepwiki.com/mrdoob/three.js/3.6-post-processing-pipeline) | TSL node post-processing architecture, MRT, effect chaining |

---

## Version note

TSL examples target the `three/webgpu` + `three/tsl` API stable since r171. r186 (npm `three@0.186.0`, published September 8, 2026) is the current release. Pin the three.js version for the R&D branch and verify each snippet against the pinned docs — the API is stable but young, and r186 removed several deprecated features (`PCFSoftShadowMap`, `rangeFog`, `viewportResolution`, GTAONode's `distanceExponent`/`distanceFallOff`).
