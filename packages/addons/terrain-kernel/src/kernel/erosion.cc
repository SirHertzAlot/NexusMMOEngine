// Port of terrain/erosion.ts (thermal / fluvial / droplet).
//
// Every Float32Array read is an exact float->double widening; every
// intermediate the JS keeps in a plain `let`/`const` stays a C++ double;
// every store back to a grid array rounds to float32. Plain-number
// accumulators (sum, max, moved) are doubles in both.

#include "terrain_kernel/erosion.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "terrain_kernel/grid.h"
#include "terrain_kernel/hydrology.h"
#include "terrain_kernel/rng.h"

namespace terrain_kernel {

void thermalErosion(float* h, const Grid& g, double talusDeg, int passes) {
  const int W = g.width;
  const int D = g.depth;
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  // JS: Math.tan((talusDeg * Math.PI) / 180). Verified bit-identical to
  // std::tan with the same double constant on the reference platform.
  const double t = std::tan((talusDeg * 3.141592653589793) / 180.0);
  const double SQRT2 = std::sqrt(2.0);  // == Math.SQRT2
  const double limit[2] = {t * g.cell, t * g.cell * SQRT2};

  std::vector<float> delta(N);
  std::vector<float> excess(8);
  std::vector<int32_t> nbr(8);
  for (int p = 0; p < passes; ++p) {
    std::fill(delta.begin(), delta.end(), 0.0f);
    for (int v = 1; v < D - 1; ++v) {
      for (int u = 1; u < W - 1; ++u) {
        const size_t i = idx(g, u, v);
        const double hi = fget(h, i);
        int n = 0;
        double sum = 0.0;  // plain JS number: double
        double max = 0.0;
        for (int dz = -1; dz <= 1; ++dz) {
          for (int dx = -1; dx <= 1; ++dx) {
            if (dx == 0 && dz == 0) continue;
            const size_t j = idx(g, u + dx, v + dz);
            const double e =
                hi - fget(h, j) - limit[(dx != 0 && dz != 0) ? 1 : 0];
            if (e > 0) {
              fset(excess.data(), n, e);
              nbr[n++] = static_cast<int32_t>(j);
              sum += e;
              if (e > max) max = e;
            }
          }
        }
        if (n == 0) continue;
        const double moved = 0.5 * max;
        fset(delta.data(), i, fget(delta.data(), i) - moved);
        for (int k = 0; k < n; ++k) {
          const size_t j = static_cast<size_t>(nbr[k]);
          fset(delta.data(), j,
               fget(delta.data(), j) + (moved * fget(excess.data(), k)) / sum);
        }
      }
    }
    for (size_t i = 0; i < N; ++i) fset(h, i, fget(h, i) + fget(delta.data(), i));
  }
}

double fluvialErosion(float* h, const Grid& g, double seaLevel,
                      const float* rainShare, int passes, double strength) {
  const int W = g.width;
  const int D = g.depth;
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  const double MAX_CUT_PER_PASS = 2.0;
  std::vector<float> before(N);
  for (size_t i = 0; i < N; ++i) before[i] = h[i];

  // Allocated once, reused across passes (vectors keep capacity).
  std::vector<float> filled(N);
  Drainage drain;
  std::vector<float> acc(N);
  for (int p = 0; p < passes; ++p) {
    fillDepressions(h, filled.data(), g);
    computeDrainage(filled.data(), g, &drain);
    accumulate(drain, g, rainShare, acc.data());
    for (uint32_t oi = 0; oi < N; ++oi) {
      const size_t i = drain.order[oi];
      const int32_t r = drain.receiver[i];
      if (r < 0 || fget(h, i) <= seaLevel) continue;
      const size_t ri = static_cast<size_t>(r);
      const double dist = fget(drain.distance.data(), i);
      const double drop = fget(h, i) - fget(h, ri);
      const double slope = std::max(0.0, drop) / dist;
      const double cut = std::min(
          MAX_CUT_PER_PASS,
          std::min(strength * std::sqrt(fget(acc.data(), i)) * slope,
                   std::max(0.0, drop - 0.01)));
      fset(h, i, fget(h, i) - cut);
    }
  }
  double deepest = 0.0;
  for (size_t i = 0; i < N; ++i)
    deepest = std::max(deepest, fget(before.data(), i) - fget(h, i));
  return deepest;
}

DropletStats dropletErosion(float* h, const Grid& g, double seaLevel,
                            const float* rainShare, int droplets,
                            double strength, uint64_t seed) {
  const int W = g.width;
  const int D = g.depth;
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  const double toUnits = 1.0 / g.cell;
  const double sea = seaLevel * toUnits;
  for (size_t i = 0; i < N; ++i) fset(h, i, fget(h, i) * toUnits);
  std::vector<float> before(N);
  for (size_t i = 0; i < N; ++i) before[i] = h[i];

  const double inertia = 0.05;
  const double capacityFactor = 4.0;
  const double minCapacity = 0.01;
  const double erodeSpeed = 0.3 * strength;
  const double depositSpeed = 0.3;
  const double evaporate = 0.02;
  const double gravity = 4.0;
  const int maxLife = 40;
  const int radius = 2;
  const double maxStep = 0.04;

  double maxShare = 0.0;
  for (size_t i = 0; i < N; ++i) maxShare = std::max(maxShare, fget(rainShare, i));

  // Bit-identical to mulberry32(spec.seed ^ 0xe20d): JS `^` is ToInt32.
  Mulberry32 rng(static_cast<uint32_t>(
      static_cast<int32_t>(seed & 0xffffffffull) ^ static_cast<int32_t>(0xe20du)));

  auto heightGrad = [&](double x, double z, double* out) {
    const int u = static_cast<int>(std::floor(x));
    const int v = static_cast<int>(std::floor(z));
    const double fx = x - u;
    const double fz = z - v;
    const size_t i = idx(g, u, v);
    const double nw = fget(h, i);
    const double ne = fget(h, i + 1);
    const double sw = fget(h, i + W);
    const double se = fget(h, i + W + 1);
    out[0] = nw * (1 - fx) * (1 - fz) + ne * fx * (1 - fz) + sw * (1 - fx) * fz +
             se * fx * fz;
    out[1] = (ne - nw) * (1 - fz) + (se - sw) * fz;
    out[2] = (sw - nw) * (1 - fx) + (se - ne) * fx;
  };
  auto deposit = [&](double x, double z, double amount) {
    const int u = static_cast<int>(std::floor(x));
    const int v = static_cast<int>(std::floor(z));
    const double fx = x - u;
    const double fz = z - v;
    const size_t i = idx(g, u, v);
    fset(h, i, fget(h, i) + amount * (1 - fx) * (1 - fz));
    fset(h, i + 1, fget(h, i + 1) + amount * fx * (1 - fz));
    fset(h, i + W, fget(h, i + W) + amount * (1 - fx) * fz);
    fset(h, i + W + 1, fget(h, i + W + 1) + amount * fx * fz);
  };

  int spawned = 0;
  for (int tries = 0;
       spawned < droplets && tries < droplets * 20 && maxShare > 0; ++tries) {
    double x = 1 + rng.next() * (W - 3);
    double z = 1 + rng.next() * (D - 3);
    const size_t start =
        idx(g, static_cast<int>(std::floor(x)), static_cast<int>(std::floor(z)));
    if (fget(h, start) <= sea || rng.next() * maxShare > fget(rainShare, start))
      continue;
    ++spawned;
    double dx = 0.0, dz = 0.0;
    double speed = 1.0, water = 1.0, sediment = 0.0;
    double hg[3];
    for (int life = 0; life < maxLife; ++life) {
      const int u = static_cast<int>(std::floor(x));
      const int v = static_cast<int>(std::floor(z));
      const double fx = x - u;
      const double fz = z - v;
      heightGrad(x, z, hg);
      const double height = hg[0], gx = hg[1], gz = hg[2];
      dx = dx * inertia - gx * (1 - inertia);
      dz = dz * inertia - gz * (1 - inertia);
      // Math.hypot is correctly rounded in both V8 and libm (verified).
      const double len = std::hypot(dx, dz);
      if (len < 1e-9) break;
      dx /= len;
      dz /= len;
      x += dx;
      z += dz;
      if (x < 1 || z < 1 || x >= W - 2 || z >= D - 2) break;
      heightGrad(x, z, hg);
      const double next = hg[0];
      if (next <= sea) {
        deposit(x, z, std::min(sediment, maxStep * 4));
        break;
      }
      const double deltaH = next - height;
      const double capacity =
          std::max(-deltaH * speed * water * capacityFactor, minCapacity);
      if (sediment > capacity || deltaH > 0) {
        const double amount =
            std::min(maxStep, deltaH > 0 ? std::min(deltaH, sediment)
                                         : (sediment - capacity) * depositSpeed);
        sediment -= amount;
        const size_t i = idx(g, u, v);
        fset(h, i, fget(h, i) + amount * (1 - fx) * (1 - fz));
        fset(h, i + 1, fget(h, i + 1) + amount * fx * (1 - fz));
        fset(h, i + W, fget(h, i + W) + amount * (1 - fx) * fz);
        fset(h, i + W + 1, fget(h, i + W + 1) + amount * fx * fz);
      } else {
        const double amount =
            std::min(maxStep, std::min((capacity - sediment) * erodeSpeed, -deltaH));
        double wsum = 0.0;
        for (int bz = -radius; bz <= radius; ++bz) {
          for (int bx = -radius; bx <= radius; ++bx) {
            const double w = std::max(0.0, radius - std::hypot((double)bx, (double)bz));
            if (w > 0 && u + bx > 0 && v + bz > 0 && u + bx < W - 1 && v + bz < D - 1)
              wsum += w;
          }
        }
        if (wsum > 0) {
          for (int bz = -radius; bz <= radius; ++bz) {
            for (int bx = -radius; bx <= radius; ++bx) {
              const double w = std::max(0.0, radius - std::hypot((double)bx, (double)bz));
              if (w <= 0 || u + bx <= 0 || v + bz <= 0 || u + bx >= W - 1 ||
                  v + bz >= D - 1)
                continue;
              const double take = (amount * w) / wsum;
              const size_t j = idx(g, u + bx, v + bz);
              fset(h, j, fget(h, j) - take);
              sediment += take;
            }
          }
        }
      }
      speed = std::sqrt(std::max(0.0, speed * speed + -deltaH * gravity));
      water *= 1 - evaporate;
    }
  }
  double sum = 0.0;
  double max = 0.0;
  for (size_t i = 0; i < N; ++i) {
    const double change = std::abs(fget(h, i) - fget(before.data(), i)) * g.cell;
    sum += change;
    if (change > max) max = change;
    fset(h, i, fget(h, i) * g.cell);
  }
  return DropletStats{sum / N, max};
}

}  // namespace terrain_kernel
