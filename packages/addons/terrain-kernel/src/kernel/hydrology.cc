// Port of hydrology.ts: fillDepressions / drainage / accumulate.
//
// Float-semantics note: the JS reference stores every intermediate array
// in Float32Array. This port computes in double and rounds to float32 on
// store (see grid.h), which reproduces the JS results bit-for-bit.

#include "terrain_kernel/hydrology.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace terrain_kernel {

void fillDepressions(const float* h, float* filled, const Grid& g) {
  const int W = g.width;
  const int D = g.depth;
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  for (size_t i = 0; i < N; ++i) filled[i] = h[i];

  std::vector<uint8_t> closed(N, 0);
  // Binary min-heap of cell indices keyed by filled height; ties broken
  // by index — the same total order as the JS comparator, so the pop
  // sequence is identical.
  std::vector<int32_t> heap(N);
  size_t size = 0;
  auto less = [&](size_t a, size_t b) -> bool {
    const double fa = fget(filled, heap[a]);
    const double fb = fget(filled, heap[b]);
    return fa < fb || (fa == fb && heap[a] < heap[b]);
  };
  auto push = [&](int32_t i) {
    size_t k = size++;
    heap[k] = i;
    while (k > 0) {
      const size_t p = (k - 1) >> 1;
      if (!less(k, p)) break;
      std::swap(heap[k], heap[p]);
      k = p;
    }
  };
  // Seed with the border cells.
  for (int v = 0; v < D; ++v) {
    for (int u = 0; u < W; ++u) {
      if (u == 0 || v == 0 || u == W - 1 || v == D - 1) {
        const size_t i = idx(g, u, v);
        closed[i] = 1;
        push(static_cast<int32_t>(i));
      }
    }
  }
  const double epsilon = 1e-3;
  while (size > 0) {
    // pop
    const int32_t top = heap[0];
    heap[0] = heap[--size];
    size_t k = 0;
    for (;;) {
      const size_t l = 2 * k + 1;
      const size_t r = l + 1;
      size_t m = k;
      if (l < size && less(l, m)) m = l;
      if (r < size && less(r, m)) m = r;
      if (m == k) break;
      std::swap(heap[k], heap[m]);
      k = m;
    }
    const size_t c = static_cast<size_t>(top);
    const int u = static_cast<int>(c % static_cast<size_t>(W));
    const int v = static_cast<int>(c / static_cast<size_t>(W));
    const double fc = fget(filled, c);
    for (int dz = -1; dz <= 1; ++dz) {
      for (int dx = -1; dx <= 1; ++dx) {
        if (dx == 0 && dz == 0) continue;
        const int nu = u + dx;
        const int nv = v + dz;
        if (nu < 0 || nv < 0 || nu >= W || nv >= D) continue;
        const size_t n = idx(g, nu, nv);
        if (closed[n]) continue;
        closed[n] = 1;
        const double raised = fc + epsilon;
        if (fget(filled, n) < raised) fset(filled, n, raised);
        push(static_cast<int32_t>(n));
      }
    }
  }
}

void computeDrainage(const float* surface, const Grid& g, Drainage* out) {
  const int W = g.width;
  const int D = g.depth;
  const size_t N = static_cast<size_t>(W) * static_cast<size_t>(D);
  const double SQRT2 = std::sqrt(2.0);  // == JS Math.SQRT2, correctly rounded
  out->receiver.assign(N, -1);
  out->distance.assign(N, 0.0f);
  for (int v = 0; v < D; ++v) {
    for (int u = 0; u < W; ++u) {
      const size_t i = idx(g, u, v);
      const double si = fget(surface, i);
      int32_t best = -1;
      double bestDrop = 0.0;
      double bestDist = 0.0;
      for (int dz = -1; dz <= 1; ++dz) {
        for (int dx = -1; dx <= 1; ++dx) {
          if (dx == 0 && dz == 0) continue;
          const int nu = u + dx;
          const int nv = v + dz;
          if (nu < 0 || nv < 0 || nu >= W || nv >= D) continue;
          const size_t j = idx(g, nu, nv);
          const double dist =
              (dx != 0 && dz != 0) ? SQRT2 * g.cell : g.cell;
          const double drop = (si - fget(surface, j)) / dist;
          // JS keeps the strictly-greatest drop seen first; ties keep the
          // earlier neighbour. `drop > bestDrop` reproduces that exactly.
          if (drop > bestDrop) {
            best = static_cast<int32_t>(j);
            bestDrop = drop;
            bestDist = dist;
          }
        }
      }
      out->receiver[i] = best;
      fset(out->distance.data(), i, bestDist);
    }
  }
  // High-to-low order. JS: (a, b) => surface[b] - surface[a] || a - b.
  // Same total order here; std::sort is deterministic for fixed input.
  out->order.resize(N);
  for (size_t i = 0; i < N; ++i) out->order[i] = static_cast<uint32_t>(i);
  std::sort(out->order.begin(), out->order.end(),
            [&](uint32_t a, uint32_t b) {
              const double sa = fget(surface, a);
              const double sb = fget(surface, b);
              if (sa != sb) return sa > sb;
              return a < b;
            });
}

void accumulate(const Drainage& d, const Grid& g, const float* weight,
                float* acc) {
  const size_t N = d.receiver.size();
  const double area = g.cell * g.cell;
  for (size_t i = 0; i < N; ++i) {
    const double w = weight ? fget(weight, i) : 1.0;
    fset(acc, i, area * w);
  }
  for (uint32_t i : d.order) {
    const int32_t r = d.receiver[i];
    if (r >= 0) {
      const size_t ri = static_cast<size_t>(r);
      fset(acc, ri, fget(acc, ri) + fget(acc, i));
    }
  }
}

}  // namespace terrain_kernel
