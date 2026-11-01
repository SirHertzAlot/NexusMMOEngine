# @mmo-engine/addon-picg — node-gyp build for PICG's pcg-core.
#
# PICG (github.com/DJ-Huang/PCG-AI, Apache-2.0) is the engine's asset
# generator: `.pcg` node graphs cooked into procedural meshes. Its C++17
# core is vendored under third_party/pcg-core (pinned, see VENDORING.md)
# and compiles here as plain node-gyp sources next to the N-API shim
# src/picg_addon.cc. No CMake: only a C++17 compiler, like every other
# addon. Upstream's Assimp dependency (mesh-file import) is compiled out
# (PCG_WITH_ASSIMP=0); graphs that import mesh files report it at cook.
#
# pcg-core uses C++ exceptions and RTTI internally; both stay on for this
# target (the N-API shim itself never throws: NAPI_DISABLE_CPP_EXCEPTIONS).
{
  "targets": [
    {
      "target_name": "picg",
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "PCG_STATIC",
        "PCG_WITH_ASSIMP=0",
        "_USE_MATH_DEFINES",
        "NOMINMAX"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/pcg-core/include",
        "third_party/pcg-core/src",
        "third_party/CDT/include",
        "third_party/nlohmann",
        "third_party/meshoptimizer/src",
        "generated"
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
      },
      "configurations": {
        "Release": {
          "msvs_settings": { "VCCLCompilerTool": { "RuntimeTypeInfo": "true", "ExceptionHandling": 1 } }
        }
      },
      "sources": [
        "src/picg_addon.cc",
        "src/mesh_optimize.cc",
        "third_party/meshoptimizer/src/allocator.cpp",
        "third_party/meshoptimizer/src/clusterizer.cpp",
        "third_party/meshoptimizer/src/indexanalyzer.cpp",
        "third_party/meshoptimizer/src/indexcodec.cpp",
        "third_party/meshoptimizer/src/indexgenerator.cpp",
        "third_party/meshoptimizer/src/meshletcodec.cpp",
        "third_party/meshoptimizer/src/meshletutils.cpp",
        "third_party/meshoptimizer/src/opacitymap.cpp",
        "third_party/meshoptimizer/src/overdrawoptimizer.cpp",
        "third_party/meshoptimizer/src/partition.cpp",
        "third_party/meshoptimizer/src/quantization.cpp",
        "third_party/meshoptimizer/src/rasterizer.cpp",
        "third_party/meshoptimizer/src/remesher.cpp",
        "third_party/meshoptimizer/src/simplifier.cpp",
        "third_party/meshoptimizer/src/spatialorder.cpp",
        "third_party/meshoptimizer/src/stripifier.cpp",
        "third_party/meshoptimizer/src/tangentspace.cpp",
        "third_party/meshoptimizer/src/vcacheoptimizer.cpp",
        "third_party/meshoptimizer/src/vertexcodec.cpp",
        "third_party/meshoptimizer/src/vertexfilter.cpp",
        "third_party/meshoptimizer/src/vfetchoptimizer.cpp",
        "third_party/pcg-core/src/asset_path.cpp",
        "third_party/pcg-core/src/cook_hash.cpp",
        "third_party/pcg-core/src/data/pcg_attribute_table.cpp",
        "third_party/pcg-core/src/data/pcg_data_collection.cpp",
        "third_party/pcg-core/src/data/pcg_geometry.cpp",
        "third_party/pcg-core/src/data/pcg_geometry_binary.cpp",
        "third_party/pcg-core/src/data/pcg_heightfield.cpp",
        "third_party/pcg-core/src/data/pcg_heightfield_binary.cpp",
        "third_party/pcg-core/src/data/pcg_mesh_binary.cpp",
        "third_party/pcg-core/src/data/pcg_mesh_data.cpp",
        "third_party/pcg-core/src/data/pcg_metadata.cpp",
        "third_party/pcg-core/src/data/pcg_param_data.cpp",
        "third_party/pcg-core/src/data/pcg_point_binary.cpp",
        "third_party/pcg-core/src/data/pcg_point_data.cpp",
        "third_party/pcg-core/src/data/pcg_spline_data.cpp",
        "third_party/pcg-core/src/data/pcg_texture_data.cpp",
        "third_party/pcg-core/src/elements/add_algorithms.cpp",
        "third_party/pcg-core/src/elements/add_elements.cpp",
        "third_party/pcg-core/src/elements/assembly_algorithms.cpp",
        "third_party/pcg-core/src/elements/assembly_elements.cpp",
        "third_party/pcg-core/src/elements/attribute_algorithms.cpp",
        "third_party/pcg-core/src/elements/attribute_elements.cpp",
        "third_party/pcg-core/src/elements/bevel_blender.cpp",
        "third_party/pcg-core/src/elements/bevel_diag.cpp",
        "third_party/pcg-core/src/elements/boolean_elements.cpp",
        "third_party/pcg-core/src/elements/building_algorithms.cpp",
        "third_party/pcg-core/src/elements/building_elements.cpp",
        "third_party/pcg-core/src/elements/color_ramp.cpp",
        "third_party/pcg-core/src/elements/delete_algorithms.cpp",
        "third_party/pcg-core/src/elements/element_registry.cpp",
        "third_party/pcg-core/src/elements/element_utils.cpp",
        "third_party/pcg-core/src/elements/expression.cpp",
        "third_party/pcg-core/src/elements/facade_foundation_algorithms.cpp",
        "third_party/pcg-core/src/elements/facade_foundation_elements.cpp",
        "third_party/pcg-core/src/elements/geometry_algorithms.cpp",
        "third_party/pcg-core/src/elements/geometry_elements.cpp",
        "third_party/pcg-core/src/elements/heightfield_algorithms.cpp",
        "third_party/pcg-core/src/elements/heightfield_algorithms_l3.cpp",
        "third_party/pcg-core/src/elements/heightfield_elements.cpp",
        "third_party/pcg-core/src/elements/houdini_sop_elements.cpp",
        "third_party/pcg-core/src/elements/lot_subdivision_algorithms.cpp",
        "third_party/pcg-core/src/elements/material_algorithms.cpp",
        "third_party/pcg-core/src/elements/material_elements.cpp",
        "third_party/pcg-core/src/elements/mesh_algorithms.cpp",
        "third_party/pcg-core/src/elements/mesh_elements.cpp",
        "third_party/pcg-core/src/elements/mesh_scatter_algorithms.cpp",
        "third_party/pcg-core/src/elements/mesh_scatter_elements.cpp",
        "third_party/pcg-core/src/elements/node_contracts.cpp",
        "third_party/pcg-core/src/elements/oriented_sdf_surface.cpp",
        "third_party/pcg-core/src/elements/primitive_elements.cpp",
        "third_party/pcg-core/src/elements/spline_algorithms.cpp",
        "third_party/pcg-core/src/elements/spline_elements.cpp",
        "third_party/pcg-core/src/elements/spline_mesh_elements.cpp",
        "third_party/pcg-core/src/elements/structural_algorithms.cpp",
        "third_party/pcg-core/src/elements/structural_elements.cpp",
        "third_party/pcg-core/src/elements/topology_parity_algorithms.cpp",
        "third_party/pcg-core/src/elements/topology_parity_elements.cpp",
        "third_party/pcg-core/src/elements/transform_algorithms.cpp",
        "third_party/pcg-core/src/elements/uv_algorithms.cpp",
        "third_party/pcg-core/src/elements/uv_elements.cpp",
        "third_party/pcg-core/src/elements/vehicle_modeling_algorithms.cpp",
        "third_party/pcg-core/src/elements/vehicle_modeling_elements.cpp",
        "third_party/pcg-core/src/geometry/arrangement.cpp",
        "third_party/pcg-core/src/geometry/bmesh.cpp",
        "third_party/pcg-core/src/geometry/boolean_csg.cpp",
        "third_party/pcg-core/src/geometry/boolean_output.cpp",
        "third_party/pcg-core/src/geometry/bvh.cpp",
        "third_party/pcg-core/src/geometry/coplanar_partition.cpp",
        "third_party/pcg-core/src/geometry/element_pattern.cpp",
        "third_party/pcg-core/src/geometry/group_table.cpp",
        "third_party/pcg-core/src/geometry/imesh.cpp",
        "third_party/pcg-core/src/geometry/mesh_topology.cpp",
        "third_party/pcg-core/src/geometry/robust_predicates.cpp",
        "third_party/pcg-core/src/geometry/spline_geometry.cpp",
        "third_party/pcg-core/src/geometry/sweep_geometry.cpp",
        "third_party/pcg-core/src/geometry/tri_split.cpp",
        "third_party/pcg-core/src/graph_cook_cache.cpp",
        "third_party/pcg-core/src/graph_executor.cpp",
        "third_party/pcg-core/src/graph_parser.cpp",
        "third_party/pcg-core/src/heightfield_runtime.cpp",
        "third_party/pcg-core/src/mesh_runtime.cpp",
        "third_party/pcg-core/src/pcg_core.cpp",
        "third_party/pcg-core/src/spline_runtime.cpp",
        "third_party/pcg-core/src/texture_runtime.cpp"
      ]
    }
  ]
}
