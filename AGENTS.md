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
