# @mmo-engine/addon-procgen — node-gyp build for the FastNoise2 procgen addon.
#
# The vendored FastNoise2 (+ FastSIMD) sources compile directly as node-gyp
# sources alongside the N-API shim src/procgen.cc. No CMake, no bash, no
# shell globs — only a C++17 compiler is required, so `npm install` works
# from a clean clone on Windows, macOS and Linux alike.
#
# The vendored trees are pinned (see third_party/*/VENDORING.md). If they
# are ever updated, refresh the explicit source list below.
#
# SIMD note: upstream's CMake builds a multi-ISA dispatch library
# (SSE2/AVX2/AVX512 runtime dispatch). Here we compile the baseline
# FastSIMD translation unit directly — output is bit-identical for a
# given build, just without the extra SIMD levels. See the addon README
# "Determinism" section.
{
  "targets": [
    {
      # NOTE: no "dependencies" on node-addon-api's .gyp file. That
      # dependency only pulled in a shared node_api.sln which parallel
      # node-gyp builds race over on Windows (WinError 183). The include
      # dir comes from the node -p command below; exception flags are set
      # explicitly per target.
      "target_name": "procgen",
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "FASTNOISE_STATIC_LIB",
        # FastSIMD dispatch TU defines (mirror what
        # fastsimd_create_dispatch_library() sets).
        "FASTSIMD_EXPORT",
        "FASTSIMD_LIBRARY_NAME=FastSIMD_FastNoise",
        "FASTSIMD_IS_RELAXED=1",
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/FastNoise2/include",
        "third_party/FastSIMD/include",
        "generated",
      ],
      "cflags_cc": ["-std=c++17", "-O3", "-ffast-math", "-fno-finite-math-only", "-march=haswell"],
      # node-gyp disables C++ RTTI by default (-fno-rtti); FastNoise2's
      # Metadata machinery uses dynamic_cast, so re-enable it here.
      # (Exceptions stay disabled via NAPI_DISABLE_CPP_EXCEPTIONS.)
      "cflags_cc!": ["-fno-rtti"],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-O3", "-ffast-math", "-fno-finite-math-only", "-march=haswell"],
        "GCC_ENABLE_CPP_RTTI": "YES"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          # /MP: parallelize TU compilation across cores (Windows-only;
          # msvs_settings is ignored by the make generator elsewhere).
          "MultiProcessorCompilation": "true",
          "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2", "/fp:fast", "/arch:AVX2"],
          "RuntimeTypeInfo": "true"
        }
      },
      # node-gyp's common.gypi sets RuntimeTypeInfo=false per
      # configuration, which overrides the target-level setting above for
      # Release. Without RTTI, FastNoise2's dynamic_cast in node wiring
      # (SetSource) aborts the process (0xC0000409), so re-assert it at
      # the configuration level too.
      "configurations": {
        "Release": {
          "msvs_settings": { "VCCLCompilerTool": { "RuntimeTypeInfo": "true" } }
        },
        "Debug": {
          "msvs_settings": { "VCCLCompilerTool": { "RuntimeTypeInfo": "true" } }
        }
      },
      "sources": [
        "src/procgen.cc",
        "third_party/FastNoise2/src/FastNoise/FastNoise_C.cpp",
        "third_party/FastNoise2/src/FastNoise/Metadata.cpp",
        "third_party/FastNoise2/src/FastNoise/SmartNode.cpp",
        "third_party/FastSIMD/src/FastSIMD.cpp",
        "generated/FastSIMD_FastNoise_SSE2.cpp"
      ],
    },
  ]
}
