# @mmo-engine/addon-procgen

Procedural chunk heightmaps for the MMO engine (slice 1.6): a narrow,
stateless N-API boundary over vendored **FastNoise2**.

```js
const procgen = require("@mmo-engine/addon-procgen");
const heights = new Float32Array(procgen.CHUNK_SAMPLES); // 256
procgen.generateChunk(12345n, 3, -7, 0, heights); // writes in place, zero-copy
```

## API

- `generateChunk(seed: bigint, cx: number, cz: number, lod: number, out: Float32Array, frequency?: number) -> void`
  - `seed`: u64; the **low 32 bits** are used (FastNoise2 seeds are int32).
  - `cx`, `cz`: chunk coordinates, int32.
  - `lod`: integer in `[0, 8]`. Each LOD doubles the chunk footprint at the
    same 256-sample count.
  - `out`: caller-provided buffer with room for ≥ 256 floats. Receives
    row-major heights in **(-1, 1)**, X as the inner loop: `out[j*16 + i]`.
    Callers scale to world units (engine-core's `makeProcgenChunkSource`
    applies `MMO_TERRAIN_AMPLITUDE`).
  - `frequency`: optional, in `(0, 1]` (default `DEFAULT_FREQUENCY`, 0.02).
    Lower = broader hills.
  - **Seamless borders:** sample `(i, j)` is evaluated at noise coordinate
    `(cx*15*step + i*step, cz*15*step + j*step)`, `step = 1 << lod`, so row /
    column 15 of a chunk and row / column 0 of its neighbour are the same
    point and bit-identical. Consumers place sample `i` at local world
    position `i * 16/15`, spanning the full 16-unit chunk.
- `CHUNK_SIZE` (16), `CHUNK_SAMPLES` (256), `MAX_LOD` (8), `DEFAULT_FREQUENCY`.
- `libraryInfo()` → provenance string.

Pure function: no native state is created or retained; the generator is
built per call. Chunk generation is on-demand (not per-tick), so the
per-call construction cost is noise next to 256 SIMD samples.

## Terrain constants (this slice)

- Noise: FastNoise2 **Simplex** (feature scale `1/frequency`) → **FractalFBm**,
  3 octaves, gain 0.5, lacunarity 2 — the finest octave (12.5-unit period at
  the default frequency) stays well above the ~1-unit sample spacing.
- Soft-clip `v / sqrt(1 + v²)`: raw FBm exceeds ±1 (p99 ≈ 1.3), and a hard
  clamp flattened ~10% of the terrain into plateaus. Uses only IEEE
  correctly-rounded ops, so it doesn't break cross-platform determinism.
- Simplex's own default feature scale is 100 (frequency 0.01); frequency
  is set on the Simplex node, not layered on top.
- Biome-driven relief (per-region amplitude/frequency) is Slice 5.

## Build note: RTTI on Windows

FastNoise2 wires nodes together with `dynamic_cast`. node-gyp's
`common.gypi` sets `RuntimeTypeInfo: false` per configuration, which
overrides a target-level setting in Release, so `binding.gyp` re-enables
RTTI under `configurations`. Without it, any node graph (e.g.
`fbm->SetSource(simplex)`) aborts the process with `0xC0000409`. The
MSVC warning C4541 ("dynamic_cast used … with /GR-") is the tell.

## Determinism

- **Same machine, same binary:** `generateChunk` is bit-identical for the
  same `(seed, cx, cz, lod)` — asserted by `test/procgen.test.js`
  (in-process exact equality **and** across process restarts).
- **Cross-machine:** FastNoise2 dispatches at runtime to the best SIMD
  feature set the CPU supports (this build compiles SSE2/SSE41/AVX2/AVX512
  on x86_64). The build uses upstream's default **RELAXED** floating-point
  mode (`FASTNOISE2_STRICT_FP=OFF`), under which different feature sets
  are *not* guaranteed bit-identical. In practice every server runs the
  same binary and picks the same path per CPU, but if cross-machine
  bit-identity becomes a requirement, Phase 2 should evaluate
  `FASTNOISE2_STRICT_FP=ON` (with a re-measure of the perf cost).
- **Across library updates:** fingerprints may legitimately change when
  the vendored commit changes — record the new ones (see
  `third_party/FastNoise2/VENDORING.md`).

## Build

`npm install` builds everything from a clean clone — no network needed:

1. A gyp `action` runs `scripts/build-fastnoise.sh`, which configures the
   vendored trees with **their own supported CMake machinery**
   (`cmake/CMakeLists.txt` reuses FastSIMD's
   `fastsimd_create_dispatch_library` — the same call FastNoise2's own
   build makes) into a single static archive
   `build/fastnoise/libfastnoise_bundle.a`.
2. `node-gyp` compiles `src/procgen.cc` and links the archive into
   `build/Release/procgen.node`.

Requires: `cmake >= 3.10`, a C++17 compiler. The CMake configure+build
takes ~1–2 minutes on first build (four SIMD feature-set compilations);
incremental `node-gyp build` skips it.

## Vendoring decision

FastNoise2 **and** FastSIMD are vendored under `third_party/` at pinned
commits (see `third_party/FastNoise2/VENDORING.md`):

- FastNoise2 `06969a19061d9a5c3892d300412f37fc21d8efe1` — MIT © 2020 Jordan Peck
- FastSIMD `16450dae9528727e500e7254f635a671f9c7ee2d` — the exact commit
  FastNoise2's CPM build pins — MIT © 2022 Jordan Peck

(Licenses verified against the upstream LICENSE files, not from memory.)

Why vendored instead of fetch-at-build: reproducible builds (the commits
can't move under us), offline `npm install`, and repo convention
(`third_party/flatc` is vendored for the same reason). FastNoise2 was
chosen over alternatives (libnoise forks, stb_perlin) for: MIT license,
active maintenance, SIMD speed, and a documented determinism story.

## What's still open (Phase 2)

- Formal license/buildability/determinism verification against primary
  sources (this slice verified the LICENSE files and builds cleanly, but
  the full evaluation pass is Phase 2 work per the plan).
- `FASTNOISE2_STRICT_FP` evaluation for cross-machine bit-identity.
- Configurable noise graphs (domain warp, biome blends) instead of the fixed Simplex → FBm chain.
- Prebuild distribution (`prebuild-install` style); `npm run prebuild`
  currently just tars the local artifact.
