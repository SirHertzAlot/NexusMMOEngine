// Erosion operators: ports of terrain/erosion.ts.
//
// thermalErosion / fluvialErosion / dropletErosion. The JS reference is
// the tuned, authoritative implementation; this port exists for bake
// speed and heightfield determinism. Behavioral parity (bit-identical on
// fixed seeds) is the acceptance bar — see grid.h for the float-semantics
// discipline that makes it hold.

#pragma once

#include <cstddef>
#include <cstdint>

#include "terrain_kernel/grid.h"

namespace terrain_kernel {

// Collapse slopes steeper than talusDeg, `passes` times. In place.
void thermalErosion(float* h, const Grid& g, double talusDeg, int passes);

// Stream-power incision. In place. Returns deepest cut, metres.
double fluvialErosion(float* h, const Grid& g, double seaLevel,
                      const float* rainShare, int passes, double strength);

struct DropletStats {
  double meanM;
  double maxM;
};

// Beyer-method droplet weathering. In place. `seed` is the u64 world seed;
// the droplet RNG is mulberry32((int32)seed ^ 0xe20d), bit-identical to
// the JS call `mulberry32(spec.seed ^ 0xe20d)`.
DropletStats dropletErosion(float* h, const Grid& g, double seaLevel,
                            const float* rainShare, int droplets,
                            double strength, uint64_t seed);

}  // namespace terrain_kernel
