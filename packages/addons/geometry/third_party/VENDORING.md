# Vendored geometry libraries

| Path | From | License |
|------|------|---------|
| `manifold/include/`, `manifold/src/` | github.com/elalish/manifold `v3.5.4` (`ce50d78`) | Apache-2.0, `manifold/LICENSE` |
| `Clipper2/include/`, `Clipper2/src/` | github.com/AngusJohnson/Clipper2 `Clipper2_2.0.1` (`21ebba0`), `CPP/Clipper2Lib/` | BSL-1.0, `Clipper2/LICENSE` |

Vendored 2026-09-30. Not vendored: manifold's bindings, tests, samples,
extras, CMake files and its experimental `boolean2` cross-section backend
(`src/cross_section/cross_section_boolean2.cpp`); Clipper2's other
languages, tests, examples and DLL exports.

No local patches. manifold is built as upstream's CMake would with
`MANIFOLD_CROSS_SECTION=ON` (the Clipper2 backend) and `MANIFOLD_PAR=OFF`
(no TBB): the defines `MANIFOLD_CROSS_SECTION` and `MANIFOLD_PAR=-1` in
`../binding.gyp`. Its generated `manifold/version.h` isn't used by any
vendored source, so it isn't generated.

## Updating

Replace the four directories from the new tags, drop the files listed as
not vendored, refresh the source list in `../binding.gyp` from
`manifold/src/CMakeLists.txt` (`MANIFOLD_SRCS`) and `Clipper2Lib/src/*.cpp`,
bump the version string in `../src/geometry.cc`, and run the tests.
