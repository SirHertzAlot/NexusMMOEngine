# @mmo-engine/addon-terrain-kernel

Grid-level terrain kernel (phases P2–P4 of the C++ terrain kernel plan).
The survey (`packages/engine-core/src/terrain/survey.ts`) stays the JS
orchestrator; C++ owns heightfield math behind this API.

## API

- `bakeHeightfield(params, height, flow)` — run a stage list over the
  heightfield in place, then write rain-weighted upstream area into
  `flow`. Stages: `identity` (P2 plumbing), `thermal` / `fluvial` /
  `droplet` (P4 erosion ports). `rainShare` is required by the
  fluvial/droplet stages.
- `computeTectonics(params, uplift, strain)` — P3: Voronoi plates →
  uplift (metres) and strain (0..1) fields. The survey adds `uplift` to
  its base heightfield as a substitute for the wind-placed `rangeUplift`
  behind a flag.
- `thermalErode` / `fluvialErode` / `dropletErode` — P4 operators with
  the same signatures as `terrain/erosion.ts` (minus the `CoarseGrid`
  wrapper: width/depth/cell are passed directly), so the survey can swap
  one operator at a time.
- `computeFlow(height, w, d, cell, weight|null, flow)` — kernel-internal
  depression filling + drainage + accumulation, exposed for the survey's
  water-map derivation.

All grids are caller-provided `Float32Array`s (zero-copy). Invalid input
throws a JS `TypeError`/`RangeError`; no C++ exception crosses the
boundary.

## Wiring the survey to the kernel (P4)

`kernel-stages.js` exposes the three operators with exactly the
`terrain/erosion.ts` call shapes (`(h, grid, …)`), so the swap in
`survey.ts` is mechanical:

```js
const { thermalErosion, fluvialErosion, dropletErosion } =
  process.env.MMO_TERRAIN_KERNEL === "1"
    ? require("@mmo-engine/addon-terrain-kernel/kernel-stages")
    : require("./erosion.js");
```

`kernel-stages.js` adapts the `(h, grid: CoarseGrid, …)` shape to the
flat N-API calls and converts the droplet `rng` argument: the kernel
takes the world seed and reproduces `mulberry32(seed ^ 0xe20d)`
bit-identically, so pass `spec.seed`.

## Determinism contract

- Same `(seed, params)` → bit-identical bytes, in-process and across
  processes (tested). The P1-style fingerprint harness is in
  `test/kernel.test.js`.
- The erosion ports reproduce `terrain/erosion.ts` bit-for-bit on fixed
  seeds on the reference platform (Linux x86-64): all arithmetic is IEEE
  correctly-rounded double with float32 stores mirroring `Float32Array`
  semantics; `Math.tan`/`Math.hypot` were verified bit-identical to
  `std::tan`/`std::hypot` here. `test/parity.test.js` enforces this
  against the compiled JS reference.
- Tectonics uses no transcendentals at all (polynomial boundary falloff),
  so its fields are bit-identical across platforms and compilers.
- **Caveat (P6):** cross-platform bit-identity of the erosion operators
  (libm `tan`/`hypot` last-ulp variance, FastNoise2 SIMD) is not enforced
  until the wasm32 reference exists. The heightfield is deterministic;
  full-world bit-identity additionally needs the JS climate/biome stages
  ported or integer-ized — explicitly out of scope.

## Layout

- `src/terrain_kernel.cc` — N-API shims only (validation + buffer wiring).
- `src/kernel/` — pure C++17, no N-API types: `hydrology.cc`
  (Barnes-2014 fill, steepest-descent drainage, accumulation),
  `erosion.cc` (thermal / fluvial / Beyer droplet ports),
  `tectonics.cc` (Voronoi plates). A future wasm32 build compiles these
  directly.
- `include/terrain_kernel/` — `grid.h` (the float32-store discipline),
  `rng.h` (mulberry32 bit-identical to `survey.ts`; SplitMix64),
  `erosion.h` / `hydrology.h` / `tectonics.h`.
- `test/kernel.test.js` — API, determinism, validation, tectonics goldens.
- `test/parity.test.js` — C++ vs compiled-JS bit-identity + benchmarks.
- `scripts/` — `build-jsref.sh` (compile the JS reference),
  `bench.cjs` (benchmark gate numbers).

## Build

`npm install` runs `node-gyp rebuild` (canonical). The kernel vendors no
third-party code and needs only a C++17 compiler — no CMake, no network
at build time beyond npm.
