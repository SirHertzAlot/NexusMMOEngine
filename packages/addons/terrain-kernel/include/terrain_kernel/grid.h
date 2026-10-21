// Grid view + JS Float32Array arithmetic semantics.
//
// The JS reference operates on Float32Array: reads are exact (float ->
// double is lossless), arithmetic happens in double precision, and every
// store rounds to float32 (IEEE correctly-rounded). The C++ ports mirror
// this exactly: compute in double, cast to float only on store. Any
// deviation (e.g. accumulating in float) breaks bit-identity with the JS
// reference, so the pattern below is load-bearing, not stylistic.

#pragma once

#include <cstddef>
#include <cstdint>

namespace terrain_kernel {

struct Grid {
  int width;    // cells in x (u)
  int depth;    // cells in z (v)
  double cell;  // cell size, metres
};

// Exact read: float -> double is lossless.
inline double fget(const float* a, size_t i) { return static_cast<double>(a[i]); }

// Store with JS Float32Array semantics: correctly-rounded float32.
inline void fset(float* a, size_t i, double v) { a[i] = static_cast<float>(v); }

inline size_t idx(const Grid& g, int u, int v) {
  return static_cast<size_t>(v) * static_cast<size_t>(g.width) +
         static_cast<size_t>(u);
}

}  // namespace terrain_kernel
