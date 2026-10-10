# @mmo-engine/art — art bake pipeline

Bake-time asset processing: manifest validation, conversion, compression.

## Pinned tool versions (TL0, 2026-10-10)

These versions are locked for the compression pipeline (docs/THREEJS-TOOLING.md §1e). Never float on `latest`.

| Tool | Version | Source |
|---|---|---|
| gltfpack binary | v1.3 | meshoptimizer GitHub releases (zeux/meshoptimizer) |
| `@gltf-transform/cli` | 4.5.1 | npm |
| `gltfjsx` | 6.5.3 | npm (devDependency of apps/client) |
| `leva` | 0.10.1 | npm (devDependency of apps/client, DEV-only) |
| `lil-gui` | 0.21.0 | npm (devDependency of apps/editor, DEV-only) |
| `animouse` | 0.8.0 | npm (client animation state machine) |

## Pipeline order

1. **gltfpack** — geometry compression (meshopt `-cc`). Textures untouched here.
2. **gltf-transform** — `prune` + `dedup`, then texture conversion (baseColor → WebP; normal/occlusion/metallicRoughness → UASTC KTX2), then per-tier resize caps.
3. **gltfjsx** — GLB → R3F components from the compressed output.

The client wires `MeshoptDecoder` and `KTX2Loader` + Basis transcoder *before* any compressed asset ships (decoder-first ordering).
