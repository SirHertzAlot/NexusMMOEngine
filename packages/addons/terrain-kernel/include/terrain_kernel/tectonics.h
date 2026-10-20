// Tectonic macro stage: Voronoi plates -> uplift / strain fields.
//
// There is no JS equivalent: today ranges are placed by wind
// (`placeRanges` in terrain/landmass.ts). This stage simulates a plate
// mosaic instead: N plates with seeded positions and velocities, Voronoi
// assignment per cell, and boundary classification from the plates'
// relative velocity along the boundary normal:
//
//   convergent (moving together) -> uplift ridge (mountain range)
//   divergent (moving apart)      -> subsidence trough (rift valley)
//   transform (sliding past)      -> strain, no vertical motion
//
// Outputs are conditioning fields for the noise stage: uplift in metres,
// strain in [0, 1]. The survey substitutes uplift for `rangeUplift`
// behind a flag.
//
// Determinism: plate layout comes from SplitMix64 (documented in
// rng.h); all field math uses only IEEE correctly-rounded ops
// (add/sub/mul/div/sqrt/hypot) — no transcendentals, so the fields are
// bit-identical across platforms and compilers. Nearest-plate ties break
// toward the lower plate index.

#pragma once

#include <cstdint>

#include "terrain_kernel/grid.h"

namespace terrain_kernel {

struct TectonicParams {
  uint64_t seed = 0;
  int plateCount = 12;       // >= 2
  double maxUpliftM = 600.0; // uplift at a fully convergent boundary
  double riftDepthM = 250.0;  // subsidence at a fully divergent boundary
  double boundaryWidthM = 120000.0;  // half-width of the boundary influence zone
};

// uplift, strain: W*D float32 outputs (metres, 0..1).
void computeTectonics(const TectonicParams& params, const Grid& g,
                      float* uplift, float* strain);

}  // namespace terrain_kernel
