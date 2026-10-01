# Vendoring — RecastNavigation

**Source:** https://github.com/recastnavigation/recastnavigation
**Pinned commit:** `9f4ce64458dfae86e1239c525ddc219c4e9e06f1`
("Fix crash on large-scale navmesh generation (assert triggered) (#796)",
2026-02-27) — the exact commit evaluated in
`~/workspace/mmo-engine/phase2/EVALUATION.md` §2. Do not move it without
re-running the evaluation's build + bake spike and recording the reason
in `docs/DECISIONS.md`.

**License:** zlib-style, © 2009 Mikko Mononen — verified against the
upstream `License.txt` at the pinned commit (root of the vendored tree).
Commercial-safe, no copyleft.

**Layout:** the full upstream tree is vendored under
`third_party/RecastNavigation/` (`.git` stripped), matching the Jolt
addon's full-tree convention. The build compiles only:

- `Recast/Source/*.cpp` (bake pipeline)
- `Detour/Source/*.cpp` (navmesh + queries)
- `DetourCrowd/Source/*.cpp` (crowd steering and local avoidance, since
  2026-09-30)
- `DetourTileCache/Source/*.cpp` (layer tiles and obstacles, since
  2026-09-30)

`RecastDemo`, `DebugUtils` and `Tests` are vendored but not compiled.

**Build:** no CMake. The sources compile directly as node-gyp
translation units (`binding.gyp`), so `npm install` works fully offline
from a clean clone.

## Local patches (search for `NexusMMOEngine`)

1. **`DetourTileCache/Source/DetourTileCacheBuilder.cpp`, `addUniqueLast`**
   (2026-09-30, found by `npm run valgrind:memcheck`). Upstream appends a
   region's neighbour to `neis[DT_LAYER_MAX_NEIS]` (16) with no capacity
   check, comparing only against the last entry, so a region bordering many
   others (a tile cut up by dozens of obstacles) writes past the array into
   the next region and `dtBuildTileCacheRegions` later reads out of bounds.
   Patched to skip duplicates and stop at the cap, as Recast's own layer
   builder (`RecastLayers.cpp`, `addUnique`) does; a neighbour dropped past
   the cap only means a region isn't merged with it. Unfixed upstream at
   the pinned commit (the latest, 2026-02-27); worth reporting.

Re-apply these after updating the vendored tree.
