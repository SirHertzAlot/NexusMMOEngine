// SSE2 dispatch translation unit for FastNoise2's FastSIMD usage.
//
// Replicates what FastSIMD's fastsimd_create_dispatch_library() CMake
// function generates (see dispatch/cmake/feature_set_source.cpp.in):
// one TU per ISA feature set, compiled with that ISA's flags, which
// instantiates the SIMD-specialized noise classes and registers them in
// the runtime dispatch table.
//
// Only the SSE2 baseline is provided here. It is correct on every x86-64
// CPU (SSE2 is the x86-64 baseline ISA); the runtime CPUID dispatch
// simply finds no higher ISA in the table. If profiling shows chunk
// generation is hot, add AVX2/AVX512 TUs following this pattern with the
// matching /arch or -m flags in binding.gyp.
#define FASTSIMD_MAX_FEATURE_SET SSE2
#include <FastSIMD/Utility/ArchDetect.h>

#include <FastSIMD/FastSIMD_FastNoise_config.h>

#include "../third_party/FastSIMD/dispatch/impl/DispatchClassImpl.h"
#include "../third_party/FastNoise2/src/FastNoise/FastSIMD_Build.inl"
