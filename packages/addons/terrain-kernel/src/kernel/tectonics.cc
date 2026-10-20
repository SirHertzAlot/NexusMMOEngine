// Voronoi plate tectonics -> uplift / strain fields.

#include "terrain_kernel/tectonics.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

#include "terrain_kernel/grid.h"
#include "terrain_kernel/rng.h"

namespace terrain_kernel {

namespace {

struct Plate {
  double x;   // centre, cell units
  double z;
  double vx;  // velocity, abstract units (|v| in [0.5, 1])
  double vz;
};

}  // namespace

void computeTectonics(const TectonicParams& params, const Grid& g,
                      float* uplift, float* strain) {
  const int W = g.width;
  const int D = g.depth;
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  const int P = params.plateCount;

  // Seeded plate mosaic: uniform centres, random directions.
  SplitMix64 rng(params.seed);
  std::vector<Plate> plates;
  plates.reserve(static_cast<size_t>(P));
  for (int i = 0; i < P; ++i) {
    const double x = rng.next() * W;
    const double z = rng.next() * D;
    double vx = rng.next() * 2.0 - 1.0;
    double vz = rng.next() * 2.0 - 1.0;
    double len = std::hypot(vx, vz);
    if (len < 1e-9) {
      vx = 1.0;
      vz = 0.0;
      len = 1.0;
    }
    const double speed = 0.5 + 0.5 * rng.next();
    plates.push_back({x, z, (vx / len) * speed, (vz / len) * speed});
  }

  const double wCells = params.boundaryWidthM / g.cell;
  for (size_t i = 0; i < N; ++i) {
    fset(uplift, i, 0.0);
    fset(strain, i, 0.0);
  }

  for (int v = 0; v < D; ++v) {
    for (int u = 0; u < W; ++u) {
      const double px = u + 0.5;
      const double pz = v + 0.5;
      // Two nearest plates (squared distances; ties -> lower index).
      int b1 = 0, b2 = 1;
      double d1 = -1.0, d2 = -1.0;
      for (int p = 0; p < P; ++p) {
        const double dx = px - plates[p].x;
        const double dz = pz - plates[p].z;
        const double d = dx * dx + dz * dz;
        if (d1 < 0 || d < d1 || (d == d1 && p < b1)) {
          d2 = d1;
          b2 = b1;
          d1 = d;
          b1 = p;
        } else if (d2 < 0 || d < d2 || (d == d2 && p < b2)) {
          d2 = d;
          b2 = p;
        }
      }
      // Distance to the Voronoi edge along the bisector ~= (d2 - d1) / 2.
      const double edgeDist = (std::sqrt(d2) - std::sqrt(d1)) * 0.5;
      const double t = edgeDist / wCells;
      if (t >= 1.0) continue;  // outside the boundary influence zone
      // Polynomial falloff (1 - t^2)^2: no transcendentals.
      double prox = 1.0 - t * t;
      prox *= prox;

      // Boundary normal: from plate 1's centre toward plate 2's.
      double nx = plates[b2].x - plates[b1].x;
      double nz = plates[b2].z - plates[b1].z;
      const double nlen = std::hypot(nx, nz);
      if (nlen < 1e-9) continue;
      nx /= nlen;
      nz /= nlen;
      // Relative velocity of plate 2 wrt plate 1 along the normal.
      // vn < 0: converging; vn > 0: diverging; |vn| ~ 0: transform.
      const double vn = (plates[b2].vx - plates[b1].vx) * nx +
                        (plates[b2].vz - plates[b1].vz) * nz;
      const double avn = std::abs(vn);
      const double intensity = avn > 1.0 ? 1.0 : avn;  // |v| <= 1 by construction
      const size_t i = idx(g, u, v);
      if (vn < 0.0) {
        fset(uplift, i, params.maxUpliftM * prox * intensity);
      } else if (vn > 0.0) {
        fset(uplift, i, -params.riftDepthM * prox * intensity);
      }
      fset(strain, i, prox * intensity);
    }
  }
}

}  // namespace terrain_kernel
