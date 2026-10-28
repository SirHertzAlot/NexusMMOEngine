# Client Render Pipeline — Software Architecture

Diagrams of the NexusMMOEngine client renderer as it exists
(`NexusMMOEngine @ 522c0c0`, three `^0.186.1`). Every box names the real
file under `apps/client/src/render/` — no orphans, no aspirational boxes
except where explicitly marked `NEW` (an experiment's planned module).

Companion docs: `TECHNIQUES-ILLUSTRATED.md` (findings → files),
`SHADER-EXPERIMENTS.md` (specs E1–E10), `R&D-INDEX.md` (program map).

---

## (a) Pipeline architecture with experiment plug-in points

```mermaid
flowchart TB
subgraph ORCH["Orchestration"]
WC["world-canvas.tsx<br/>R3F Canvas + useFrame loop"]
GOV["quality.ts · detectQuality/stepTier<br/>gpu.ts · detectGpu"]
PERF["perf-stats.ts · PerfSampler<br/>frame ms, draws, VRAM gauges"]
end

subgraph SCENE["Scene passes"]
SKY["sky/day-sky.ts<br/>sky/physical-sky.ts<br/>sky/time-of-day.ts<br/>sky/sky-glsl.ts<br/>"]
TER["terrain/terrain-renderer.ts<br/>terrain/terrain-material.ts<br/>terrain/terrain-mesh.ts<br/>terrain/ground.ts · surfaces.ts"]
WAT["water.ts<br/>water-material.ts<br/>"]
ENT["entity-layer.ts<br/>character/ · instanced-props.ts<br/>synty-props.ts · pcg-meshes.ts<br/>"]
FX["fx/particle-fx.ts · fx/weather.ts<br/>vfx/quarks-fx.ts<br/>element-fx.ts<br/>entity-fx.ts<br/>terrain-fx.ts · prefab/gallery.ts"]
TOON["toon/toon-material.ts<br/>toon/outline.ts<br/>"]
LIGHT["render/lighting/ 🆕<br/>rect-area rig (does not exist yet)<br/>"]
end

subgraph POST["Post chain — post-fx.tsx (EffectComposer)"]
direction LR
MSAA["MSAA<br/>quality.msaa 2/4<br/>"]
N8AO["N8AO<br/>half-res med/high<br/>"]
BLOOM["Bloom<br/>selective, HDR threshold"]
UW["effects/underwater-effect.ts"]
GT["effects/gt-tonemap-effect.ts<br/>Gran Turismo curve"]
VIG["Vignette"]
SHAFT["shafts pass 🆕<br/>"]
MSAA --> N8AO --> BLOOM --> UW --> GT --> VIG
SHAFT -.->|"inserts before bloom"| BLOOM
end

subgraph SHARED["Shared shader libs"]
GLSL["glsl.ts · NOISE_GLSL"]
SKYGLSL["sky/sky-glsl.ts<br/>shared sky function"]
BVH["bvh.ts · lod.ts<br/>culling + LOD"]
end

WC --> SKY & TER & WAT & ENT & FX
ENT --> TOON
LIGHT -.->|"lights"| SCENE
SKY & TER & WAT & ENT & FX & TOON --> POST
SHARED -.->|"chunks/uniforms"| SCENE
GOV -.->|"enables/disables passes"| POST
GOV -.->|"tier flags (outlines, sky, particles)"| SCENE
PERF -.->|"samples every frame"| WC
WC -.->|"screen.underwater"| UW
```

**Experiment plug-in map** (where each spec lands):

| Exp | Plug-in file(s) | What changes |
|-----|----------------|--------------|
| E1 TSL proof | `element-fx.ts`, `showcase.ts`, new `lab/bench.ts` | Fire orb ported to TSL; lab infra built |
| E2a SH ambient | `sky/time-of-day.ts` | 9-coeff SH uniform replaces hemisphere color |
| E2b LTC rig | new `render/lighting/`, lab tavern scene | Rect-area lights vs point lights |
| E3 TAA | `post-fx.tsx` | TAA or SMAA in composer, MSAA replaced/augmented |
| E4 AO | `post-fx.tsx` | GTAO port vs incumbent N8AO |
| E5 materials | `toon/`, `character/`, `entity-fx.ts`, new `render/materials/` | Gooch, SSS, bevels, dissolve, cel ramps |
| E6 wind | `instanced-props.ts` (+ grass site TBD in impl) | Vertex sway via `windWeight` attribute |
| E7 GPU weather | `fx/weather.ts` | TSL compute path, nebula fallback kept |
| E8 shafts/fog | `post-fx.tsx`, scene fog setup | Radial-blur shaft pass + height fog |
| E9 water | `water.ts`, `water-material.ts` | Foam advection, lake spectrum, foam-band fix |
| E10 clouds | `sky/day-sky.ts`, `terrain/terrain-material.ts` | Transmittance texture, chunk-local projection |

---

## (b) Shader system data model

```mermaid
classDiagram
class WorldCanvas {
<<world-canvas.tsx>>
useFrame loop
drives passes
}
class QualityTier {
<<quality.ts>>
low | medium | high | ultra
}
class QualitySettings {
<<quality.ts>>
effects, msaa, bloom
ao, particles, outlines
sky: classic | physical
}
class Material {
<<three.js>>
ShaderMaterial | NodeMaterial
compiles → Program
}
class ShaderChunk {
<<glsl.ts · sky-glsl.ts>>
NOISE_GLSL, sky function
onBeforeCompile / TSL nodes
}
class Uniform {
time, timeOfDay
kcool / kwarm (E5)
shCoeffs[9] (E2a)
dissolveAmount (E5)
}
class Pass {
<<postprocessing>>
Render, N8AO, Bloom
Underwater, GTToneMap, Vignette
TAA/SMAA (E3), GTAO (E4), Shafts (E8)
}
class EffectComposer {
<<post-fx.tsx>>
orders passes
owns buffers
}
class RenderTarget {
composer buffers
water-depth texture (E9)
cloud transmittance (E10)
shadow maps
}
class TimeOfDay {
<<sky/time-of-day.ts>>
derived from server tick
drives sky + fog + ambient
}

WorldCanvas --> QualitySettings: reads preset
WorldCanvas --> EffectComposer: drives each frame
QualityTier --> QualitySettings: selects
QualitySettings --> Pass: enables / disables
QualitySettings --> Material: toggles features
EffectComposer *-- Pass: orders
Pass --> RenderTarget: reads / writes
Material --> ShaderChunk: injects
Material --> Uniform: declares
TimeOfDay --> Uniform: drives
TimeOfDay --> RenderTarget: water/sky need it

note for Material "toon/toon-material.ts\nterrain/terrain-material.ts\nwater-material.ts\ncharacter/character-material.ts\nelement-fx.ts orbs"
note for Pass "MSAA → N8AO → Bloom →\nUnderwater → GT tonemap → Vignette"
note for RenderTarget "perf-stats tracks:\ngeometries, textures, programs"
```

**Relationships in words:**
- A `Material` injects `ShaderChunk`s (shared GLSL libs or TSL nodes)
and declares `Uniform`s; three.js compiles it to a `Program`
(`perf-stats.ts` counts programs — the merge-time GPU-memory signal).
- `EffectComposer` orders `Pass`es; each pass reads/writes
`RenderTarget`s (composer buffers, plus domain targets like the
water-depth texture).
- `QualitySettings` is the cost-control plane: it enables/disables
passes and toggles material features per tier. **Every experiment's
output must register here** — a technique with no tier flag is not
shippable.
- `TimeOfDay` (server-tick-derived, so every client sees the same hour)
drives uniforms and render targets — the single source of truth for
the day cycle.

---

## (c) Runtime flowcharts

### Per-frame render flow (with TAA insertion point)

```mermaid
flowchart TD
F["useFrame — world-canvas.tsx"] --> IN["input + follow-camera.ts"]
IN --> TOD["sky/time-of-day.ts<br/>timeOfDayAt(server tick)"]
TOD --> SKY["sky pass<br/>day-sky / physical-sky"]
SKY --> TER["terrain/terrain-renderer.ts<br/>streamed chunks + far map"]
TER --> WAT["water.ts<br/>sea + lakes"]
WAT --> ENT["entity-layer.ts<br/>characters · instanced-props"]
ENT --> FX["fx/particle-fx.ts · weather<br/>quarks-fx · element/entity-fx"]
FX --> COMP["EffectComposer — post-fx.tsx"]
COMP --> RP["RenderPass: scene → buffer"]
RP --> AA{"E3 verdict"}
AA -->|"TAA"| TAA["TAA pass<br/>Halton jitter + reprojection"]
AA -->|"SMAA"| SMAA["SMAAEffect"]
AA -->|"keep"| MSAA["composer MSAA"]
TAA & SMAA & MSAA --> N8AO["N8AO (tier-gated)"]
N8AO --> SHF["E8 shaft pass 🆕<br/>masked, before bloom"]
SHF --> BLOOM["selective Bloom"]
BLOOM --> UW["UnderwaterEffect<br/>screen.underwater"]
UW --> GT["GTToneMapEffect"]
GT --> VIG["Vignette → screen"]
VIG --> PERF["perf-stats.ts samples<br/>frame ms, draws, VRAM"]
PERF --> GOV{"governor<br/>quality.ts"}
GOV -->|"fps low"| DEG["lower resolution → stepTier down"]
GOV -->|"headroom"| REC["stepTier up<br/>never above player pin"]
```

### SH ambient update (driven by time-of-day) — E2a

```mermaid
flowchart LR
TICK["server tick<br/>mirror client"] --> TOT["timeOfDayAt()<br/>sky/time-of-day.ts"]
TOT --> SAMP["sample sky function<br/>sky/sky-glsl.ts<br/>at fixed tap directions"]
SAMP --> SH["dot with SH basis<br/>→ 9 coefficients"]
SH --> U["shCoeffs[9] uniform"]
U --> MAT["all PBR materials<br/>ambient term"]
TOT --> SKY2["sky dome + sun/moon<br/>fog color"]
```

One update per frame (or per time-of-day change): the ambient follows
dawn/dusk/night for free because the sky function already animates.

### Water spectrum selection (ocean vs lake) — E9

```mermaid
flowchart TD
WT["water-depth texture texel<br/>water-material.ts<br/>16m cells"] --> CH{"water-type channel"}
CH -->|"ocean"| OC["Gerstner swell trains<br/>λ up to ~60m"]
CH -->|"lake"| LK["chop + capillary ripple<br/>λ 1–15m, cheaper"]
OC --> FOAM{"foam band factor"}
LK --> FOAM
FOAM -->|"foam rising"| DOWN["wave energy cross-fades DOWN<br/>⚠️ never add — wall-of-water bug"]
FOAM -->|"open water"| FULL["full spectrum energy"]
DOWN & FULL --> SHADE["shade: sky reflection<br/>GGX glint · Beer-Lambert"]
```

### Quality-tier selection and fallback

```mermaid
flowchart TD
DET["gpu.ts · detectGpu()"] --> SW{"software rasterizer?"}
SW -->|yes| LOW["tier = low<br/>no screen effects"]
SW -->|no| CLS["quality.ts · detectQuality()<br/>benchmark score → tier"]
CLS --> PRE["QUALITY_PRESETS[tier]<br/>dpr, effects, msaa, ao,<br/>particles, outlines, sky"]
PRE --> LOOP["frame loop<br/>PerformanceMonitor"]
LOOP --> OK{"fps healthy?"}
OK -->|no| RES["lower resolution first"]
RES --> OK2{"still bad?"}
OK2 -->|yes| STEP["stepTier(down)<br/>fewer effects"]
OK2 -->|no| LOOP
OK -->|yes| HEAD{"headroom?"}
HEAD -->|yes| UP["stepTier(up)<br/>≤ player pin"]
HEAD -->|no| LOOP
STEP --> LOOP
UP --> LOOP
PIN["player pins preset<br/>(HUD)"] -.->|"caps"| UP
PIN -.->|"keeps effects,<br/>only res moves"| RES
```

Every experiment's merge registers its on/off state per tier in
`QUALITY_PRESETS` — that table is the fallback mechanism, not an
afterthought.

---

## File index (all 42, by subsystem)

| Subsystem | Files |
|-----------|-------|
| Orchestration | `world-canvas.tsx`, `follow-camera.ts`, `input/` (sibling) |
| Quality/governor | `quality.ts`, `gpu.ts`, `perf-stats.ts` |
| Post chain | `post-fx.tsx`, `effects/gt-tonemap-effect.ts`, `effects/underwater-effect.ts` |
| Sky | `sky/day-sky.ts`, `sky/physical-sky.ts`, `sky/sky-glsl.ts`, `sky/star-field.ts`, `sky/time-of-day.ts` |
| Terrain | `terrain/terrain-renderer.ts`, `terrain/terrain-mesh.ts`, `terrain/terrain-material.ts`, `terrain/ground.ts`, `terrain/surfaces.ts`, `terrain-fx.ts` |
| Water | `water.ts`, `water-material.ts` |
| Entities | `entity-layer.ts`, `entity-fx.ts`, `character/character-animator.ts`, `character/character-kit.ts`, `character/character-material.ts`, `character/character-stage.ts`, `instanced-props.ts`, `synty-props.ts`, `pcg-meshes.ts` |
| FX | `fx/particle-fx.ts`, `fx/weather.ts`, `vfx/quarks-fx.ts`, `element-fx.ts` |
| Toon | `toon/toon-material.ts`, `toon/outline.ts` |
| Shared libs | `glsl.ts`, `bvh.ts`, `lod.ts`, `assets.ts` |
| Lab/showcase | `showcase.ts`, `prefab/gallery.ts`, `prefab/prefab-builder.ts` |
| R&D-planned 🆕 | `render/lighting/` (E2b), `render/materials/` (E5), `render/lab/bench.ts` (§0) |
