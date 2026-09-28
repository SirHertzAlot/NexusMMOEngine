# `@mmo-engine/addon-scatter` — native PCG scatter executor

PCG slice 3: executes a **cooked** scatter plan for one chunk
(sampler → filters/modifiers → spawner → spawn records). This is the
runtime authority — the JS reference evaluator in `@mmo-engine/scatter`
is authoring-time only.

Runs at chunk-load time, never on the 30 Hz tick hot path.

## API

```js
const scatter = require("@mmo-engine/addon-scatter");

const records = scatter.scatterChunk({
  plan: cookedPlan,   // from @mmo-engine/scatter cook(): { nodes, order, ... }
  worldSeed: 1234,    // u32
  cx: 0, cz: 0,       // int32 chunk coords
  heights: Float64Array, // row-major gridN x gridN height tile
  gridN, gridOx, gridOz, gridStep, // tile geometry (world units)
});
// -> [{ x,y,z, yaw,pitch,roll, sx,sy,sz,
//       asset, variantSeed, seed, attrs }, ...]  (canonical seed order)
```

Hash primitives are also exported for testing/diagnostics:
`hashU32(u32)`, `hash01(u32)`, `deriveChunkSeed(worldSeed, cx, cz)`.

## Determinism contract

The core (`src/scatter_core.cc`, pure C++17, no Node headers) reproduces
`packages/scatter/src/reference.ts` **bit-for-bit**:

- Point fields are `float` (JS `Float32Array` parity): every write
  quantizes double→float, every read widens back.
- All hash arithmetic is `uint32_t` (wrapping multiply = `Math.imul`).
- Sort is stable by seed; compaction preserves relative order.
- FP contraction is disabled (`-ffp-contract=off`, `/fp:precise`) so no
  fused multiply-add changes rounding vs the JS engine.
- No C++ exceptions (`-fno-exceptions` / `/EHsc-`); errors come back as
  status codes and surface as JS exceptions at the N-API boundary.

`test/scatter.test.mjs` locks this with golden vectors: hash primitives,
the forest example's first record, and full `deepStrictEqual` runs
against the JS reference on flat terrain, density edges, and a sloped
ramp.

## Heightfield input

`slopeFilter` needs local terrain gradients. The caller passes a height
tile (e.g. sampled from the procgen addon's `generateChunk` output in
slice 4); the core samples it with bilinear interpolation, clamped at
the tile border. The tile must cover the 16×16 chunk footprint plus the
0.5-unit slope epsilon (and jitter spillover).

## Build

Standard addon toolchain: `node-gyp rebuild` (runs on `npm install`).
No CMake, no vendored sources, no shell globs — one C++17 compiler.
