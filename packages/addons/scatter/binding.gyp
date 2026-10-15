# @mmo-engine/addon-scatter — node-gyp build for the PCG scatter addon.
#
# Native executor for cooked scatter plans (see @mmo-engine/scatter):
# sampler -> filters/modifiers -> spawner, producing spawn records for
# one chunk. Runs at chunk-load time, never on the tick hot path.
#
# Two translation units, no vendored third-party code, no CMake/bash:
#   src/scatter_core.cc   — pure C++17 execution (no Node headers)
#   src/scatter_addon.cc  — N-API wrapper (node-addon-api)
#
# Determinism: the core must reproduce the JS reference evaluator
# (packages/scatter/src/reference.ts) bit-for-bit. All point fields are
# float32 (JS Float32Array parity), all hash math is u32, and FP
# contraction is disabled so no fused multiply-add changes rounding
# vs the JS engine:
#   gcc/clang: -ffp-contract=off
#   MSVC:      /fp:precise (explicit; it is also the default)
{
  "targets": [
    {
      # NOTE: no "dependencies" on node-addon-api's .gyp file. That
      # dependency only pulled in a shared node_api.sln which parallel
      # node-gyp builds race over on Windows (WinError 183). The include
      # dir comes from the node -p command below; exception flags are set
      # explicitly per target.
      "target_name": "scatter",
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "cflags_cc": ["-std=c++17", "-fno-exceptions", "-O3", "-ffast-math", "-mavx2", "-mfma", "-ffp-contract=off"],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-O3", "-ffast-math", "-mavx2", "-mfma", "-ffp-contract=off"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          # /MP: parallelize TU compilation across cores (Windows-only;
          # msvs_settings is ignored by the make generator elsewhere).
          "MultiProcessorCompilation": "true",
          "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2", "/fp:fast", "/arch:AVX2", "/fp:precise"]
        }
      },
      "sources": [
        "src/scatter_core.cc",
        "src/scatter_addon.cc"
      ],
    },
  ]
}
