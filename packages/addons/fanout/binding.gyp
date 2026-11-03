{
  "targets": [
    {
      "target_name": "fanout",
      "sources": ["src/fanout.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17", "-fno-exceptions", "-O3"],
      "xcode_settings": {
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fno-exceptions", "-O3"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "Optimization": 3, "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2"] }
      }
    }
  ]
}
