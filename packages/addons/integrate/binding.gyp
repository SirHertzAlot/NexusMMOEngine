{
  "targets": [
    {
      "cflags_cc": [
        "-std=c++17",
        "-fno-exceptions",
        "-O3",
        "-ffast-math",
        "-mavx2",
        "-mfma"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "sources": [
        "src/integrate.cc"
      ],
      "target_name": "integrate",
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fno-exceptions", "-O3", "-ffast-math", "-mavx2", "-mfma"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "MultiProcessorCompilation": "true",
          "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2", "/fp:fast", "/arch:AVX2"]
        }
      }
    }
  ]
}
