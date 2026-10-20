# Boot Smoke — native addons + real server boot

Branch `arlo/boot-smoke`, base `82b58c8` (origin/main). Purpose: close the
stack's last unverified item — build every native addon the region server
needs and boot the real `server.ts` end-to-end in this sandbox.

Each step of the work lands as its own commit on this branch; this file is
appended to as the steps complete. Every claim in it comes from a command
actually run in this worktree; failures are recorded with their exact
errors, not paraphrased.

## Step 1 — Native inventory (2026-10-20)

Derived from the static + dynamic import graph of
`packages/engine-core/src/server.ts` (1497 lines; entrypoint
`npm run server` → `node dist/src/server.js` after the dep-build chain),
the default module set in `content/modules.json`, and `packages/addons/*`.
All ten workspace addons are N-API (`binding.gyp`, `node-addon-api`,
`install` script runs `node-gyp rebuild`).

### Required by the region server at boot (default module set)

| Addon | Binding | How the server reaches it | If missing |
|---|---|---|---|
| `@mmo-engine/addon-physics` | Jolt Physics | `modules/physics/server.js` (default-enabled) calls `createJoltBackend()` unconditionally at system assembly; `packages/engine-core/src/systems.ts` `require()`s it lazily but with **no fallback** | Boot fails |
| `@mmo-engine/addon-navigation` | Recast/Detour + DetourCrowd/TileCache | Same module calls `createNavigationBackend()` unconditionally (`src/navigation/backend.ts`) | Boot fails |
| `@mmo-engine/addon-procgen` | FastNoise2 chunk generation | `server.ts` builds the terrain source with `makeProcgenChunkSource(...)` unconditionally (`src/procgen/chunk-source.ts`) | Boot fails — the loader throws a descriptive "not built" error |
| `@mmo-engine/addon-scatter` | Scatter kernel | `makeScatterPopulator()` on the `MMO_SCATTER=pcg` populator path (`src/procgen/scatter-spawn.ts`, via `world-populator.ts`). The populator picks `pcg` when the art packs' manifest is absent (the case in this sandbox), `ecology` otherwise | Boot fails on the pcg path with a descriptive "not built" error |
| `@mmo-engine/addon-picg` | PICG cooker | `src/pcg/boot.ts` `loadNativeCooker()` — failure is caught, cooker is `null`, the PCG service degrades and the boot log carries the reason | Boot continues (soft) |

### Workspace addons NOT in the region server's import graph

| Addon | Actual consumer |
|---|---|
| `@mmo-engine/addon-geometry` | Bake-time only: `packages/dungeon` CLI shell prebake |
| `@mmo-engine/addon-integrate` | Benchmark harness only (`packages/bench`) |
| `@mmo-engine/addon-perf-probe` | Valgrind/perf scripts only |
| `@mmo-engine/addon-template` | Toolchain template; the `modules/template-native` module declares a module-level native entry (`native/addon.node`, built by `scripts/build-native.mjs`), but `template-native` is **not** in the default module set |
| `@mmo-engine/addon-terrain-kernel` | **No consumer found** — a repo-wide search (src, scripts, modules) finds no import/require of it outside its own directory and the workspace registration in `package.json`/`package-lock.json`. The server's chunk source is `addon-procgen`. The kernel is exercised by its own package's tests/benchmarks |

### Non-workspace native dependencies

| Package | Declared where | Server role | Build model |
|---|---|---|---|
| `better-sqlite3` `^13.0.3` | `packages/engine-core/package.json` `dependencies` | **Hard.** All SQLite persistence: world store, characters, sessions, item ledger | Ships prebuilds (`prebuilds/linux-x64.node` present in the installed copy); loads with no local compile — verified in the main checkout (`node -e` in-memory DB: OK) |
| `argon2` `^0.45.1` | `packages/engine-core/package.json` `dependencies` (also used by `packages/world-server`) | **Hard.** Password hashing — statically imported by `src/auth/passwords.ts` (region) and world-server `core.ts`/`server.ts` | Ships platform prebuilds; verified loading in the main checkout |
| `uWebSockets.js` `v20.71.0` (git) | `packages/engine-core/package.json` `optionalDependencies` | Gateway transport: `src/net/transport.ts` "auto" uses uWS when its binary loads, else falls back to the pure-JS `ws` package | Ships per-Node-version `.node` binaries; verified loading in the main checkout (transport tests hang in this sandbox regardless — see Step 4 note) |
| `@surrealdb/node` `^3.0.3` | `packages/engine-core/package.json` `dependencies` | **Not in the server boot graph.** Used only by `src/persist/world-catalog.ts` (`createNodeEngines`), imported by bake tooling (`bake-world.ts`, `terrain/world-bake.ts`). Fleet mode instead talks HTTP to the world server; the world server uses the `surrealdb` JS SDK over `ws://` to an external SurrealDB binary | Ships per-platform `.node` binaries |

### Baseline build state observed while inventorying

In the main checkout (`~/workspace/nexus-engine`), 9 of the 10 workspace
addons already have a `build/Release/*.node` (all but
`addon-terrain-kernel`). A fresh worktree has **none** — `build/` is
gitignored — which is why test runs from fresh worktrees report the
native-addon failure class. Step 2 builds them here, in this worktree.

## Step 2 — Toolchain + addon builds (2026-10-20)

Toolchain in this sandbox (recorded verbatim):

- gcc / g++: Ubuntu 13.3.0
- GNU Make 4.3
- Python 3.12.3
- cmake 3.28.3
- node v24.20.0, npm 10.9.4, node-gyp v12.4.0/v13.1.0 (npx)

Dependencies were installed with `npm install --ignore-scripts` (682
packages) so the addon builds below are individually attributable; the
prebuilt native npm deps were then verified loading from this worktree:
`better-sqlite3` OK, `argon2` OK, `uWebSockets.js` OK, `@surrealdb/node`
OK via ESM import (a bare CJS `require()` fails with "No exports main
defined" — it is an ESM-only package, and its consumers import it).

Each addon was built with the repo's own build command — the same
`npx node-gyp rebuild -j max` that `scripts/build.mjs` runs per addon
folder — and **verified by artifact on disk + a `require()` load test**,
not by exit code alone. That discipline mattered twice:

1. A first background loop over all ten addons *reported* exit 0 and a
   `.node` name for every addon, but the artifacts for the last five did
   not exist on disk afterwards (their /tmp build logs were gone too —
   this sandbox reaps /tmp, and memory pressure is real: 7.9 GB total,
   ~1.2 GB free while compiling). Only geometry, integrate, navigation,
   perf-probe and physics were actually built by that pass. The five
   missing addons were rebuilt individually with disk verification
   after each.
2. `addon-picg`'s rebuild exited **7** *after* succeeding:
   `SOLINK_MODULE(target) Release/obj.target/picg.node` and
   `COPY Release/picg.node` completed, then node-gyp crashed in a
   post-build step — `gyp ERR! stack Error: ENOENT: no such file or
   directory, lstat '.../packages/addons/picg/build/node_gyp_bins'`.
   The artifact is good: the addon loads and reports
   `pcg-core 0.1.2 (bmesh-tier1)`. Exit code alone would have lied in
   both directions today.

### Per-addon verdicts (final state, all verified by load test)

| Addon | Artifact | Verdict |
|---|---|---|
| `@mmo-engine/addon-geometry` | `build/Release/geometry.node` | Builds, loads |
| `@mmo-engine/addon-integrate` | `build/Release/integrate.node` | Builds, loads |
| `@mmo-engine/addon-navigation` | `build/Release/navigation.node` | Builds, loads |
| `@mmo-engine/addon-perf-probe` | `build/Release/perf_probe.node` | Builds, loads |
| `@mmo-engine/addon-physics` | `build/Release/physics.node` | Builds, loads (Jolt; the long compile, ~7 min) |
| `@mmo-engine/addon-picg` | `build/Release/picg.node` | Builds, loads; node-gyp exit 7 post-build `node_gyp_bins` ENOENT (see above) |
| `@mmo-engine/addon-procgen` | `build/Release/procgen.node` | Builds, loads; `generateChunk(1234n,0,0,0)` produces heights |
| `@mmo-engine/addon-scatter` | `build/Release/scatter.node` | Builds, loads; exports `scatterChunk` |
| `@mmo-engine/addon-template` | `build/Release/addon.node` | Builds, loads |
| `@mmo-engine/addon-terrain-kernel` | `build/Release/terrain_kernel.node` | Builds, loads (the one addon the main checkout had never built) |

**All 10 workspace addons build and load in this sandbox.** No source
changes were needed anywhere — the gap was purely that fresh checkouts
never get their `build/` outputs.

