# @mmo-engine/addon-geometry — node-gyp build for manifold + Clipper2.
#
# No CMake: manifold's src/*.cpp and Clipper2's src/*.cpp compile directly
# alongside the N-API shim src/geometry.cc (the repo's "only a C++17
# compiler" rule for addons). Sources are listed explicitly (Windows has no
# shell globs); refresh the list when the vendored trees are updated (see
# third_party/VENDORING.md).
#
# manifold is built without TBB (MANIFOLD_PAR=-1: single-threaded) and with
# its Clipper2 cross-section backend (MANIFOLD_CROSS_SECTION). It uses C++
# exceptions internally, so they are enabled; the shim catches them and
# throws JS errors.
{
  "targets": [
    {
      "target_name": "geometry",
      "sources": [
        "src/geometry.cc",
        "third_party/Clipper2/src/clipper.engine.cpp",
        "third_party/Clipper2/src/clipper.offset.cpp",
        "third_party/Clipper2/src/clipper.rectclip.cpp",
        "third_party/Clipper2/src/clipper.triangulation.cpp",
        "third_party/manifold/src/boolean3.cpp",
        "third_party/manifold/src/boolean_result.cpp",
        "third_party/manifold/src/constructors.cpp",
        "third_party/manifold/src/cross_section/cross_section.cpp",
        "third_party/manifold/src/csg_tree.cpp",
        "third_party/manifold/src/edge_op.cpp",
        "third_party/manifold/src/execution_impl.cpp",
        "third_party/manifold/src/face_op.cpp",
        "third_party/manifold/src/impl.cpp",
        "third_party/manifold/src/manifold.cpp",
        "third_party/manifold/src/minkowski.cpp",
        "third_party/manifold/src/polygon.cpp",
        "third_party/manifold/src/properties.cpp",
        "third_party/manifold/src/quickhull.cpp",
        "third_party/manifold/src/sdf.cpp",
        "third_party/manifold/src/smoothing.cpp",
        "third_party/manifold/src/sort.cpp",
        "third_party/manifold/src/subdivision.cpp",
        "third_party/manifold/src/tree2d.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/manifold/include",
        "third_party/manifold/src",
        "third_party/Clipper2/include"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "MANIFOLD_PAR=-1",
        "MANIFOLD_CROSS_SECTION",
        "_USE_MATH_DEFINES",
        "NOMINMAX"
      ],
      "cflags_cc": ["-std=c++17", "-O3", "-ffast-math", "-fno-finite-math-only", "-march=haswell", "-fexceptions", "-w"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-O3", "-ffast-math", "-fno-finite-math-only", "-march=haswell", "-w"],
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_CPP_RTTI": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "MultiProcessorCompilation": "true",
          "AdditionalOptions": ["/std:c++17", "/EHsc", "/O2", "/fp:fast", "/arch:AVX2", "/bigobj", "/utf-8"],
          "ExceptionHandling": 1,
          "RuntimeTypeInfo": "true"
        }
      }
    }
  ]
}
