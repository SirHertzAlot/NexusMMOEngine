{
  "targets": [
    {
      "cflags_cc": [
        "-O3"
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
      "target_name": "integrate"
    }
  ]
}
