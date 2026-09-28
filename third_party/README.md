# third_party

Vendored binaries and headers required to build this repo from a clean
clone, so codegen and native builds are reproducible without system installs.

| Path | What | Source |
|------|------|--------|
| `flatc/flatc` | FlatBuffers compiler 25.12.19 (Linux x86_64, g++-13) | Official `google/flatbuffers` GitHub release binary |

`scripts/codegen.sh` prefers this binary and falls back to a system `flatc`
on `PATH` if present.
