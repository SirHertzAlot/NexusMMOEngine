# third_party

Vendored binaries and headers required to build this repo from a clean
clone, so codegen and native builds are reproducible without system installs.

| Path | What | Source |
|------|------|--------|
| `flatc/flatc` | FlatBuffers compiler 25.12.19 (Linux x86_64, g++-13) | Official `google/flatbuffers` GitHub release binary (`Linux.flatc.binary.g++-13.zip`) |
| `flatc/flatc.exe` | FlatBuffers compiler 25.12.19 (Windows x64) | Same release, `Windows.flatc.binary.zip` |
| `flatc/flatc-macos` | FlatBuffers compiler 25.12.19 (macOS universal, x86_64 + arm64) | Same release, `Mac.flatc.binary.zip` |

`scripts/codegen.mjs` picks the binary for the platform it runs on and
falls back to a system `flatc` on `PATH`. All three are the same release,
so they write the same bindings (the C++ header asserts the flatc version).
