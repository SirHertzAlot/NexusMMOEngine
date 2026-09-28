# Vendoring: Jolt Physics

- **Upstream:** https://github.com/jrouwe/JoltPhysics
- **Pinned commit:** `074b2a84ac1d90aa66ce5c294c848a94a194273e`
  (upstream HEAD as of 2026-09-26; evaluated in
  `~/workspace/mmo-engine/phase2/EVALUATION.md`)
- **License:** MIT, © 2021 Jorrit Rouwe — verified against the
  repo-root `LICENSE` file in this tree (primary source).
- **Method:** `git fetch --depth 1 origin <sha>` — single-commit shallow
  fetch. No submodules are needed for the core library.
- **Pristine:** this tree is an unmodified upstream copy. The addon's
  own build glue lives in `../cmake/` and `../native/`, never here.

## Build

Jolt builds through its own CMake (`Build/CMakeLists.txt`, included as
a subdirectory from `../cmake/CMakeLists.txt`):

- `-DCMAKE_POSITION_INDEPENDENT_CODE=ON` (required: the archives link
  into `physics.node`, a shared object; Jolt's default CMake is not PIC)
- Release; Jolt's `INTERPROCEDURAL_OPTIMIZATION=ON` default is kept, so
  the final node-gyp link must pass `-flto=auto` (slim-LTO objects)
- `CROSS_PLATFORM_DETERMINISTIC=OFF` (upstream default; see the addon
  README "Determinism" section for what is and isn't guaranteed)

To update the pin: re-fetch at the new commit, re-verify `LICENSE`,
rebuild, and re-run the determinism tests — SIMD/arch-flag changes can
alter floating-point results.
