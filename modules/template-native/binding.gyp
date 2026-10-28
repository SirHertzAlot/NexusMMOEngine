{
  "targets": [
    {
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "sources": [
        "native/addon.cc"
      ],
      "target_name": "addon"
    },
    {
      "copies": [
        {
          "destination": "<(module_root_dir)/native",
          "files": [
            "<(PRODUCT_DIR)/addon.node"
          ]
        }
      ],
      "dependencies": [
        "addon"
      ],
      "target_name": "install_addon",
      "type": "none"
    }
  ]
}
