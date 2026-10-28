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

