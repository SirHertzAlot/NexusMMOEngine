# Nexus MMO Engine — Workspace Agent Guidelines & Invariants

This document establishes mandatory architectural rules, documentation conventions, and rendering constraints for all AI coding assistants operating within this repository.

---

## 1. Documentation Separation Policy

- **Public / User-Facing Manuals (`docs/wiki/`, `docs/WIKI.md`, `README.md`):**
  - Must remain strictly focused on the Nexus MMO Engine's architecture, APIs, module systems, and authoring workflows.
  - Do NOT include competitive comparisons, benchmark shootouts against third-party engines, or disparaging commentary.
- **Private Repository Intelligence (`docs/business-analysis/`):**
  - All competitive analyses (vs. Unreal Engine 5, Unity DOTS, Bevy, SpatialOS, WoW), SWOT analyses, cloud hosting OpEx models, and comparative benchmark telemetry belong exclusively in `docs/business-analysis/`.

---

## 2. Mermaid Diagram Invariants

The rendering pipeline strictly supports standard Mermaid diagram headers. Unsupported or experimental diagram types crash the documentation renderer:
- **SUPPORTED:** `flowchart TD`, `flowchart LR`, `graph TD`, `graph LR`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`, `xychart-beta`, `pie`.
- **FORBIDDEN:** Never use `quadrantChart`, `gantt`, `gitGraph`, or other experimental headers.
- **Alternative for Quadrant / Comparative Grids:** Use `flowchart TD` with categorized subgraphs or formatted Markdown comparison tables.
- **Node Label Quoting:** Always quote node labels containing special characters: `id["Label (Extra Info)"]`. Avoid raw HTML inside node labels.

---

## 3. Modern Documentation Tooling (Yank Note Ecosystem)

- **Environment:** Support Yank Note (`purocean/yn`) as our interactive Markdown editor kernel.
- **Executable Code Blocks:** Author documentation code blocks with runnable shell/node snippets where appropriate for 1-click test and benchmark execution.
- **Interactive Data Apps:** Support embedded HTML5 applets and widgets connecting to local telemetry endpoints (`ws://127.0.0.1:3000/telemetry`) or calculating infrastructure costs, ensuring explicit `color-scheme: dark;` on dark components.
- **Client Encryption:** Keep deployment credentials, private balance tables, and confidential keys in client-encrypted `.c.md` notes.

---

## 4. Native C++ Addon Memory Boundaries ("The Marshalling Trap")

- **Zero Object Traversal on Hot Paths:** Never cross the N-API boundary per-object or inspect individual JavaScript object properties (`obj.Get()`) inside simulation loops.
- **Bulk Memory Crossing:** Pass contiguous `SharedArrayBuffer` or `TypedArray` views across N-API once per tick, acquiring raw memory pointers via `napi_get_typedarray_info`.
- **Structure-of-Arrays (SoA):** Maintain contiguous typed-array component storage to allow vectorized C++ AVX2 execution with zero garbage collection allocations.

---

## 5. Development & Git Workflow Invariants

- **Standing Rule on Branches:** All feature work stays on local feature branches (`feat/*`). Never push, open PRs, or merge to main without explicit user authorization.
- **Universal SI Metric Scale:** All physical and procedural dimensions strictly adhere to SI units ($1.0\text{ unit} = 1.0\text{ meter}$).
- **Security Perimeter:** Memory-unsafe C++ code must NEVER parse untrusted network input directly; the Node.js Gateway must validate every byte before simulation ingestion.

---

## 6. SharedArrayBuffer & Sacred Hot-Path Producer Invariants ("The V8 Allocation Trap")

- **The Sacred Producer Path:**
  - Hot-path log emission and command enqueuing must strictly execute in the **tens-of-nanoseconds class** ($< 100\text{ ns}$) with **zero heap allocations ($0\text{ bytes}$ GC churn)**.
  - **Zero Closures:** Never pass callback closures to ring queue write methods (`enqueueRaw((data, base) => ...)`). Always use direct atomic CAS ticket reservation with in-place typed array writes.
  - **Zero Array Allocations:** Function signatures on the hot path must never accept dynamic arrays (`args: Array<...>`) or rest parameters (`...args`). Pass fixed positional arguments (`a0, a1, a2, a3`) directly.
  - **No BigInt Default Literals:** Avoid `bigint = 0n` default parameters in high-frequency signatures. Use optional or undefined checks to prevent V8 BigInt allocation and polymorphic call-site de-optimizations.
- **Clock Trap Amortization:**
  - Never call `performance.now()`, `process.hrtime.bigint()`, or `Date.now()` per record in tight loops. Syscall and QPC trap latency costs $50\text{--}85\text{ ns}$ per call on Windows.
  - Amortize monotonic timestamps across batches (e.g. `(count++ & 15) === 0`) or inherit the simulation frame/tick timestamp.
- **L2/L3 CPU Cache Sizing Discipline:**
  - High-frequency SharedArrayBuffer rings must be sized to remain resident in CPU L2/L3 cache (e.g. default capacity $16,384\text{ records} = 2.0\text{ MB}$).
  - Never inflate buffer sizes to hundreds of megabytes where sequential writes spill into main DRAM, incurring memory bus latency penalties.
- **Inlined Layout Offsets:**
  - Do not dereference property lookups (`RECORD_LAYOUT.HEADER_WORD`, `this.dataByteOffset`) inside tight atomic loops. Inline constant numeric word offsets to enable direct V8 register-indirect assembly generation.

---

## 7. Report Generation & Performance Telemetry Standards

Every performance-affecting change must ship a metrics report in `docs/` alongside the code. Reports are not optional decoration — they are the gate evidence.

### 7.1 Required Report Contents

| Element | Requirement |
|---|---|
| **Measured vs. modeled** | Every number tagged `[measured]` (produced by a bench on this project) or `[modeled]` (estimate with stated assumptions). Modeled numbers must be replaced by measurement at the phase gate. |
| **Measurement environment** | OS, CPU, Node version, build configuration, sandbox vs. real hardware. Sandbox numbers are labeled as such wherever used. |
| **Methodology** | Warm-up iterations, sample count, what was included/excluded (e.g. "sim passes only — no physics, no network"). |
| **Caveats** | Honest statement of what the number does and does not bound (e.g. "one pass, not a tick"). |
| **Gate verification table** | Columns: Telemetry Metric \| Measured Value \| Gate Requirement \| Gate Status (PASS/FAIL/MET). |

### 7.2 Chart & Diagram Standards

- Use only Mermaid diagram types supported by the renderer (see Section 2): `flowchart TD/LR`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`, `xychart-beta`, `pie`.
- `xychart-beta` for latency/throughput bar charts (e.g. p50/p95/p99 vs. budget).
- Never use `quadrantChart`, `gantt`, `gitGraph`, or other experimental headers.
- Embed images only where they add decision-relevant evidence (benchmark comparisons, determinism overlays, crash-drill timelines). Every image must have a caption and an alt-text description.

### 7.3 Where Reports Live

- Phase reports: `docs/CPP-MAIN-TICK-PHASE<N>-REPORT.md` (or `docs/SAB-LOGGING-PHASE<N>-REPORT.md` for the logging layer).
- Benchmark results: `docs/` adjacent to the feature, or `transport-bench-results.json`/`lighthouse-report.json` at repo root for transport/client telemetry.
- Business/competitive intelligence (SWOT, OpEx, third-engine comparisons): exclusively in `docs/business-analysis/` — never in public-facing manuals (Section 1).

---

## 8. Pull Request Reporting & Documentation Synchronization

### 8.1 PR Report Structure

Every PR that changes engine behavior, performance, or architecture must include a **PR Report** section in its description (or in a linked docs file) containing:

1. **Summary** — what changed, why, and which systems are affected.
2. **Gate status** — for each gating criterion from the spec/roadmap: PASSED / FAILED / NOT-APPLICABLE, with evidence.
3. **Performance numbers** — before/after at 1k / 10k / 50k entities, with measured p50/p99/max tick times and heap allocation deltas.
4. **Test results** — full suite counts (e.g. "22/22 green", "60/60 tests green"), including regression suites.
5. **Images / charts** — benchmark charts, Mermaid diagrams, or screenshots where performance or visual claims are made. No performance claim without a chart.
6. **Documentation sync** — list of docs files updated (ARCHITECTURE.md, DECISIONS.md, ROADMAP.md, phase reports) in the same PR.

### 8.2 Documentation Synchronization Invariant

- **Code and docs move together.** If a PR changes a system, its tick share, its port status (TS vs. native), or a feature flag, the corresponding row in `docs/ROADMAP.md` and the relevant entry in `docs/DECISIONS.md` must be updated in the same PR.
- **Never claim "landed" without verification.** Use `git merge-base --is-ancestor` + `git diff --stat` to confirm a change is actually in `main` before citing it as built. Distinguish local / tests / runtime-verified / pushed / PR / merged / accepted.
- **Pre-existing failures are documented, not inherited.** If `main` has known breakage (e.g. engine-core tsc errors), work around it and note it; never silently inherit it.

---

## 9. C++ Main Tick Migration — Remaining Phase 0 Work

The C++ Main Tick migration (Phases 1–4) is complete and merged (commit `e5f98682`, ancestor of `main`). The only defined remaining work is **Phase 0 — Baselines and the Transport Guarantee** (`docs/CPP-MAIN-TICK-SPEC.md §4`), which makes no sim changes. These four items are standing work:

1. **Re-run `bench:transport`** at 250 / 500 / 1,000 / 2,000 clients in production shape; publish the metrics doc + chart (CPU, fan-out p50/p99, RSS, both uWS and ws transports).
2. **Re-baseline the JS production tick** under the contention harness at 51k entities (mean / p99 / max, spiral-event count), same doc.
3. **Boot-time transport assertion:** the server logs and exposes which transport loaded; production mode fails loud if uWS was requested but ws silently loaded.
4. **uWS packaging decision:** vendored binary vs self-hosted artifact, so production installs cannot silently degrade to ws.

> Known environment limit: the transport test suite hangs on uWS inside Arlo's sandbox, so Phase 0 network numbers must be produced or reproduced on real hardware (Joey's Windows machine). Sandbox numbers are labeled as such wherever used.

