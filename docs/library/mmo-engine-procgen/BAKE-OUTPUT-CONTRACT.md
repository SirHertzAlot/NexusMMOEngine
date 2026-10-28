# Bake Output Contract (backend-agnostic baking)

**Status:** spec (2026-10-11)
**Principle:** baking lives nowhere in particular. Any system, in any language,
may bake — C++ kernel, Python tectonics lab, Node scripts, a future Rust port —
as long as its output satisfies this contract. The engine never inspects *how*
a bake was produced, only *what* it contains.

## What "three.js compatible" means concretely

A bake is a directory (or content-addressed bundle) containing:

### 1. Heightfield tiles (terrain)
- **Format:** 16×16 `TerrainTile`s — `cx, cz, heights: Float32Array(256)`,
  row-major, X inner, shared-border convention (`gx = cx*15 .. cx*15+15`).
- **Encoding on disk:** one of:
  - raw little-endian float32 (`.f32`, 1024 bytes/tile), or
  - base64 float32 in a JSON manifest (small bakes), or
  - 16-bit PNG heightmaps (large regions; see Guy-Shalev export pattern —
    8-bit is not enough, terracing on plains).
- Tiles are addressed by `"<cx>,<cz>"`; a missing tile is ungenerated void,
  never implicit flat ground.

### 2. Meshes (props, structures, baked detail)
- **Format:** glTF 2.0 / GLB — three.js loads it natively, no conversion.
- **Constraints:** the art pipeline's existing gates apply —
  `gltfpack` geometry encoding, KTX2/UASTC or WebP textures via
  `gltf-transform`, validator-clean, prototype content flagged
  `aiGenerated: true`.
- Meshes reference tiles by chunk key for placement; the engine does not
  re-derive placement.

### 3. Manifest (`bake.json`)
```json
{
  "bakeVersion": 1,
  "producer": { "name": "terrain-kernel", "lang": "c++", "version": "0.3.0" },
  "seed": "12345",
  "recipe": { "tectonics": "v2", "erosion": "multiscale-v1", "...": "..." },
  "world": { "minCx": -64, "minCz": -64, "maxCx": 63, "maxCz": 63 },
  "tiles": { "encoding": "f32", "path": "tiles/" },
  "meshes": [{ "chunk": "12,7", "path": "meshes/12,7.glb" }],
  "checksum": "sha256:..."
}
```
- `producer` is informational only — the engine never branches on it.
- `recipe` versions every stage so a bake is reproducible and diffable.
- `checksum` covers tiles + meshes; the engine verifies on import.

### 4. Vectors stay vectors
Rivers, roads, and region boundaries are emitted as **polylines**, not
rasterized pixels (Selo and Guy-Shalev both got this right). The engine
rasterizes for rendering; simulation reads the vectors.

## Validation: `bake:validate`

No bake enters the engine without passing validation:

1. **Schema:** `bake.json` parses; all required fields present; versions known.
2. **Tile integrity:** every tile is 256 finite floats (NaN only where the
   producer declares void); shared borders agree within epsilon —
   tile `(0,0)` right edge == tile `(1,0)` left edge, or the bake is corrupt.
3. **Mesh integrity:** each GLB parses, passes the art pipeline gates.
4. **Checksum:** recomputed over tiles + meshes matches the manifest.
5. **Determinism spot-check** (for producers that claim it): regenerate N
   random tiles from `(seed, recipe)`; byte-compare. Failure doesn't reject
   the bake — it marks the producer non-deterministic, and the engine
   caches its tiles instead of regenerating.

## How producers plug in

A producer implements exactly one thing: **write a directory satisfying
the contract above.** That's it. No SDK, no plugin API, no language binding.

- The **C++ kernel** bakes via `generateChunk` → tile writer.
- The **Python tectonics lab** bakes via its NumPy pipeline → tile writer.
- A **Node script** bakes via the JS fallback generator → tile writer.
- The **editor** can bake a hand-touched region and merge it into a bake.

`bake:validate` is the only gate. `bake:import` moves a validated bake into
the engine's tile store, where the 0x21 tile handler and the streaming
pipeline serve it like any other terrain.

## What the engine promises in return

- The tile format (`TerrainTile`, shared borders, 16×16) is **stable**.
  If it ever changes, `bakeVersion` bumps and old bakes keep working.
- The engine never asks a producer to regenerate; it caches validated tiles.
- Streaming, LOD, and region handoff are producer-agnostic — they operate
  on tiles, not on baker internals.

## Non-goals

- The contract does not cover *runtime* generation (that's the
  `ChunkDataSource` ABI — a separate seam for a separate job).
- The contract does not dictate *how* a producer works internally
  (erosion algorithms, noise libraries, language choice are all free).
- No bake is ever trusted without validation, regardless of producer.
