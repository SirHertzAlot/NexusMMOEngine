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

## Step 3 — Boot smoke (2026-10-20)

Two repeatable scripts, committed with this section:

- `scripts/boot-smoke.mjs` — standalone region (no `WORLD_URL`).
- `scripts/boot-smoke-fleet.mjs` — SurrealDB + world server + a region
  that registers with the world.

Both boot the real entrypoint (`packages/engine-core/dist/src/server.js`),
seed a login with the repo's own `seed-user` tool, drive the wire
protocol with the repo's own `HeadlessClient`
(hello → welcome → snapshot → delta), then SIGTERM and verify the exit
and that the ports are free.

One wrinkle worth knowing: `npm run server` chains `npm run build && node
dist/src/server.js`, and the build's final `tsc` step exits non-zero on
main's 5 pre-existing type errors (3× `src/dungeons/content.ts` TS2739
missing `props`/`looks`/`wallBodyRadiusM`/`teleportStepM`; 2×
crafting-rules `| null` TS2322 in `src/server.ts` and
`test/crafting-service.test.ts`). tsc still emits the full dist, so the
smokes run the emitted server — the same JS the chain would have run.
Fixing those 5 errors is main's own cleanup (see the follow-ups list).

### Standalone — PASS (two consecutive runs)

- Readiness: **4,550 ms** (run 1), **3,854 ms** (run 2) from spawn to the
  server's own readiness line:
  `[server] listening on ws://0.0.0.0:7917 via uWebSockets.js (+ webrpc http://0.0.0.0:7917/rpc/Pcg)`
  — the native uWS transport is the one serving (transport "auto" picked
  it because its binary loads).
- Native addons live in the boot log, not just loadable:
  `[server] 3 PCG asset(s) (oak, birch, pine) from .../content/pcg; cooking with pcg-core 0.1.2 (bmesh-tier1)`
  and `[server] fresh boot | seed 1234 | chunk 16u | terrain amp 2 freq 0.02 (v3354354370) | spawn (0, 0) | navmesh 0 tile(s) | water none | players can swim | a day lasts 2400 s`.
- Login: `[gateway] hello client="smoke" via=password` → welcome with
  `player_entity=51` and a session token issued.
- Snapshot: **17,376 bytes** on the wire (tick 11, 43 transform rows,
  9 chunk rows); a live delta followed (880 bytes run 1, 464 bytes run 2).
- Shutdown: `[server] shutdown save on SIGTERM: tick 13` — exit code 0
  ~101 ms after SIGTERM, port 7917 verified free, no orphans.

### Fleet — PASS (two consecutive runs)

Stack: SurrealDB **2.7.0** (`surreal version` → `2.7.0 for linux on
x86_64`; the binary already present in this sandbox from the
durability-verification slice, passed to the script as `SURREAL_BIN`)
on 127.0.0.1:8001 with scratch rocksdb in-worktree → world server
(`WORLD_DB_URL=ws://127.0.0.1:8001/rpc`, `WORLD_API_KEY` set) on :7780 →
region with `WORLD_URL=http://127.0.0.1:7780`.

- Surreal port open after **408 ms**.
- World: `[world] store=surrealdb url=ws://127.0.0.1:8001/rpc`, then
  `[world] listening on :7780 (webrpc /rpc/World/*)`.
- Region registration + P5 assignment, verbatim from the region log:
  `[server] registered with world at http://127.0.0.1:7780 as region-1 (epoch 1) — assigned range 0,0..4096,4096 via host htch-runtime`
- Region listening **4,134 ms** after spawn; handshake completed against
  the fleet-backed region (welcome `player_entity=25`, token issued,
  snapshot 8,584 bytes at tick 11 with 22 transform rows, delta live).
- Shutdown inside-out: region, world, Surreal each exited code 0 ~100 ms
  after SIGTERM; ports 7917/7780/8001 all verified free; no orphans.

**The full stack — native addons, real server, real SurrealDB, fleet
registration, wire handshake — boots and shuts down cleanly in this
sandbox.** What this does not prove: sustained load, multi-client
behaviour, or a second region migrating a character (the crash drills on
`arlo/durability-verification`, already on main, cover kill/recovery at
the service level; a two-region live migration smoke is still unbuilt).


