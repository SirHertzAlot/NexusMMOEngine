# C++ AAA Graphics Libraries — Research

**Date:** 2026-10-14
**Status:** Research only. No engine code written, no PRs opened, no repo modified.
**Scope:** Open-source C++ libraries for AAA graphics, lighting, shaders, and materials for the Nexus MMO engine.

## The fit lens (read this first)

The engine's client renders via three.js/WebGL (GLSL), not a native C++ renderer. So C++ graphics libraries fit in three places, in descending order of near-term value:

1. **Bake-time tooling** — lightmap/GI baking, IBL baking, material→shader generation, texture compression, asset processing. This is where C++ libraries pay off *now*.
2. **Server-side procedural generation** — textures, materials, destruction decisions, sky LUTs computed on the sim.
3. **Future native renderer** — a later, larger decision. Libraries that only work as native runtime renderers are down-ranked until that decision is made.

A library that cannot produce GLSL (for the WebGL client) or bake-time assets is a harder fit than one that can.

## Hard gates (applied to every candidate)

- **License:** MIT, Apache-2.0, BSD only. No GPL/AGPL/LGPL, no proprietary/hosted-only, no MPL.
- **Windows:** Must build on Windows (target: VS Build Tools 2026). Windows support marked unverified where it was not confirmed.
- **Already adopted — not re-proposed:** three-mesh-bvh, meshoptimizer, gltfpack, gltf-transform, three.quarks, Draco, Jolt, Recast/Detour, FastNoise2, EZ-Tree, three-pinata (client destruction renderer — see Blast entry for how it relates).

## Executive summary

**The good news:** the permissive C++ ecosystem is *deep* for bake-time work. A complete CPU lightmap baker, a shader compilation chain, a material standard with GLSL generation, and a full texture/asset pipeline can all be assembled from permissive libraries today.

**The honest gap:** there is almost nothing good as a *standalone* library for runtime AAA techniques — volumetric clouds, grass/foliage at scale, FFT ocean, clustered lighting, screen-space GI, post-processing as a C++ framework. Those techniques live inside full engines (Wicked, Filament, Unreal), as shader collections (FidelityFX), or as one-off demos. For those categories the correct move is usually **port the technique / implement in-house in GLSL**, not adopt a C++ dependency.

**The trap:** several high-profile candidates carry license traps that fail a strict reading of the gates (FidelityFX SDK 2.x, glslang's license file, Slang's Apache+LLVM, DXC's NCSA, ImageMagick, MikkTSpace's zlib, Hosek-Wilkie). See "License traps" below before vendoring anything.

## Top 5 strongest candidates

### 1. Embree + OIDN + xatlas — the bake-time GI trio (ADOPT)
- **Embree** (Intel, Apache-2.0, ~2,745 stars, active): CPU ray-tracing kernels — the ray-casting core for a custom lightmap/probe baker.
- **OIDN** (Intel, Apache-2.0, ~2.1k stars, active): ML denoiser with an `RTLightmap` filter mode — denoise low-sample baked lightmaps. ~50–80 MB runtime, CPU device is fine for a bake tool.
- **xatlas** (MIT, stable/maintenance-mode): 2-file C++11 lib generating unique lightmap UVs (charting + parameterization + packing). The missing piece before any lightmap bake.
- **Fit:** Bake-time. These three compose a complete CPU lightmap/probe baker: xatlas (UVs) → Embree (rays) → OIDN (denoise).
- **Repos:** https://github.com/renderkit/embree · https://github.com/OpenImageDenoise/oidn · https://github.com/jpcy/xatlas

### 2. SPIRV-Cross + SPIRV-Tools (+ glslang) — the shader bake chain (ADOPT / ADOPT / EVALUATE)
- **SPIRV-Cross** (Khronos, Apache-2.0 OR MIT, ~2,516 stars): transpiles SPIR-V back to readable GLSL/ESSL/HLSL/MSL. The keystone for GLSL-out — it converts any compiled shader back to WebGL-usable GLSL.
- **SPIRV-Tools** (Khronos, Apache-2.0): SPIR-V assembler/validator/optimizer. Adds validation + optimization between glslang and SPIRV-Cross.
- **glslang** (Khronos, BSD-family with a license-file caveat — see License traps): the GLSL/ESSL front end producing SPIR-V. Adopt pending a one-time license-file read.
- **Fit:** Bake-time. Chain: GLSL in → glslang → SPIRV-Tools → SPIRV-Cross → GLSL/ESSL out for three.js.
- **Repos:** https://github.com/KhronosGroup/SPIRV-Cross · https://github.com/KhronosGroup/SPIRV-Tools · https://github.com/KhronosGroup/glslang

### 3. MaterialX + OpenPBR — the material standard (ADOPT, with a spike)
- **MaterialX** (ASWF/ILM, Apache-2.0, ~2,277 stars, very active): open standard + C++ library for material graphs, node libraries (stdlib, pbrlib), shader generation (incl. GLSL + ESSL 300 target), texture baking, `.mtlx` interchange format. The only serious C++ node-graph → GLSL system found. A 2026 addition is a dedicated Slang generator.
- **OpenPBR Surface** (ASWF, Apache-2.0, spec stable at 1.0): the unified PBR shading model, implemented as MaterialX. Adopt as *the* PBR model so authored materials map 1:1 to three.js MeshStandard/Physical parameters.
- **Fit:** Bake-time. Author materials as graphs, generate GLSL for three.js, bake textures via TextureBaker. Adopt core + GenGlsl + TextureBaker subset; skip viewer/graph-editor to keep weight down.
- **Caveat:** film-oriented PBR model — spike the MaterialX → ESSL → three.js mapping before committing to the full integration.
- **Repos:** https://github.com/AcademySoftwareFoundation/MaterialX · https://github.com/AcademySoftwareFoundation/OpenPBR

### 4. The texture/asset bake stack (ADOPT as a set)
- **KTX-Software** (Khronos, Apache-2.0): KTX2 container read/write + `toktx` tools. Bake-side complement to the client's existing KTX2 decoding — this is the *encoder* side that writes the KTX2 files the client reads. Not a duplicate.
- **Basis Universal** (Apache-2.0): UASTC + ETC1S supercompressed texture codec — the compression engine behind the KTX2 bake step.
- **OpenImageIO** (ASWF, Apache-2.0, ~2,381 stars): format-agnostic image/texture IO + processing (`oiiotool`, `maketx`). The workhorse for texture conversion, resize, color-space, mip generation. Pull via vcpkg, use the library subset.
- **DirectXTex** (Microsoft, MIT, ~2,154 stars): texture processing + `texconv` CLI — BC1–BC7/BC6H compression, DDS IO, mip generation, HDR, normal-map handling. Windows-first (VS 2026 solution files). Fills bc7enc_rdo's BC6H gap.
- **bc7enc_rdo** (MIT): fast BC1–7 encoders with rate-distortion optimization. Vendor the 3-file core only.
- **cgltf** (MIT, ~1,693 stars): single-header C99 glTF 2.0 parser. Ideal glTF parse layer for the C++ bake tool — hand buffers to meshoptimizer/Draco for decompression, materials to MaterialX mapping.
- **stb** (dual Public Domain / MIT, ~34,784 stars): single-header image load/save/resize + DXT. Zero-dependency, ideal for small bake tools and test harnesses.
- **Fit:** All bake-time.

### 5. Blast — destruction authoring + break decisions (EVALUATE)
- **What:** Physics- and graphics-agnostic C++ fracture library: Voronoi/slicing pre-fracture, bond/support graph with damage propagation, runtime island splitting, stress solver, convex decomposition for debris. No rendering, no physics solving.
- **License:** BSD-3-Clause for the current PhysX-repo distribution — **verify the LICENSE in `blast/` at the exact pinned commit** (an older distribution used an NVIDIA Source Code License; see License traps).
- **Maturity:** Blast 5.0.6 shipped with PhysX 5.6.0; PhysX repo ~4,444 stars, actively maintained.
- **Windows:** Yes — Windows is a primary PhysX/Blast platform.
- **Fit:** Bake-time + server-side. Pre-fracture assets at bake time; run the damage/support graph server-side (C++ sim) and feed debris to Jolt. **Additive, not overlapping, with three-pinata:** three-pinata is the client-side destruction *renderer*; Blast is the *authoring + break-decision* layer.
- **Before adopting:** scope the Blast→Jolt bridge (Blast ships a PhysX extension, not a Jolt one).
- **Repo:** https://github.com/NVIDIA-Omniverse/PhysX (`blast/` subdir)
- **Companions (EVALUATE):** convex decomposition for Blast debris colliders — **CoACD** (MIT, SIGGRAPH 2022, collision-aware) vs **V-HACD maintained fork** (BSD-3, header-only C++17). Compare quality/build cost before choosing one.

## Recommended bake-time stack (composed pipeline)

1. **Geometry for baking:** xatlas (UVs) + MikkTSpace (tangents — pending zlib waiver, see below).
2. **Lighting:** Embree (rays) + OIDN (denoise) + OpenPGL (path guiding — second-phase baker upgrade) for lightmaps/probes; Filament `cmgen` or glTF-IBL-Sampler for IBL assets.
3. **Materials:** MaterialX (authoring + GLSL gen + bake) + OpenPBR Surface (model) + cgltf (glTF parse).
4. **Textures:** OpenImageIO (processing) + stb (lightweight IO) + KTX-Software/Basis (KTX2 encode) + bc7enc_rdo (BC7) + DirectXTex (DDS/BC6H/Windows) + astc-encoder only if native ASTC needed.
5. **Shaders:** glslang → SPIRV-Tools → SPIRV-Cross (GLSL/ESSL out); Slang as the single-source-language candidate (spike first).
6. **Import:** Assimp gated to non-glTF formats only (FBX/OBJ/etc. → glTF); do not use for glTF.
7. **Destruction:** Blast (pre-fracture) + CoACD/V-HACD fork (decomposition) + Jolt bridge.

## License traps — read before vendoring anything

These are the findings that most change adoption decisions:

- **FidelityFX SDK 2.x is binary-only.** SDK v1.1.4 is fully MIT. SDK v2.x's default license is binary-only (no reverse engineering); only files listed in its `docs/license.md` are MIT. **Never pull `main`/v2.x blindly — pin v1.1.4 or the standalone GPUOpen-Effects repos.** FSR 4 (ML) is DX12-only + binary — not usable here. Also note: MIT has no patent grant; AMD docs disclaim implied IP licenses and FSR 3 has pending AMD patent applications. Low practical risk, but noted.
- **glslang license file needs a read.** Main code is BSD-family per Khronos docs, but GitHub detects NOASSERTION and `LICENSE.txt` is multi-license mentioning GPL-3.0-with-Bison-exception (Bison reportedly removed from the build long ago). One-time license-file read before adoption.
- **Slang is Apache-2.0 with LLVM Exception, not MIT.** Still permissive, but the gate as written says "Apache-2.0" — the LLVM Exception variant needs a gate-clarification call. Its GLSL output is desktop `#version 450`, not WebGL-ready ESSL — needs adaptation or a SPIRV-Cross pass.
- **DXC is UIUC/NCSA (LLVM license).** BSD-style permissive, but not literally MIT/Apache-2.0/BSD as the gate is written. PARK pending gate clarification. Trap: the Windows SDK's `dxcompiler.dll` is built *without* the SPIR-V backend; the DXIL-signing `dxil.dll` is under a proprietary Microsoft EULA and must not be vendored.
- **ImageMagick fails the strict gate.** Its license is an Apache-2.0-*derived* ImageMagick License, not Apache-2.0 itself, and full builds bundle LGPL delegates (libheif, libde265, cairo). REJECT — OIIO covers the same bake-time needs under clean Apache-2.0.
- **MikkTSpace is zlib.** Technically excellent (industry-standard tangent basis, mandatory companion to xatlas for correct normal-map baking), but zlib is not in the MIT/Apache-2.0/BSD allowlist. Needs a one-line waiver; if granted, adopt immediately.
- **Hosek-Wilkie sky has a license conflict.** Some vendored copies label it CC-BY 3.0, others BSD-3-Clause. CC-BY is not on the allowlist. Do not vendor until resolved from the original source. Clean fallback: **Prague Sky Model** (Apache-2.0).
- **Blast license conflict at the pin.** Current PhysX-repo Blast is BSD-3-Clause, but an older standalone/GameWorks distribution used an NVIDIA Source Code License. Read the LICENSE at the exact pinned commit.
- **OpenVDB is Apache-2.0 now (good news).** v12+ completed a re-license from MPL-2.0 to Apache-2.0. Pin v12+ and verify `LICENSE`/`RE-LICENSE_NOTE.txt` at that pin. Only pre-v12 revisions are MPL.

## Category 1 — Lighting

### ADOPT
- **Intel Embree** — Apache-2.0, ~2,745 stars, active (last commit 2026-09-21). CPU ray-tracing kernels. Bake-time: ray-casting core for a custom lightmap/probe baker. Windows: yes. https://github.com/renderkit/embree
- **Intel OIDN** — Apache-2.0, ~2.1k stars, v2.5.x line. ML denoiser, `RTLightmap` filter mode. Bake-time: denoise low-sample baked lightmaps/probes. Windows: yes (prebuilt x64 releases). https://github.com/OpenImageDenoise/oidn
- **xatlas** — MIT, stable/maintenance-mode. 2-file UV unwrapper for lightmap UVs. Bake-time. Windows: yes. https://github.com/jpcy/xatlas

### EVALUATE
- **Intel OpenPGL** — Apache-2.0. Path-guiding library (learns incident-radiance distributions to guide sampling). Bake-time: plugs into an Embree baker to cut samples-per-texel on indirect-heavy scenes. Second-phase baker upgrade. Windows: yes (verify vs VS 2026). https://github.com/RenderKit/openpgl
- **Filament `cmgen` / `libs/ibl`** — Apache-2.0 (confirm LICENSE before vendoring), ~20,590 stars, very active. `cmgen` bakes IBL (prefiltered env, SH irradiance). Bake-time: almost exactly the engine's IBL-baking need. Do NOT adopt the Filament runtime (would duplicate three.js). https://github.com/google/filament
- **Khronos glTF-IBL-Sampler** — MIT OR Apache-2.0 (confirm repo LICENSE files). GPU-accelerated (Vulkan) IBL sampler producing KTX2 environment maps + BRDF LUTs per the glTF IBL spec. Bake-time: outputs KTX2 IBL assets directly compatible with a glTF pipeline. Compare against `cmgen`. Needs Vulkan GPU at bake time. https://github.com/KhronosGroup/glTF-IBL-Sampler
- **Microsoft UVAtlas** — MIT, ~856 stars, maintenance-mode (critical fixes only). Isochart texture-atlas library. Bake-time: direct xatlas alternative; signal-specialized parameterization can beat xatlas quality on some meshes. Benchmark against xatlas only if lightmap-UV quality becomes a bottleneck. https://github.com/microsoft/UVAtlas
- **FidelityFX CACAO (v1.1.4)** — MIT (pin v1.1.4 or pre-2.0 repo only). Combined adaptive compute AO; ships HLSL + GLSL. Fit: port the GLSL to WebGL as the engine's runtime AO — a GPU runtime effect, not a bake-time tool. https://github.com/GPUOpen-Effects/FidelityFX-CACAO
- **Intel XeGTAO** — MIT, archived upstream (v1.30 reference snapshot). Ground-Truth AO + bent normals + denoiser. Fit: best AO algorithm candidate to port to WebGL GLSL; not a C++ dependency to take. HLSL needs a GLSL port. https://github.com/GameTechDev/XeGTAO
- **FidelityFX Denoiser (v1.1.4)** — MIT (pin 1.1.4). Spatio-temporal denoisers for shadows/reflections; HLSL + GLSL compute. Fit: real-time denoiser for any future native ray-traced effects; OIDN covers bake-time. https://github.com/GPUOpen-Effects/FidelityFX-Denoiser

### PARK
- **NVIDIA Falcor** — BSD-3-Clause core (~2,603 stars, last push 2024-08-19, stalled; successor Falcor2 is Apache-2.0, early). Full research framework (render graph, path tracing, DDGI). Read its DDGI/render-graph code as reference; do not adopt as a dependency. Bundled NVIDIA SDKs (DLSS, RTXDI, NRD) carry separate licenses — audit before reusing any pass. https://github.com/NVIDIAGameWorks/Falcor
- **pbrt-v4** — Apache-2.0, ~3,694 stars, slow maintenance. Full physically-based renderer. Canonical algorithm reference (sampling, BSDFs, lights); monolithic app, not a bake library. https://github.com/mmp/pbrt-v4
- **Mitsuba 3** — BSD-3-Clause, ~2,941 stars, research-paced. Differentiable renderer. Reference for differentiable/integrator ideas; Python-centric workflow fits C++ bake tooling poorly. https://github.com/mitsuba-renderer/mitsuba3
- **LuxCore** — Apache-2.0, ~1,335 stars. Full renderer with a real C++/Python API — the most embeddable of the full renderers. Revisit only if a full offline renderer is wanted instead of an Embree-based baker. https://github.com/LuxCoreRender/LuxCore
- **Blender Cycles (standalone)** — Apache-2.0 (Cycles is Apache even though Blender is GPL). Production path tracer with a C++ API. PARK: extracting it from the Blender monorepo is substantial work (deps: OSL, OIIO, OIDN, Embree). Only worth it for a full production baker. Inside https://github.com/blender/blender (`internals/cycles/`)
- **Appleseed** — MIT, ~2,296 stars, near-dormant; Windows build now a risk (dev switched to Ubuntu-focused setup). Weakest of the full renderers. https://github.com/appleseedhq/appleseed
- **Intel OSPRay** — Apache-2.0. Scalable CPU/GPU ray-tracing engine (Embree + OpenVKL + OIDN). Visualization-oriented, heavier than Embree+OIDN directly; redundant if those are adopted. https://github.com/renderkit/ospray
- **cmft / cmftStudio** — BSD-2-Clause, dormant. Cubemap filtering (irradiance + GGX prefilter). `cmgen`/glTF-IBL-Sampler supersede it. https://github.com/dariomanesku/cmft
- **IBLBaker** — MIT, dormant ~10+ years, VS2015-era build. Good didactic reference for split-sum IBL; `cmgen` is the usable tool. https://github.com/derkreature/IBLBaker
- **Intel ASSAO** — MIT, superseded by CACAO. Use CACAO/XeGTAO instead.

### REJECT
- **NVIDIA RTXGI / RTXGI-DDGI** — NVIDIA RTX SDKs license (non-transferable, no sublicensing, source not redistributable). Fails the permissive gate. DDGI is the right algorithm, wrong license — treat as paper/technique reference; reimplement the probe-grid idea in-house or follow Wicked Engine's MIT DDGI.
- **NVIDIA NRD (Ray Tracing Denoiser)** — NVIDIA RTX SDKs license. Fails the gate. Use OIDN (bake-time) + FidelityFX Denoiser 1.1.4 (real-time, MIT).
- **DreamWorks MoonRay** — Apache-2.0, ~4,725 stars, but **no Windows build** (Linux/macOS/container only). Fails the Windows gate. Revisit only if a Linux-only bake farm is ever acceptable.
- **thekla_atlas** — MIT, dormant, superseded by xatlas (120 files vs 2). Use xatlas.

### No standalone library found
- **Clustered lighting:** no standalone permissive C++ library exists — a ~200-line GPU pattern (light binning compute shader + per-cluster lists), implemented per-engine. Implement in-house against the three.js renderer.
- **Screen-space GI:** no standalone permissive C++ library exists — implementations are embedded in engines. In-house GLSL post-pass later, or OIDN-denoised low-sample SSGI.
- **Irradiance volumes / probe grids:** no standalone library — reusable artifacts are DDGI (license-blocked at NVIDIA, MIT in Wicked Engine) and probe-baking approaches in Wicked/Falcor. Design the engine's own probe format (SH or ambient-cube per probe) baked by the Embree baker.

## Category 2 — Shaders

### ADOPT
- **SPIRV-Cross** — Apache-2.0 OR MIT, ~2,516 stars. SPIR-V → readable GLSL/ESSL/HLSL/MSL + reflection API. The keystone for GLSL-out in the bake chain. Windows: yes. https://github.com/KhronosGroup/SPIRV-Cross
- **SPIRV-Tools** — Apache-2.0. SPIR-V assembler/disassembler, validator, optimizer, linker. Bake-time companion: validation + optimization between glslang and SPIRV-Cross. Windows: yes (Vulkan SDK). https://github.com/KhronosGroup/SPIRV-Tools

### EVALUATE
- **glslang** — BSD-family with license-file caveat (see License traps), ~3,590 stars, very active (last commit 2026-10-09). Khronos reference GLSL/ESSL front end + SPIR-V generator; also `glslangValidator`. Bake-time: front half of the bake chain; pair with SPIRV-Cross for GLSL-out. Windows: yes. https://github.com/KhronosGroup/glslang
- **Slang** — Apache-2.0 with LLVM Exception (see License traps), ~5,723 stars, actively maintained, now under Khronos Slang Initiative. HLSL-superset shading language + compiler: one source → SPIR-V, HLSL, GLSL, WGSL, MSL, CUDA, CPU C++. Generics, autodiff, modules. Bake-time: best single-source-language candidate, but spike first — Slang → GLSL → three.js ShaderMaterial round-trip + build cost (heavy: LLVM/DXC deps). GLSL output is desktop `#version 450`, not WebGL-ready ESSL. https://github.com/shader-slang/slang
- **shaderc** — Apache-2.0, ~2,190 stars, active. C/C++ API + `glslc` CLI wrapping glslang (GLSL/HLSL→SPIR-V). A convenience wrapper over glslang, not a new capability. Adopt only if the `glslc` CLI / libshaderc API convenience is wanted; otherwise glslang direct covers it. https://github.com/google/shaderc
- **sokol-shdc** — license **unverified** (sokol family is generally zlib/libpng — verify before use). Shader cross-compiler: annotated Vulkan-style GLSL 450 in; GLSL 300es/310es/410/430, HLSL, Metal, WGSL out, via glslang + SPIRV-Tools + SPIRV-Cross + Tint; emits C headers or raw GLSL + YAML reflection. Wrapper over tools already in this report, not a new capability. Consider only if its annotation + reflection codegen is wanted over raw glslang+SPIRV-Cross. https://github.com/floooh/sokol-tools

### PARK
- **Filament filamat / matc** — Apache-2.0, ~20,590 stars. Material compiler for the Filament PBR engine. PARK: deliverable is a `.filamat` blob for the Filament runtime, not standalone GLSL for three.js. Revisit only if Filament becomes the native renderer. (Filament's `glslminifier` tool is a minor standalone utility.)
- **Dawn / Tint** — BSD-3-Clause. Tint compiles WGSL/SPIR-V → GLSL/HLSL/MSL/SPIR-V/WGSL. PARK: only pays off if WGSL becomes an authoring language; for a GLSL-authored pipeline it adds a large GN/depot_tools dependency for no new capability. (Godot-style extraction of just Tint is a known pattern if ever needed.)
- **bgfx shaderc** — BSD-2-Clause, bgfx ~17,549 stars. Compiles bgfx's GLSL-flavoured dialect into per-backend blobs in bgfx's binary container. PARK: output is bgfx-flavoured (macros, `$input/$output`), meant for the bgfx runtime, not three.js. Only relevant if bgfx becomes the native renderer.
- **DXC (DirectX Shader Compiler)** — UIUC/NCSA license (see License traps). LLVM/Clang-based HLSL compiler emitting DXIL and SPIR-V. PARK pending gate clarification on NCSA; only useful if HLSL becomes an authoring language.
- **ShaderConductor** — MIT. Glue library: HLSL → DXC → SPIR-V → SPIRV-Cross → GLSL/ESSL/MSL. PARK: redundant with direct DXC + SPIRV-Cross unless HLSL authoring is chosen and one DLL is wanted.
- **glsl-optimizer** — MIT, ~1,733–2,000 stars, **unmaintained** (author stopped ~2016; VS2010 project files). GLSL-in → optimized GLSL-out. PARK: modern drivers + SPIRV-Tools cover the optimization need; would need a modernization effort.
- **naga** — MIT OR Apache-2.0, wgpu monorepo ~18,255 stars. WGSL/GLSL/SPIR-V → SPIR-V/WGSL/GLSL/HLSL/MSL. PARK for C++ integration: it is **Rust**, not C++ — not linkable into the C++ backend without immature `naga-c` bindings or a subprocess/CLI boundary. Tint covers the same WGSL→GLSL need in C++.
- **noodles** — MIT, ~42 stars, early-stage/experimental (created 2026-04-28). Standalone C++17 library for *rendering interactive node graphs* with OpenGL. PARK: it draws node graphs; it does **not** generate shader code. Could back a future material-graph editor canvas, not shader generation.
- **shader-minifier** — license unverified. Minifies/obfuscates GLSL/HLSL. PARK: it is a **C#/.NET tool, not C++**; renaming breaks uniform reflection unless `--preserve-externals` is used; marginal value over SPIRV-Tools + a whitespace pass.

### No library found
- **Shader hot reload:** no standalone, permissive, maintained C++ *shader* hot-reload library exists. What exists are engine-internal patterns (poll mtimes / `ReadDirectoryChangesW` / inotify → recompile → swap last-good shader on failure) and framework-specific addons. Implement in-engine as: file watcher → re-run the chosen bake compiler (glslang/SPIRV-Cross or Slang) → swap on success, keep last-good on failure.
- **GLSL shader-function libraries:** no maintained standalone C++ GLSL collection exists. The closest real artifacts are MaterialX's standard + PBR libraries (which include GLSL implementations under `libraries/*/genglsl/`) and Filament's internal shader chunks (not reusable standalone). If a shared GLSL snippet library is wanted, MaterialX's libraries are the only credible source.

## Category 3 — Materials

### ADOPT
- **MaterialX** — Apache-2.0, ~2,277 stars, very active. See Top 3. Adopt core + GenGlsl + TextureBaker subset. https://github.com/AcademySoftwareFoundation/MaterialX
- **OpenPBR Surface** — Apache-2.0, spec stable at 1.0. The PBR material model, implemented via MaterialX (not a separate dependency). https://github.com/AcademySoftwareFoundation/OpenPBR
- **OpenImageIO** — Apache-2.0, ~2,381 stars, active. Format-agnostic image/texture IO + processing + `oiiotool` + `maketx`. Bake-time texture processing workhorse. Windows: yes (CI tests VS2026, vcpkg port). https://github.com/AcademySoftwareFoundation/OpenImageIO
- **KTX-Software** — Apache-2.0, ~1,381 stars, active. Official KTX/KTX2 container library + tools. Bake-side complement (encoder), not a duplicate of the client's KTX2 decoding. Windows: yes. https://github.com/KhronosGroup/KTX-Software
- **Basis Universal** — Apache-2.0. UASTC + ETC1S supercompressed codec. Bake-time: compression engine behind the KTX2 bake step (usually consumed via KTX-Software's integration, or directly). Windows: yes. https://github.com/BinomialLLC/basis_universal
- **bc7enc_rdo** — MIT. Fast BC1–7 encoders with rate-distortion optimization (10–50% smaller via LZ-compressibility). Bake-time: best BCn quality-per-bit for desktop (BC7) targets. No BC6H encoder — use DirectXTex/Compressonator for BC6H. Vendor the 3-file core only. https://github.com/richgel999/bc7enc_rdo
- **DirectXTex** — MIT, ~2,154 stars, active (VS 2026 solution files). Texture processing + `texconv` CLI: DDS/WIC IO, mip generation, BC1–BC7/BC6H, HDR, normal-map handling. Bake-time: best Windows-native texture pipeline. Use `texconv` CLI first, library second. Windows: yes (Windows-first). https://github.com/microsoft/DirectXTex
- **stb** — dual Public Domain / MIT, ~34,784 stars. Single-header image libs (stb_image, stb_image_write, stb_image_resize2, stb_dxt, stb_perlin, stb_rect_pack). Bake-time: zero-dependency image IO for small bake tools and test harnesses. Not a replacement for OIIO at scale. https://github.com/nothings/stb
- **cgltf** — MIT, ~1,693 stars, stable. Single-header C99 glTF 2.0 parser (parse-only; caller handles Draco/meshopt decompression). Bake-time glTF parse layer. Windows: yes. https://github.com/jkuhlmann/cgltf

### EVALUATE
- **Assimp** — BSD-3-Clause, ~13,258 stars, very active (much activity is security hardening on untrusted files). 40–57 format importer + post-processing. Bake-time: **additive, not redundant, only for non-glTF formats** (FBX/OBJ/COLLADA/Blend). For glTF, gltfpack/gltf-transform + cgltf already cover the pipeline. Cost: large build, large attack surface — never feed untrusted files without sandboxing. https://github.com/assimp/assimp
- **fastgltf** — MIT (provisionally verified), ~608 stars, very active. Fast C++17 glTF parser + exporter (SimdJSON-backed). Pick over cgltf only if C++ API + glTF writing in-process is needed; otherwise cgltf's single header is simpler. https://github.com/spnda/fastgltf
- **tinygltf** — MIT, ~2,537 stars, active. Header-only glTF loader/saver (v3 line is now C). Viable, but heavier/slower than cgltf per community comparisons. Pick only if its saver/JSON handling is specifically needed. https://github.com/syoyo/tinygltf
- **OpenEXR** — BSD-3-Clause, ~1,867 stars, very active. HDR image format library. Bake-time (niche): HDR intermediates / light-probe / environment-map storage. OIIO already reads/writes EXR, so adopt directly only if HDR intermediates or EXR-native tooling are needed. https://github.com/AcademySoftwareFoundation/OpenEXR
- **astc-encoder (astcenc)** — Apache-2.0. Reference ASTC encoder/decoder; exhaustive-to-fast presets, HDR. Bake-time: highest-quality ASTC encoding for mobile/WebGL2 ASTC targets. Adopt only if shipping native ASTC targets where Basis transcoding quality is insufficient. Windows: likely yes (unverified). https://github.com/ARM-software/astc-encoder
- **AMD Compressonator** — MIT, ~1,456 stars. Texture + model compression suite: BC1–BC7, BC6H, ASTC, ETC1/2, mipmaps, CLI + GUI + SDK. Bake-time: broadest single compression suite. Value is breadth vs best-of-breed per format (bc7enc_rdo for BC7, Basis for KTX2). Weigh against open quality bugs on BC1/BC7 flags. https://github.com/GPUOpen-Tools/Compressonator

### PARK
- **Open Shading Language (OSL)** — BSD-3-Clause, ~2,342 stars, active. C-like shading language + LLVM-based runtime for production GI renderers. PARK: heavy LLVM dependency for a narrow use; MaterialX already generates OSL. Revisit only if OSL-authored procedural materials are required. Windows: yes (CI tests VS2026). https://github.com/AcademySoftwareFoundation/OpenShadingLanguage
- **OpenCV** — Apache-2.0, ~90,976 stars, 5.0 released June 2026. Computer-vision + image-processing library. PARK: ~200 MB dependency for jobs OIIO + stb + DirectXTex cover with far less weight. Revisit only for a real CV need (e.g., image-based asset analysis). https://github.com/opencv/opencv
- **bc7enc (original)** — dual MIT / Public Domain. Superseded by bc7enc_rdo (RDO, more modes, vectorized paths). Use bc7enc_rdo.
- **ispc_texcomp** — MIT (license text; brief expected BSD — actual text is MIT). ISPC/SIMD texture compressor. PARK: upstream **archived/deprecated**, requires the ISPC compiler as a build dependency, BC7 quality trails bc7enc_rdo per upstream's own notes.
- **MikkTSpace** — zlib. Reference tangent-space generator (two C files); industry-standard tangent basis (Blender/Substance/Maya-compatible), required for correct normal-map baking/sampling. PARK pending a one-line license waiver — zlib is not in the MIT/Apache-2.0/BSD allowlist. If waiver granted, adopt immediately. https://github.com/mmikk/MikkTSpace
- **TexSyn** — license unverified. Header-only C++17 procedural texture synthesis via composable operators. PARK: author states built only on macOS, "unlikely to build on other platforms without changes" — fails the Windows gate as-is; license unverified; 1.2 GB clone is a practical nuisance. FastNoise2 + a small custom operator layer covers the same ground.
- **Embark texture-synthesis** — dual MIT / Apache-2.0. Example-based texture synthesis (exemplar → larger/tiled texture). PARK: **Rust, not C++** (CLI/subprocess dependency only) + upstream stale (~2023). Keep as technique reference; if exemplar synthesis is needed, evaluate re-implementing the algorithm in C++ or invoking it as a CLI.

### REJECT
- **ImageMagick** — ImageMagick License (Apache-2.0-*derived*, not Apache-2.0 itself) + full builds bundle LGPL delegates. Fails the strict license gate. OIIO covers the same bake-time needs under clean Apache-2.0.
- **Substance** (proprietary), **Material Maker** (GPL), **Blender** (GPL) — excluded by gate, not evaluated.

### Leads not verified — do not adopt without a verification pass
- **NVIDIA Texture Tools (NVTT):** GPU-accelerated BC/ASTC compression; license/maintenance unverified.
- **etc2comp (Google):** ETC2 encoder; license/maintenance unverified.
- **bc7e (BinomialLLC):** BC7 encoder inside Basis Universal (Apache-2.0 by inheritance); effectively superseded by bc7enc_rdo for bake use.
- **Gaffer / OpenUSD:** BSD/Apache respectively, but full DCC/scene-graph stacks, far heavier than the material-only need; MaterialX covers the material layer without them.

## Category 4 — AAA rendering techniques

### EVALUATE
- **Blast** — see Top 5. Bake-time + server-side destruction. Verify LICENSE at pin; scope the Jolt bridge.
- **V-HACD maintained fork** — BSD-3-Clause, header-only C++17, accuracy-driven. Bake-time convex decomposition for Blast debris colliders. https://github.com/kklouzal/v-hacd (upstream https://github.com/kmammou/v-hacd is archived — PARK upstream.)
- **CoACD** — MIT, SIGGRAPH 2022, collision-aware decomposition, generally higher quality than V-HACD. Depends on OpenVDB (now Apache — OK) + TBB/Boost; heavier build. Bake-time alternative to V-HACD; compare quality/build cost. https://github.com/SarahWeiii/CoACD
- **Effekseer** — MIT runtime, very active (v1.80.7, Aug 2026). Particle-effect authoring tool + runtimes. **EVALUATE as authoring→bake pipeline only** (export/converter), NOT as a client runtime — do not add a second VFX runtime alongside three.quarks. Additive use: artists author in Effekseer, bake to sprite sheets / flipbooks or convert `.efkefc` into three.quarks effects. WebGL/WASM build (`effekseerforweb`, MIT) exists if a browser preview is ever wanted. https://github.com/effekseer/Effekseer
- **FidelityFX FSR 1 / CAS / SPD (v1.1.4 or standalone repos)** — MIT. FSR 1 spatial upscaler, CAS adaptive sharpening, SPD single-pass mip generation. GLSL versions already exist (mpv ports prove WebGL-style GLSL viability). EVALUATE: port CAS + FSR 1 GLSL into the WebGL post chain as an experiment. SPD is compute-shader (useful for future native / bake-time texture pipelines; no direct WebGL2 compute port). FSR 2/3 temporal needs motion vectors + history — future native only. Pin v1.1.4 or standalone repos; never v2.x. https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK
- **FidelityFX full suite (v1.1.4)** — MIT. CACAO (AO), LPM (HDR tonemap/gamut), SSSR (screen-space reflections), Denoiser, Parallel Sort. EVALUATE as a shader library for the future native renderer; CAS/FSR1 are the only parts with a near-term WebGL port.
- **bgfx** — BSD-2-Clause, ~17,549 stars, very active (commits Oct 2026). Cross-platform rendering abstraction (D3D/Vulkan/Metal/OpenGL/WebGPU/WebGL) + shader compiler + texture/image libs. EVALUATE: leading candidate for the future-native RHI layer. It does NOT itself provide volumetrics/water/hair/destruction — those are still implemented on top. No action until the native renderer is commissioned. https://github.com/bkaradzic/bgfx
- **Bruneton precomputed atmospheric scattering** — BSD-3-Clause, stable reference (finished, not maintained — fine for its role). Precomputes transmittance/irradiance/scattering LUTs; sky + aerial perspective become cheap texture lookups. EVALUATE: adopt the GLSL/LUT approach (port, not vendor the demo) for the sky; validate against Bruneton's demo output. Prefer Hillaire 2020 for runtime; Bruneton remains the correctness reference. Windows for the demo itself is plausible but unverified — the GLSL shaders are the portable part. https://github.com/ebruneton/precomputed_atmospheric_scattering
- **Prague Sky Model** — Apache-2.0, stable reference. C++ implementation of Wilkie et al. SIGGRAPH 2021/2022 sky model — the modern, clean-license successor to Hosek-Wilkie. EVALUATE: cook sky textures/coefficients offline, sample in shader. Compare against Bruneton/Hillaire before choosing the sky path. Windows: yes (demo builds on DX11). https://github.com/PetrVevoda/pragueskymodel
- **Hillaire 2020 sky/atmosphere** — license **unverified** (Epic sample code — do not assume). "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR 2020), shipping as Unreal's SkyAtmosphere: small per-frame LUTs, dynamic atmosphere params, ground-to-space. EVALUATE: port the GLSL LUT passes (after license check); do not vendor the demo app. Best runtime sky architecture for a game that moves camera/sun freely. Reference: https://github.com/sebh/UnrealEngineSkyAtmosphere (maintained fork: https://github.com/itex34/unrealengineskyatmosphere)
- **OpenVDB / NanoVDB (v12+)** — **Apache-2.0 current** (re-licensed from MPL-2.0 — do NOT reject on license). Sparse volumetric data structures + tools; NanoVDB is the compact GPU-friendly read-only layout. EVALUATE: bake-time volumetric interchange only (export fog/cloud density fields, level sets for destruction/collision fields). Heavy dependency (TBB, etc.) — keep in bake tooling, never in the client or hot sim path. Pin v12+, audit dependency closure (TBB/Blosc) at the pin. https://github.com/AcademySoftwareFoundation/openvdb
- **SPlisHSPlasH** — MIT. Native C++ SPH fluid library (boundary handling, neighborhood search, interactive sim). EVALUATE for bake-time/offline fluid + technique reference for runtime SPH. https://github.com/InteractiveComputerGraphics/SPlisHSPlasH
- **MantaFlow** — Apache-2.0. Grid/FLIP smoke-fire-liquid solver with scripting. EVALUATE for bake-time smoke/fire volumes (export density fields → OpenVDB/textures). https://github.com/thunil/mantaflow

### PARK
- **Wicked Engine** — MIT, ~7,285 stars, active. Full C++ game engine: PBR, GI, ray tracing, terrain, particles, volumetric fog/clouds, water, hair particles, Jolt physics, Lua, editor. PARK as a **reference codebase** to read while implementing volumetrics/water/particles in-house. Do not integrate — adopting the whole engine would replace the engine, not extend it. https://github.com/turanszkij/WickedEngine
- **Filament** — Apache-2.0, ~20,212 stars, very active. Real-time PBR engine (clustered forward, IBL, shadows, SSR, post: bloom, DoF, TAA/FXAA, tone mapping, dynamic resolution with FSR). PARK as technique reference (post/PBR code). Gaps for this task: only global fog — no volumetric clouds, no water/ocean, no hair, no destruction. https://github.com/google/filament
- **The-Forge** — Apache-2.0, ~5,642 stars, **slowing** (last noted commit Mar 2025). Cross-platform rendering framework + high-end effect samples. PARK: viable future-native base, but it is a framework (RHI + scaffolding), not a technique library; bgfx/Diligent are lighter. Decide only when the native renderer is commissioned. Console platforms are commercial-license only (irrelevant here). https://github.com/ConfettiFX/The-Forge
- **AMD TressFX** — MIT, ~840 stars, **dormant** (last update Jan 2023, v4.1). GPU hair/fur simulation + rendering. PARK: future native only, no WebGL path, no bake-time use, and a poor stylistic fit for a low-poly/voxel game (realistic strand hair). Technique reference for hair shading/simulation only. https://github.com/GPUOpen-Effects/TressFX
- **FFT ocean (`oceanrenderer`)** — license unverified; Vulkan-only demo app, not a library. PARK. (See REJECT below for the GPL one.)
- **Hosek-Wilkie sky** — license **conflicting** (CC-BY 3.0 vs BSD-3-Clause across vendored copies). PARK: do not vendor until resolved from the original source. Prague Sky Model is the clean fallback.
- **NVIDIA Flow** — BSD-3-Clause (current PhysX-repo distribution). Sparse-grid real-time smoke/fire fluid. PARK: GPU/CUDA-oriented; renderer handoff is the hard part. Technique reference for smoke/fire; not a drop-in for a WebGL client.
- **openMaelstrom** — MIT, GPU SPH, but **CUDA-only** + depends on OpenVDB/Bullet/Qt. PARK — CUDA-only excludes the engine's needs.
- **GLGrassRenderer** — license unverified. C++/OpenGL demo of "Responsive Real-Time Grass Rendering" (Bezier blades, compute-shader wind/culling, tessellation LOD). PARK: dormant demo, not a library; do not use without license verification.
- **Filament post** (Apache-2.0): bloom, DoF, AgX/ACES tonemappers, TAA/FXAA — PARK as technique reference.

### REJECT
- **FFT ocean (`wme7/fftocean`)** — GPL-3.0. REJECT on license grounds. (C++/OpenGL Tessendorf demo.)
- **Field3D** — New BSD (passes license) but **explicitly no longer maintained**, heavy deps (Boost, HDF5, IlmBase), patch-level Windows only. REJECT: superseded by OpenVDB (now Apache-2.0) for volumetric interchange.
- **FidelityFX SDK v2.x / FSR 4** — binary-only license (v2.x) / DX12-only + binary (FSR 4). REJECT. Pin v1.1.4 or standalone repos.

### No good standalone option (honest gaps)
- **Volumetric clouds:** none. Implementations live inside engines (Unreal Volumetric Clouds, Wicked, Godot `gd-clouds` plugin — Godot-specific, not reusable) or as research demos. **Recommended path:** in-house GLSL raymarch — Hillaire atmosphere + fbm density field + light-marching, following Wicked/UE/gd-clouds as technique references. OpenVDB (bake-time) can carry density fields if baked clouds are ever wanted.
- **Foliage/grass at scale:** none. Grass lives inside engines or as one-off demos. Engine already owns EZ-Tree (bake-time trees) — grass is the remaining gap. **Recommended path:** in-house instanced grass in three.js (instanced blade cards/cross-quads + wind shader), using GLGrassRenderer + Wicked as technique references only.
- **FFT ocean (C++ library):** none. What exists are GPL demos, engine plugins, or full demo apps. Tessendorf math is public (paper + countless ports). **Recommended path:** implement Tessendorf in-house (~small, well-documented algorithm) — C++ CPU FFT generating heightfield/normal/foam textures at bake time or on the sim, shipped to the client as textures — following `oceanrenderer` as a technique reference only.
- **Hair:** only TressFX, dormant + wrong style fit. For this engine's low-poly/voxel style, card-based hair is more appropriate than strand simulation — no adoption recommended.
- **Post-processing as a C++ library:** none — FidelityFX is the answer, and it is a shader collection, not a C++ framework.
- **Real-time VFX runtime:** none beats the adopted three.quarks for the WebGL client. The gap is authoring (Effekseer) + offline fluids (SPlisHSPlasH/MantaFlow), both covered above.

## Full engines / frameworks — cross-cutting verdicts

These are not libraries; they are candidates for technique reference or for the future-native renderer decision. None should be adopted as a dependency now.

| Engine / framework | License | Verdict | Role |
|---|---|---|---|
| Wicked Engine | MIT | PARK | Technique reference (volumetrics, water, GI, particles) |
| Filament | Apache-2.0 | PARK (runtime) / EVALUATE (`cmgen`/ibl bake tool) | Technique reference; IBL bake tool |
| The-Forge | Apache-2.0 | PARK | Future-native framework candidate |
| bgfx | BSD-2-Clause | EVALUATE | Leading future-native RHI candidate |
| Falcor | BSD-3-Clause core | PARK | DDGI/render-graph reference |

## Consolidated verdict table

| Candidate | License | Fit | Verdict |
|---|---|---|---|
| Embree | Apache-2.0 | Bake-time GI rays | ADOPT |
| OIDN | Apache-2.0 | Bake-time denoise | ADOPT |
| xatlas | MIT | Bake-time UVs | ADOPT |
| SPIRV-Cross | Apache-2.0/MIT | Bake-time GLSL-out | ADOPT |
| SPIRV-Tools | Apache-2.0 | Bake-time SPIR-V opt | ADOPT |
| MaterialX | Apache-2.0 | Bake-time materials + GLSL | ADOPT (spike ESSL→three.js) |
| OpenPBR Surface | Apache-2.0 | Material model | ADOPT (via MaterialX) |
| OpenImageIO | Apache-2.0 | Bake-time texture processing | ADOPT |
| KTX-Software | Apache-2.0 | Bake-time KTX2 encode | ADOPT |
| Basis Universal | Apache-2.0 | Bake-time texture codec | ADOPT |
| bc7enc_rdo | MIT | Bake-time BC7 | ADOPT |
| DirectXTex | MIT | Bake-time DDS/BC6H | ADOPT |
| stb | MIT/Public Domain | Bake-time image IO | ADOPT |
| cgltf | MIT | Bake-time glTF parse | ADOPT |
| glslang | BSD-family (verify) | Bake-time GLSL→SPIR-V | EVALUATE (license-file check) |
| Slang | Apache-2.0 + LLVM Exc. | Bake-time shader lang | EVALUATE (gate note; spike) |
| shaderc | Apache-2.0 | Bake-time convenience | EVALUATE |
| sokol-shdc | Unverified | Bake-time cross-compile | EVALUATE (verify license) |
| OpenPGL | Apache-2.0 | Bake-time path guiding | EVALUATE |
| Filament `cmgen`/ibl | Apache-2.0 | Bake-time IBL | EVALUATE |
| glTF-IBL-Sampler | MIT/Apache-2.0 | Bake-time IBL→KTX2 | EVALUATE |
| UVAtlas | MIT | Bake-time UVs (alt) | EVALUATE |
| FFX CACAO 1.1.4 | MIT | GLSL port (runtime AO) | EVALUATE |
| XeGTAO | MIT | GLSL port (runtime AO) | EVALUATE |
| FFX Denoiser 1.1.4 | MIT | Real-time denoise | EVALUATE |
| FFX FSR1/CAS/SPD 1.1.4 | MIT | GLSL port / future native | EVALUATE |
| FFX full suite 1.1.4 | MIT | Shader library | EVALUATE |
| Assimp | BSD-3-Clause | Bake-time non-glTF import | EVALUATE |
| fastgltf | MIT | Bake-time glTF R/W | EVALUATE |
| tinygltf | MIT | Bake-time glTF | EVALUATE |
| OpenEXR | BSD-3-Clause | Bake-time HDR | EVALUATE |
| astc-encoder | Apache-2.0 | Bake-time ASTC | EVALUATE |
| Compressonator | MIT | Bake-time compression | EVALUATE |
| Blast | BSD-3 (verify at pin) | Bake + server destruction | EVALUATE |
| V-HACD fork | BSD-3-Clause | Bake-time decomposition | EVALUATE |
| CoACD | MIT | Bake-time decomposition | EVALUATE |
| Effekseer | MIT | Bake-time VFX authoring | EVALUATE (authoring only) |
| bgfx | BSD-2-Clause | Future-native RHI | EVALUATE |
| Bruneton scattering | BSD-3-Clause | Bake-time sky / reference | EVALUATE |
| Prague Sky Model | Apache-2.0 | Bake-time sky | EVALUATE |
| Hillaire 2020 sky | Unverified | Runtime sky architecture | EVALUATE (license check) |
| OpenVDB/NanoVDB v12+ | Apache-2.0 | Bake-time volumetrics | EVALUATE |
| SPlisHSPlasH | MIT | Bake-time fluids | EVALUATE |
| MantaFlow | Apache-2.0 | Bake-time smoke/fire | EVALUATE |
| OSL | BSD-3-Clause | Bake-time (niche) | PARK |
| OpenCV | Apache-2.0 | Bake-time (marginal) | PARK |
| MikkTSpace | zlib | Bake-time tangents | PARK (needs zlib waiver) |
| TexSyn | Unverified | Bake-time procedural | PARK (Windows + license) |
| Embark texture-synthesis | MIT/Apache-2.0 | Bake-time (CLI) | PARK (Rust + stale) |
| bc7enc (original) | MIT/Public Domain | — | PARK (superseded) |
| ispc_texcomp | MIT | — | PARK (archived) |
| Falcor | BSD-3-Clause | Reference | PARK |
| pbrt-v4 | Apache-2.0 | Reference | PARK |
| Mitsuba 3 | BSD-3-Clause | Reference | PARK |
| LuxCore | Apache-2.0 | Reference | PARK |
| Cycles standalone | Apache-2.0 | Reference | PARK |
| Appleseed | MIT | Reference | PARK (weak) |
| OSPRay | Apache-2.0 | Reference | PARK |
| cmft | BSD-2-Clause | Reference | PARK |
| IBLBaker | MIT | Reference | PARK |
| ASSAO | MIT | — | PARK (superseded) |
| Wicked Engine | MIT | Reference | PARK |
| Filament runtime | Apache-2.0 | Reference | PARK |
| The-Forge | Apache-2.0 | Future-native framework | PARK |
| TressFX | MIT | Future native only | PARK |
| Filament filamat | Apache-2.0 | — | PARK |
| Tint | BSD-3-Clause | — | PARK |
| bgfx shaderc | BSD-2-Clause | — | PARK |
| DXC | NCSA | — | PARK (gate clarification) |
| ShaderConductor | MIT | — | PARK |
| glsl-optimizer | MIT | — | PARK (unmaintained) |
| naga | MIT/Apache-2.0 | — | PARK (Rust) |
| noodles | MIT | Editor UI only | PARK |
| shader-minifier | Unverified | — | PARK (C#, not C++) |
| Hosek-Wilkie | Conflicting | — | PARK (resolve license) |
| FFT ocean (oceanrenderer) | Unverified | Demo | PARK |
| Flow | BSD-3-Clause | Reference | PARK |
| openMaelstrom | MIT | — | PARK (CUDA-only) |
| GLGrassRenderer | Unverified | Demo | PARK |
| RTXGI/DDGI | NVIDIA SDKs | — | REJECT (license) |
| NRD | NVIDIA SDKs | — | REJECT (license) |
| MoonRay | Apache-2.0 | — | REJECT (no Windows) |
| thekla_atlas | MIT | — | REJECT (superseded) |
| Field3D | BSD | — | REJECT (dead, superseded) |
| FFX SDK v2.x / FSR 4 | Binary-only | — | REJECT (license/platform) |
| FFT ocean (wme7) | GPL-3.0 | — | REJECT (license) |
| ImageMagick | ImageMagick License | — | REJECT (strict gate) |

## Caveats

- Star counts and last-commit dates come from search-result snapshots (Oct 2026 crawl data); where a figure could not be confirmed from a retrieved source it is marked **unverified** rather than estimated.
- Windows support is judged from CI/docs/vendor evidence, not from building each library against VS Build Tools 2026 — a build-verification pass on the ADOPT set is still advisable before vendoring.
- Several verdicts turn on a strict reading of the allowlist (MIT / Apache-2.0 / BSD only): Slang (Apache-2.0 + LLVM Exception), DXC (NCSA), ImageMagick (Apache-derived), MikkTSpace (zlib), Hosek-Wilkie (CC-BY vs BSD). Each needs an explicit gate-clarification or waiver call.
- The "ADOPT" verdicts are research recommendations, not integration orders. Each ADOPT still needs a spike/pilot (build on VS 2026, confirm the license file at the pinned revision, validate the three.js/WebGL output path) before it becomes a dependency.
