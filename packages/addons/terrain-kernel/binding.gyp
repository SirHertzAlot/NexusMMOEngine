# @mmo-engine/addon-terrain-kernel — node-gyp build for the grid-level
# terrain kernel (P2-P4).
#
# Unlike addon-procgen this package vendors NO third-party sources: the
# kernel is pure C++17 over node-addon-api, so `npm install` builds in
# seconds. The algorithm translation units carry no N-API types, which
# keeps a future wasm32 reference build (P6) mechanical.
{
  "targets": [
    {
      "target_name": "terrain_kernel",
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include",
      ],
      "cflags_cc": ["-std=c++17", "-O3", "-Wall", "-Wextra"],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-O3", "-Wall", "-Wextra"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "MultiProcessorCompilation": "true",
          "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2", "/W4"],
        }
      },
      "sources": [
        "src/terrain_kernel.cc",
        "src/kernel/hydrology.cc",
        "src/kernel/erosion.cc",
        "src/kernel/tectonics.cc",
      ],
    },
  ]
}
