# @mmo-engine/addon-navigation — node-gyp build for the Recast/Detour addon.
#
# No CMake needed (per the Phase 2 evaluation spike): Recast/Source/*.cpp
# and Detour/Source/*.cpp compile directly as node-gyp sources alongside
# the N-API shim src/navigation.cc. The vendored tree is pinned; see
# VENDORING.md. `npm install` builds fully offline.
#
# Sources are listed explicitly (not via shell globs) so the build works
# on Windows (cmd.exe has no `ls`). If the vendored tree is ever updated,
# refresh this list to match Recast/Source/*.cpp + Detour/Source/*.cpp.
#
# Boundary shape (bulk, SoA, DOD):
# - bakeTile(opts, vertices, indices) -> { blob, stats }: runs the
#   canonical Recast bake pipeline (heightfield -> rasterize -> filters ->
#   regions -> contours -> polymesh -> detail -> dtCreateNavMeshData)
#   synchronously and returns the tile blob. Bake happens at
#   chunk-gen/load time, never per tick.
# - loadTiles(blobs[]) / unloadTiles(refs[]): tile blobs are added to the
#   dtNavMesh with zero copies — the Node Buffers are kept alive natively
#   (flags=0 on addTile, Buffer references held per tileRef) instead of
#   DT_TILE_FREE_DATA, which would free() Buffer memory.
# - findPaths(batch, arena): one N-API call moves N path requests; results
#   are written into caller-allocated output arenas. No per-entity N-API
#   in the hot loop.
# - All native ops run on the JS thread; the addon never spawns its own
#   JS-visible threads.
{
  "targets": [
    {
      "target_name": "navigation",
      "sources": [
        "src/navigation.cc",
        "third_party/RecastNavigation/Recast/Source/Recast.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastAlloc.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastArea.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastAssert.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastContour.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastFilter.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastLayers.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastMesh.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastMeshDetail.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastRasterization.cpp",
        "third_party/RecastNavigation/Recast/Source/RecastRegion.cpp",
        "third_party/RecastNavigation/Detour/Source/DetourAlloc.cpp",
        "third_party/RecastNavigation/Detour/Source/DetourAssert.cpp",
        "third_party/RecastNavigation/Detour/Source/DetourCommon.cpp",
        "third_party/RecastNavigation/Detour/Source/DetourNavMesh.cpp",
        "third_party/RecastNavigation/Detour/Source/DetourNavMeshBuilder.cpp",
        "third_party/RecastNavigation/Detour/Source/DetourNavMeshQuery.cpp",
        "third_party/RecastNavigation/Detour/Source/DetourNode.cpp",
        "third_party/RecastNavigation/DetourCrowd/Source/DetourCrowd.cpp",
        "third_party/RecastNavigation/DetourCrowd/Source/DetourLocalBoundary.cpp",
        "third_party/RecastNavigation/DetourCrowd/Source/DetourObstacleAvoidance.cpp",
        "third_party/RecastNavigation/DetourCrowd/Source/DetourPathCorridor.cpp",
        "third_party/RecastNavigation/DetourCrowd/Source/DetourPathQueue.cpp",
        "third_party/RecastNavigation/DetourCrowd/Source/DetourProximityGrid.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/RecastNavigation/Recast/Include",
        "third_party/RecastNavigation/Detour/Include",
        "third_party/RecastNavigation/DetourCrowd/Include"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17", "-fno-exceptions", "-O3"],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fno-exceptions", "-O3"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          # /MP: parallelize TU compilation across cores (Windows-only;
          # msvs_settings is ignored by the make generator elsewhere).
          "MultiProcessorCompilation": "true",
          "AdditionalOptions": ["/std:c++17", "/EHsc-"]
        }
      }
    }
  ]
}
