# NexusMMOEngine — Architecture Analysis

Generated 2026-10-01 by running the Architecture Diagram Generator's analysis
core headlessly (code scan → spec → diagrams → verification → map) against
`NexusMMOEngine @ 522c0c0` (fresh clone of `main`).

## Files

- **`arch-map.html`** — the interactive architecture map. Open in any browser
  (self-contained, no server needed). Search, drill into containers, click
  nodes for details, filter by edge type.
- **`ARCHITECTURE.md`** — the 8-diagram documentation set (flowchart, sequence,
  class, ER, state, C4 context, C4 container, deployment) as Mermaid.
- **`arch-diagrams.json`** — the spec all diagrams generate from. Edit this and
  re-render to update the docs deterministically.
- **`code-findings.json`** — 149 raw findings from the code scan
  (114 classes, 29 components, 6 HTTP routes). Excludes `third_party`,
  `node_modules`, build output.
- **`verification.json`** — 40/50 documented names verified against code
  (0.8). The 10 unverified are the authored C4 containers/deployment nodes,
  which are architecture-level concepts, not code classes.

## How it was built

`~/workspace/mmo-engine/arch-analysis/` holds the headless driver:
`shim/` (a minimal `vscode` stub) + `driver.cjs`, driving the extension's
compiled `verifier`, `spec`, and `archMap` modules. Re-run any time with:

```
node -r ./shim/register.cjs driver.cjs <repoRoot> <outDir>
```

## Notes / limitations

- The extension's route regex also matches non-HTTP `.get(`/`.post(` calls
  (e.g. `Map.get`); the driver filters to paths starting with `/`.
- Class relations in the class diagram are not yet derived from imports —
  the map's parent-assignment (file → container) covers the structure.
- Behavioral diagrams (sequence, flowchart, state) were authored from the
  repo's docs and CLAUDE.md, then verified; structural diagrams derive
  directly from the scan.
