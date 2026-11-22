# Nexus MMO Engine — Workspace Agent Guidelines & Invariants

This document establishes mandatory architectural rules, documentation conventions, and rendering constraints for all AI coding assistants operating within this repository.

---

## 1. Documentation Policy

- **The documentation set under `docs/` is written for people building a
  game on this engine.** Keep it focused on what the engine is, what it can
  do, how to start, the architecture a user must understand, the extension
  points, and directive guidance on getting the most out of it.
- **No planning artefacts in `docs/`.** Phase reports, sprint notes, audits,
  handoffs, spikes, build plans and "we decided X on date Y" write-ups do not
  belong there. Git history keeps them; the documentation set is not an
  archive. The exceptions are `ROADMAP.md` (the live task board) and
  `DECISIONS.md` (the rationale record contributors are pointed at).
- **No competitive comparisons.** Do not add benchmark shootouts against
  other engines, SWOT analyses or disparaging commentary. `PERFORMANCE.md`
  reports what *this* engine costs and says plainly where a number is a miss.
- **`docs/internals/` is for subsystem design references that source code
  points at by path.** It is engineering notes, not part of the user
  documentation set, and it is not listed in `docs/README.md`.
- **Docs follow the code, and flag the gaps.** Where a documented capability
  is not wired up, say so in the doc rather than describing the intent as if
  it were the behaviour.
- Run `python3 scripts/docs-audit.py` before opening a documentation change:
  it checks links, repository paths, `MMO_*` variables, npm scripts, packages
  and protocol codes against the code.

---

## 2. Mermaid Diagram Invariants

The rendering pipeline strictly supports standard Mermaid diagram headers. Unsupported or experimental diagram types crash the documentation renderer:
- **SUPPORTED:** `flowchart TD`, `flowchart LR`, `graph TD`, `graph LR`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`, `xychart-beta`, `pie`.
- **FORBIDDEN:** Never use `quadrantChart`, `gantt`, `gitGraph`, or other experimental headers.
- **Alternative for Quadrant / Comparative Grids:** Use `flowchart TD` with categorized subgraphs or formatted Markdown comparison tables.
- **Node Label Quoting:** Always quote node labels containing special characters: `id["Label (Extra Info)"]`. Avoid raw HTML inside node labels.

---


## 3. Native C++ Addon Memory Boundaries ("The Marshalling Trap")

- **Zero Object Traversal on Hot Paths:** Never cross the N-API boundary per-object or inspect individual JavaScript object properties (`obj.Get()`) inside simulation loops.
- **Bulk Memory Crossing:** Pass contiguous `SharedArrayBuffer` or `TypedArray` views across N-API once per tick, acquiring raw memory pointers via `napi_get_typedarray_info`.
- **Structure-of-Arrays (SoA):** Maintain contiguous typed-array component storage to allow vectorized C++ AVX2 execution with zero garbage collection allocations.

---

## 4. Development & Git Workflow Invariants

- **Standing Rule on Branches:** All feature work stays on local feature branches (`feat/*`). Never push, open PRs, or merge to main without explicit user authorization.
- **Universal SI Metric Scale:** All physical and procedural dimensions strictly adhere to SI units ($1.0\text{ unit} = 1.0\text{ meter}$).
- **Security Perimeter:** Memory-unsafe C++ code must NEVER parse untrusted network input directly; the Node.js Gateway must validate every byte before simulation ingestion.

---

## 5. SharedArrayBuffer & Sacred Hot-Path Producer Invariants ("The V8 Allocation Trap")

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

## 6. Report Generation & Performance Telemetry Standards

Every performance-affecting change must ship a metrics report in `docs/` alongside the code. Reports are not optional decoration — they are the gate evidence.

### 6.1 Required Report Contents

| Element | Requirement |
|---|---|
| **Measured vs. modeled** | Every number tagged `[measured]` (produced by a bench on this project) or `[modeled]` (estimate with stated assumptions). Modeled numbers must be replaced by measurement at the phase gate. |
| **Measurement environment** | OS, CPU, Node version, build configuration, sandbox vs. real hardware. Sandbox numbers are labeled as such wherever used. |
| **Methodology** | Warm-up iterations, sample count, what was included/excluded (e.g. "sim passes only — no physics, no network"). |
| **Caveats** | Honest statement of what the number does and does not bound (e.g. "one pass, not a tick"). |
| **Gate verification table** | Columns: Telemetry Metric \| Measured Value \| Gate Requirement \| Gate Status (PASS/FAIL/MET). |

### 6.2 Chart & Diagram Standards

- Use only Mermaid diagram types supported by the renderer (see Section 2): `flowchart TD/LR`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`, `xychart-beta`, `pie`.
- `xychart-beta` for latency/throughput bar charts (e.g. p50/p95/p99 vs. budget).
- Never use `quadrantChart`, `gantt`, `gitGraph`, or other experimental headers.
- Embed images only where they add decision-relevant evidence (benchmark comparisons, determinism overlays, crash-drill timelines). Every image must have a caption and an alt-text description.

### 6.3 Where Evidence Lives

- **Benchmark numbers that a user needs belong in `docs/PERFORMANCE.md`**,
  with the date, the hardware and the command to reproduce them. Do not add
  a per-phase report file to `docs/`; put the narrative in the PR body, where
  it is reviewed and then archived by git.
- Machine-readable results stay beside the harness that wrote them
  (`docs/*-results.json`, `perf/callgrind-baseline.json`,
  `apps/client/scripts/physics-bench-results.json`).
- Screenshots, GIFs and charts go in the PR, not in the repository: captures
  of the running client may contain licensed art.

---

## 7. Pull Request Reporting & Documentation Synchronization

### 7.1 PR Report Structure

Every PR that changes engine behavior, performance, or architecture must include a **PR Report** section in its description (or in a linked docs file) containing:

1. **Summary** — what changed, why, and which systems are affected.
2. **Gate status** — for each gating criterion from the spec/roadmap: PASSED / FAILED / NOT-APPLICABLE, with evidence.
3. **Performance numbers** — before/after at 1k / 10k / 50k entities, with measured p50/p99/max tick times and heap allocation deltas.
4. **Test results** — full suite counts (e.g. "22/22 green", "60/60 tests green"), including regression suites.
5. **Images / charts** — benchmark charts, Mermaid diagrams, or screenshots where performance or visual claims are made. No performance claim without a chart.
6. **Documentation sync** — list of docs files updated (`ROADMAP.md` always, plus `ARCHITECTURE.md`, `CAPABILITIES.md`, `PERFORMANCE.md`, `CONFIGURATION.md`, `DECISIONS.md` as the change touches them) in the same PR.

### 7.2 Documentation Synchronization Invariant

- **Code and docs move together.** If a PR changes a system, its tick share, its port status (TS vs. native), or a feature flag, the corresponding row in `docs/ROADMAP.md` and the relevant entry in `docs/DECISIONS.md` must be updated in the same PR. If it changes what a user can do or what a user must know, the user-facing doc for that area changes too.
- **Never claim "landed" without verification.** Use `git merge-base --is-ancestor` + `git diff --stat` to confirm a change is actually in `main` before citing it as built. Distinguish local / tests / runtime-verified / pushed / PR / merged / accepted.
- **Pre-existing failures are documented, not inherited.** If `main` has known breakage (e.g. engine-core tsc errors), work around it and note it; never silently inherit it.

---
