# @mmo-engine/addon-integrate

N-API bulk integration addon for the slice-1.5 validation benchmark
(Phase 1 plan §6). Not a game system — a measurement instrument with two
entry points behind one narrow, data-oriented boundary.

## API

```js
const addon = require("@mmo-engine/addon-integrate");

// Harness A: one call per tick over JS-owned SoA Float32Arrays (zero-copy).
addon.integrate(px, py, pz, vx, vy, vz, count, dt);

// Harness B: pure C++ world. createWorld copies the arrays once;
// per-tick stepWorld moves no data across the boundary.
const world = addon.createWorld(px, py, pz, vx, vy, vz);
addon.stepWorld(world, dt);
addon.copyPositions(world, ox, oy, oz); // setup/teardown only
addon.worldSize(world); // -> n

// Empty N-API call, for isolating boundary overhead.
addon.noop();
```

Type declarations live in `index.d.ts`. The world handle is an opaque
N-API `External` freed by a finalizer when GC'd — no manual destroy.

Both harnesses run the same `integrate_kernel`
(`position += velocity * dt`, f32, SoA), so the benchmark compares
world-location cost, not two implementations.

## Build / test

```sh
npx node-gyp rebuild   # or: npm install (runs it via the install script)
npm test               # node:test — correctness + A/B kernel equivalence
```

Built with `-O3`. Exceptions are disabled
(`NAPI_DISABLE_CPP_EXCEPTIONS`); bad input throws a JS `TypeError` /
`RangeError` and returns `undefined`.
