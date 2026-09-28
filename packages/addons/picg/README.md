# `@mmo-engine/addon-picg` — PICG graph cooking

The engine's procedural asset generator. [PICG](https://github.com/DJ-Huang/PCG-AI)
(PCG-AI, Apache-2.0) authors assets as `.pcg` node graphs — primitives,
splines, Booleans, bevels, UVs, materials, subgraphs — and its C++17 core
cooks a graph plus a seed into geometry. This addon builds that core
(vendored, see `third_party/VENDORING.md`) with node-gyp and exposes it to
the region server.

```js
const picg = require("@mmo-engine/addon-picg");
picg.version();                        // "pcg-core 0.1.2 (…)"
picg.validate(graph);                  // null, or pcg-core's error message
const r = await picg.cook(graph, 1234);
// r.kind === "mesh": r.mesh is a PCGM ArrayBuffer (positions, indices,
//   optional normals / colours / UVs / material slots — see pcg_api.h),
//   r.vertexCount, r.indexCount
// r.kind === "json": points / splines / heightfield diagnostics as JSON
```

- **Off the tick thread.** Cooks run on the libuv thread pool; a small
  asset takes milliseconds, a whole procedural city ~10 s.
- **One at a time.** pcg-core keeps process-global state (cook cache,
  cancel flag); `cook` queues calls and resolves them in order.
- **Deterministic.** Same graph, same seed, same bytes.
- **Flattened graphs.** Graphs that link `.pcgsubgraph` assets
  (`SubgraphAsset` nodes, graph v3) must be resolved by the host first
  (`@mmo-engine/picg`); embedded subgraphs cook as they are.
- **No mesh-file import.** Assimp is compiled out; `ImportMesh` fails the
  cook with a clear message.

Build: `npm install` (node-gyp, a C++17 compiler; ~1.5 min on 8 cores).
Test: `npm run test:addon-picg` from the repo root.
