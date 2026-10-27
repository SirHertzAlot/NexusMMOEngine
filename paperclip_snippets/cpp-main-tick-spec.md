# C++ Main Tick — Specification and Implementation Roadmap

## Summary
Commissioned by Joey 2026-10-27. Gated, phased plan to move the authoritative 30 Hz main simulation tick from TypeScript (engine-core) to C++, reducing Node.js to the networking/session tier on uWebSockets.js, while keeping the persistence tier (world-server + SurrealDB atomic ops) unchanged.

## Target Scale & Goal
- 1,000 concurrent users + 50,000 entities/NPCs in ONE region under shared resources (no sharding escape hatch).
- 30 Hz fixed tick (33.33 ms frame budget).
- Primary performance deliverable: **variance collapse** (compressing the 51k-entity tick p99 from ~72% of budget to ~10%, eliminating V8 GC and JIT deopt tail spikes).

## Architecture & Responsibilities
- **Node Process**: Ingress, auth, rate limiting, Zod schema validation, session reattachment, interest management (sectors), and per-client delta encoding from SAB views. Never simulates.
- **Sim Worker (C++ Tick Host)**: Fixed 30 Hz loop, SAB SoA component plane, direct Jolt physics stepping (no per-tick N-API crossing), native kernels.
- **Persist Worker**: SurrealDB WorldStore, atomic ops, and ledger transactions via lockless SPSC ring (unchanged).

## Implementation Phases (Gated on Joey's Word)
- **Phase 0 — Baselines & Transport Guarantee**: Re-run transport bench at 250–2,000 clients; re-baseline 51k JS tick; enforce loud failure if uWS fails to load; packaging fix for uWS binary.
- **Phase 1 — Transpiler Pilot (`fast-path.ts`)**: Run `typescript2cxx` on 230-line sync codec; hand-finish SAB boundaries; golden test parity vs TS reference; benchmark encode/decode.
- **Phase 2 — Production Wiring of Data-Plane Topology**: Wire PR #430 3-thread topology into production boot behind a rollback flag; sim worker initially runs TS tick over SPSC ring; green test suite & recovery soak.
- **Phase 3 — System-by-System Migration (Densest First)**: Integration/movement -> intent application -> creature passes -> spatial queries -> combat resolution -> residents.
- **Phase 4 — Native Tick Loop & Hardening**: Native accumulator/spiral-guard loop; determinism audit (fixed FP model); mid-soak sim worker crash drill; 1,000-client load test with network impairment injection.

## References
- Full Specification: `docs/CPP-MAIN-TICK-SPEC.md`
- Decision Log: `docs/DECISIONS.md`
- Roadmap: `docs/ROADMAP.md`
