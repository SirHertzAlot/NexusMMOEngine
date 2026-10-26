{
  "targets": [
    {
      "target_name": "integrate",
      "sources": [
        "src/integrate.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fno-exceptions",
        "-O3",
        "-mavx2",
        "-mfma",
        "-mbmi",
        "-mbmi2",
        "-flto"
      ],
      "xcode_settings": {
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fno-exceptions", "-O3", "-flto"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 3,
          "FavorSizeOrSpeed": 1,
          "EnableEnhancedInstructionSet": 3,
          "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2", "/arch:AVX2"]
        }
      }
    },
    {
      "target_name": "engine_kernel",
      "sources": [
        "src/integrate.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fno-exceptions",
        "-O3",
        "-mavx2",
        "-mfma",
        "-mbmi",
        "-mbmi2",
        "-flto"
      ],
      "xcode_settings": {
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fno-exceptions", "-O3", "-flto"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 3,
          "FavorSizeOrSpeed": 1,
          "EnableEnhancedInstructionSet": 3,
          "AdditionalOptions": ["/std:c++17", "/EHsc-", "/O2", "/arch:AVX2"]
        }
      }
    }
  ]
}

