// Kernel-internal hydrology: depression filling + drainage + accumulation.
//
// Ports of `fillDepressions`, `drainage`, `accumulate` from
// packages/engine-core/src/terrain/hydrology.ts. The kernel cannot call
// back into JS per cell, so it carries its own copies (behavioral parity
// with the JS reference is the acceptance bar; the JS originals stay the
// survey's authoritative water-map path).

#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "terrain_kernel/grid.h"

namespace terrain_kernel {

// Priority-flood depression filling (Barnes, Lehman & Mulla 2014).
// `filled` (size W*D) receives the filled surface.
void fillDepressions(const float* h, float* filled, const Grid& g);

struct Drainage {
  std::vector<int32_t> receiver;    // steepest-descent neighbour, -1 = none
  std::vector<float> distance;      // metres to receiver
  std::vector<uint32_t> order;      // cell indices, high to low
};

// Steepest-descent receivers + high-to-low order over a filled surface.
void computeDrainage(const float* surface, const Grid& g, Drainage* out);

// Upstream area (m^2) per cell. `weight` may be null for uniform weight 1.
void accumulate(const Drainage& d, const Grid& g, const float* weight,
                float* acc);

}  // namespace terrain_kernel
