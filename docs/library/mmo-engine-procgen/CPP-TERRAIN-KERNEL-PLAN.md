# C++ Terrain Kernel Integration Plan

**Status:** planning (2026-10-11)
**Goal:** replace the JS/procgen terrain authoring with a segregated, deterministic
C++ kernel behind the existing narrow ABI — without breaking the engine.

## The seam already exists

`packages/engine-core/src/procgen/chunk-source.ts` defines the ABI the kernel must satisfy:

```ts
interface ChunkDataSource {
  readonly chunkSamples: number;          // 16x16 = 256
  generateChunk(seed: bigint, cx: number, cz: number, lod: number, out: Float32Array): void;
}
```

Engine code depends only on this interface ("the native addon can be swapped ...
without touching callers"). Chunk data is never persisted — deterministically
regenerable from `(seed, cx, cz, lod)`. The gateway's 0x21 tile handler and the
client's ChunkStreamManager both bottom out here.

**The C++ kernel is a new implementation behind this seam, not a redesign.**

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    C++ terrain kernel                        │
│  (deterministic, bit-identical across platforms)             │
│                                                              │
│  FastNoise2 (MIT, C++17, SIMD)                               │
│    → base heightfield: fbm/ridged/domain-warped stacks       │
│  Selo composition (ported techniques)                        │
│    → hydraulic carving, rivers, groundwater fields           │
│  Bake-time erosion stage                                     │
│    → multi-scale framework (H-Schott, MIT)                   │
│    → hydraulic operator (terraingen kernel, MIT)              │
│    → droplet/stream operator (SimpleHydrology, MIT per its        │
│       README — direct port or close reference allowed; clean-   │
│       room now optional, not legally required)                  │
│    → thermal operator (talus angle)                           │
│  Plate tectonics macro stage (Guy-Shalev technique, MIT)     │
│    → Voronoi plates + velocity field + divergence/curl       │
│       → mountain ranges, rift valleys at continental scale   │
└──────────────────────┬──────────────────────────────────────┘
                       │ narrow ABI: generateChunk(seed, cx, cz, lod)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Node host: N-API addon (fast path) + wasm32 (reference)     │
│  - wasm32 is the bit-identical reference build               │
│  - N-API native addon only where profiling justifies it,     │
│    golden-checked against the wasm reference                 │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
              ChunkDataSource (existing seam)
                       ▼
         gateway 0x21 tiles → client stream manager
```

## Stage order (causal, coarse → fine)

1. **Tectonics** (continental): plate layout → mountain ranges, rift valleys,
   coastal shape. Runs once per world seed at low resolution; cached.
2. **Base heightfield** (regional): FastNoise2 stacks + Selo composition,
   conditioned on tectonic strain fields.
3. **Erosion** (bake-time, multi-scale): erode → upsample → erode across
   scales; droplet pass carves rivers; thermal pass stabilizes slopes.
4. **Chunk assembly**: cut 16×16 tiles with shared borders; LOD derived
   client-side from LOD 0.

## Determinism contract

- Integer-hash noise everywhere; no `Math.sin`-style platform FP.
- Fixed iteration counts, fixed timesteps for all erosion.
- wasm32 build is the golden reference; native must be bit-identical.
- Determinism tests: same `(seed, cx, cz, lod)` → byte-identical `out`
  across Linux/macOS/Windows and wasm32.

## Integration phases

**Phase 1 — FastNoise2 behind the seam.** Vendor FastNoise2, implement
`generateChunk` with noise-stack base terrain only. Golden tests vs the
current JS generator. No behavior change for players.

**Phase 2 — Selo composition.** Port the extracted techniques (hydraulic
carving, river corridors, groundwater fields) into the kernel.

**Phase 3 — Erosion stage.** Multi-scale framework + hydraulic/droplet/
thermal operators as a bake-time pass inside `generateChunk`.

**Phase 4 — Tectonics macro stage.** Plate model conditions the base
heightfield. World-scale coherence: mountain ranges where plates converge.

**Phase 5 — Native fast path.** N-API addon where profiling justifies it,
golden-checked against wasm32. Until then, wasm32 serves production.

## Non-goals

- Node never authors terrain heights (orchestration, versioning,
  persistence, and serving only).
- No GPU compute in the authoritative path (vendor FP breaks determinism).
- The kernel never talks to the network; it is a pure function of
  `(seed, cx, cz, lod)`.

## Open questions

- FastNoise2 SIMD determinism across x86/ARM: verify with golden tests
  before Phase 1 ships (fallback: scalar path for the reference build).
- Tectonics resolution vs chunk streaming: the macro stage runs at world
  scale; how its fields feed per-chunk generation without global state.
- Erosion iteration budgets: quality vs `generateChunk` latency for
  on-demand 0x21 tile serving (may need a tile cache in the gateway).
