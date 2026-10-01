# @mmo-engine/addon-perf-probe: callgrind start/stop marks for JS workloads.
# valgrind.h and callgrind.h are vendored (BSD-style licence, meant to be
# copied into programs), so the build needs no valgrind headers installed.
{
  "targets": [
    {
      "target_name": "perf_probe",
      "sources": ["src/probe.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17", "-O2"],
      "xcode_settings": { "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-O2"], "MACOSX_DEPLOYMENT_TARGET": "10.15" },
      "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17"] } }
    }
  ]
}
