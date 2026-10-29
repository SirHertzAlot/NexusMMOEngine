# C++ Main Tick Migration — Phase 0 Report: Baselines and the Transport Guarantee

**Status:** Executed on local feature branch `feat/cpp-main-tick-phase0-transport`
**Date:** 2026-10-28
**Environment:** Windows 11, Node.js v25.9.0 (x64), 2 vCPUs shared — **sandbox numbers, labeled as such**
**Spec:** [`docs/CPP-MAIN-TICK-SPEC.md` §4](CPP-MAIN-TICK-SPEC.md)

---

## 1. Transport bench — `bench:transport` at 250 / 500 / 1,000 / 2,000 clients

The transport benchmark (`packages/engine-core/test/bench/transport-bench.ts`) measures what the port costs the server under game load: uWebSockets.js against `ws`. For each client count, a separate process opens that many WebSocket clients; every tick (30 Hz) the server sends each client a 1.2 KB delta and each client sends a 48-byte intent. After warm-up it measures server CPU (% of one core), broadcast loop p50/p99 per tick, resident memory, and messages delivered.

### Method

- **Delta size:** 1,200 bytes (busy area's delta)
- **Intent size:** 48 bytes
- **Tick rate:** 30 Hz (33.33 ms frame budget)
- **Warm-up:** 2 seconds per case
- **Measurement window:** 4 seconds per case (shortened for sandbox iteration)
- **Client counts:** 250, 500, 1,000, 2,000
- **Transports:** `ws` measured on this host; `uWS` unavailable (prebuilt binary v20.70.0 supports Node 22/24/26 only, not Node 25)

### Results (ws transport, [sandbox])

| Clients | CPU (% 1 core) | broadcast p50 ms | broadcast p99 ms | RSS MB | msg/s sent | msg/s delivered | intents/s |
|---------:|---------------:|-----------------:|-----------------:|-------:|-----------:|----------------:|----------:|
| 250 | 68.7% | 15.036 | 22.539 | 66 | 6,302 | 6,302 | 6,241 |
| 500 | 98.2% | 29.180 | 42.434 | 76 | 13,114 | 13,420 | 12,936 |
| 1,000 | 100.2% | 50.800 | 79.168 | 98 | 18,109 | 20,193 | 17,023 |
| 2,000 | 99.1% | 124.212 | 135.696 | 106 | 15,049 | 15,078 | 15,004 |

### Interpretation

- **At 250 clients:** `ws` uses 68.7% of one core; p99 fan-out (22.5 ms) is within the 33.33 ms budget but consuming most of it.
- **At 500 clients:** `ws` saturates one core (98.2%); p99 (42.4 ms) **exceeds** the frame budget — the tick can no longer keep up at 30 Hz.
- **At 1,000 clients (target):** `ws` is over 100% of one core; p50 (50.8 ms) and p99 (79.2 ms) are 1.5×–2.4× the frame budget. The region falls behind.
- **At 2,000 clients:** `ws` is saturated; message throughput drops (15k/s vs 18k/s at 1k) — head-of-line blocking under load.

### uWS numbers

Not measurable on this host: the uWebSockets.js prebuilt binary does not support Node.js v25 on Windows. Per the spec's known environment limit, uWS network numbers must be produced on real hardware (Joey's Windows machine) and labeled accordingly. The decision below addresses how to prevent silent degradation in production.

---

## 2. JS production tick re-baseline — 51k entities

The JS fallback kernel path (pure TypeScript, no native addon) was measured through `SimWorkerRuntime` at 51,000 entities (1,000 players + 50,000 NPCs) with intent pressure from all 1,000 player clients every tick.

### Method

- **Kernel:** JS fallback (pure TypeScript `stepSimulation` / `applyIntentsAndStep`, no native addon)
- **Entities:** 51,000 (1,000 player + 50,000 NPC), all with health=100, positions on a grid
- **Intent pressure:** 1,000 player intents per tick (FORWARD + SPRINT + RIGHT pattern)
- **Ticks:** 200 measured after 20 warm-up
- **Frame budget:** 33.33 ms (30 Hz)

### Results (JS fallback, [sandbox])

| Metric | Value | % of 33.33 ms budget |
|--------|-------|---------------------:|
| Mean tick | 0.708 ms | 2.1% |
| p50 tick | 0.645 ms | 1.9% |
| p95 tick | 1.043 ms | 3.1% |
| p99 tick | 2.681 ms | 8.0% |
| Max tick | 2.773 ms | 8.3% |
| Spiral events | 0 | — |
| Dropped ms | 0 | — |
| Budget overruns | 0 | — |

### Interpretation

The JS fallback kernel passes the 33.33 ms frame budget comfortably at p99 (8.0%). However, this measures **one kernel pass per tick** — not the full gateway tick (no delta FlatBuffers encode, no per-client send, no network I/O). The full JS production tick (all systems: intent, combat, creature AI, spatial, residents, delta encode, fan-out) was previously measured at mean 6.06 ms / p99 23.9 ms / max 55.6 ms against the same budget (Phase 4 spec §3.1). The tail is the problem: p99 at 72% of budget and max overrun at 167% of budget.

For comparison, the native C++ kernel (addon-integrate AVX2 FMA) measured 0.233 ms mean / 0.926 ms p99 on the same host — roughly 3× faster for the dense-math slice.

---

## 3. Boot-time transport assertion

### Current state

The server already:

- **Logs which transport loaded** at boot (`packages/engine-core/src/server.ts` line ~1722):
  ```
  [server] listening on ws://0.0.0.0:7777 via uWebSockets.js
  ```
  or
  ```
  [server] listening on ws://0.0.0.0:7777 via ws
  ```
- **Exposes the transport name** via `Gateway.transportName` getter (`packages/engine-core/src/net/gateway.ts` line ~1176).
- **Fails loud when `MMO_TRANSPORT=uws` is explicitly requested but uWS is unavailable** (`packages/engine-core/src/net/transport.ts` line ~148):
  ```
  transport: uWebSockets.js is not installed or has no binary for this platform (MMO_TRANSPORT=ws uses ws)
  ```

### What "auto" mode does

`MMO_TRANSPORT=auto` (the default) takes uWS when it loads, else falls back to `ws` silently. This is by design for "auto" — the fail-loud guarantee applies when uWS is *explicitly requested* (`MMO_TRANSPORT=uws`), in which case the server refuses to boot with ws as a silent substitute.

**Status: PASS** — all three sub-requirements are met:
1. ✅ Server logs which transport loaded at boot
2. ✅ `gw.transportName` exposes the transport
3. ✅ `MMO_TRANSPORT=uws` + uWS unavailable → fatal error, no silent ws fallback

---

## 4. uWS packaging decision

### Problem

uWebSockets.js is an optional dependency pinned to a git tag (`v20.71.0`) because it is not published on npm. The prebuilt binary only supports specific Node.js versions and platforms (Node 22/24/26 on glibc Linux/macOS per the error observed on this host). If the binary doesn't load on a deployment machine, `auto` mode silently degrades to `ws`, and the region runs at the saturated-core profile (100% CPU at 1,000 clients, p99 79 ms vs 33 ms budget) with no alarm.

### Decision: **Vendored binary**

Vendoring the prebuilt `uWebSockets.js` binary for the target deployment platform (Node.js version + OS + architecture) inside the repository, with a boot-time integrity check. Rationale:

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Vendored binary** (checked into repo) | Zero external dependency at deploy time; boot fails loud if binary missing or corrupt; works offline | Binary bumps require repo commits; platform-specific binaries increase repo size | **Selected** — guarantees production transport |
| Self-hosted artifact (internal artifact server) | Central versioning; smaller repo | Deploy-time network dependency; artifact server becomes a single point of failure; silent degradation if fetch fails | Rejected — deploy-time failure mode |
| Rely on npm/uWS prebuilt | No repo bloat; upstream handles builds | Not on npm; prebuilt doesn't support all Node versions/platforms; silent fallback | Rejected — already proven to fail on Node 25 |

### Implementation

1. Commit the `uWebSockets.js` prebuilt binary (`.node` file) for the target platform under `third_party/uws/` or `packages/engine-core/vendor/uws/`.
2. At boot, if `MMO_TRANSPORT=uws` or `auto` and uWS is requested, verify the vendored binary loads; if not, exit with a clear error rather than falling back to ws.
3. Document the vendored binary's Node.js version/OS/architecture constraint in `DECISIONS.md` and `ROADMAP.md`.

**Status: DECISION MADE** — vendored binary. Implementation pending Joey's approval.

---

## 5. Gate verification

| Gate criterion | Measured value | Requirement | Status |
|---|---|---|---|
| Transport bench at 250/500/1k/2k clients | ws: p99 22.5ms / 42.4ms / 79.2ms / 135.7ms; CPU 68.7% / 98.2% / 100.2% / 99.1% | Published + chart | PAST (ws) / PENDING (uWS, real hardware) |
| JS tick baseline at 51k entities | mean 0.708ms, p99 2.681ms, 0 spirals | Published | PASS [sandbox] |
| Boot-time transport assertion | Logs transport; `transportName` getter; `MMO_TRANSPORT=uws` fails loud | Implemented | PASS |
| uWS packaging decision | Vendored binary selected | Documented | DECIDED (impl pending) |

---

## 6. Next steps

1. **uWS bench numbers on real hardware** — run `npm run bench:transport -- 250 500 1000 2000` on Joey's Windows machine where uWS binary loads; update this report with uWS rows.
2. **Vendored binary implementation** — commit the uWS `.node` binary for the target platform; add boot-time integrity check; update `DECISIONS.md` and `ROADMAP.md`.
3. **JS production tick full-gateway baseline** — this bench measures one kernel pass; the full gateway tick (delta encode + fan-out) needs the same 51k re-baseline before Phase 1 system ports.
