// scatter_core.cc — pure C++17 PCG scatter executor.
//
// Bit-exact port of packages/scatter/src/reference.ts. Every numeric
// decision below mirrors the JS op order; see scatter_core.h for the
// determinism contract. In particular:
//
//   - Point fields are float: each write quantizes double -> float
//     (JS Float32Array parity), each read widens float -> double.
//   - Hash math is uint32_t (wrapping multiply = Math.imul).
//   - Sort is stable by seed (JS sortBySeedCanonical).
//   - Compaction preserves relative order (JS compactPoints).

#include "scatter_core.h"

#include <algorithm>
#include <cmath>

namespace mmo_scatter {

double HeightGrid::sample(double x, double z) const {
  double tx = (x - ox) / step;
  double tz = (z - oz) / step;
  int ix = static_cast<int>(std::floor(tx));
  int iz = static_cast<int>(std::floor(tz));
  double fx = tx - static_cast<double>(ix);
  double fz = tz - static_cast<double>(iz);
  if (ix < 0) {
    ix = 0;
    fx = 0;
  }
  if (iz < 0) {
    iz = 0;
    fz = 0;
  }
  if (ix > gridN - 2) {
    ix = gridN - 2;
    fx = 1;
  }
  if (iz > gridN - 2) {
    iz = gridN - 2;
    fz = 1;
  }
  const double h00 = data[iz * gridN + ix];
  const double h10 = data[iz * gridN + ix + 1];
  const double h01 = data[(iz + 1) * gridN + ix];
  const double h11 = data[(iz + 1) * gridN + ix + 1];
  return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) +
         h01 * (1 - fx) * fz + h11 * fx * fz;
}

namespace {

// One dynamic attribute column (float storage, JS Float32Array parity).
struct AttrCol {
  std::string name;
  std::vector<float> col;
};

}  // namespace

bool ScatterChunk(const std::vector<NodeSpec>& nodes, const ScatterArgs& args,
                  std::vector<SpawnRecord>& out, std::string& err) {
  if (nodes.empty()) {
    err = "scatter: plan has no nodes";
    return false;
  }
  if (args.heights.data == nullptr || args.heights.gridN < 2 ||
      !(args.heights.step > 0)) {
    err = "scatter: invalid height grid (need >= 2x2, step > 0)";
    return false;
  }

  const uint32_t chunkSeed =
      DeriveChunkSeed(args.worldSeed, args.cx, args.cz);
  std::vector<Point> pts;
  std::vector<AttrCol> attrs;
  pts.reserve(1024);

  const auto findAttr = [&](const std::string& name) -> std::vector<float>* {
    for (auto& a : attrs) {
      if (a.name == name) return &a.col;
    }
    return nullptr;
  };

  // Stable compaction preserving relative order (JS compactPoints).
  const auto compact = [&](const std::vector<unsigned char>& keep) {
    size_t w = 0;
    for (size_t r = 0; r < pts.size(); r++) {
      if (!keep[r]) continue;
      if (w != r) {
        pts[w] = pts[r];
        for (auto& a : attrs) a.col[w] = a.col[r];
      }
      w++;
    }
    pts.resize(w);
    for (auto& a : attrs) a.col.resize(w);
  };

  for (const NodeSpec& spec : nodes) {
    switch (spec.type) {
      case NodeType::GridSampler: {
        if (!(spec.spacing > 0)) {
          err = "scatter: gridSampler needs spacing > 0";
          return false;
        }
        const int n =
            std::max(1, static_cast<int>(std::ceil(kChunkSize / spec.spacing)));
        pts.clear();
        attrs.clear();
        pts.reserve(static_cast<size_t>(n) * static_cast<size_t>(n));
        const double ox = static_cast<double>(args.cx) * kChunkSize;
        const double oz = static_cast<double>(args.cz) * kChunkSize;
        uint32_t lattice = 0;
        for (int j = 0; j < n; j++) {
          for (int i = 0; i < n; i++) {
            const uint32_t pointSeed =
                HashU32(chunkSeed ^ HashU32(lattice));
            double x = ox + (i + 0.5) * spec.spacing;
            double z = oz + (j + 0.5) * spec.spacing;
            if (spec.jitter > 0) {
              const double jx =
                  Hash01(pointSeed ^ 0x9e3779b9u) - 0.5;
              const double jz =
                  Hash01(pointSeed ^ 0x7f4a7c15u) - 0.5;
              x += jx * spec.spacing * spec.jitter;
              z += jz * spec.spacing * spec.jitter;
            }
            Point p;
            p.x = static_cast<float>(x);
            // Snap to the terrain heightfield: spawns rest on the ground,
            // they don't hover at y=0 (matches the TS reference evaluator).
            p.y = static_cast<float>(args.heights.sample(x, z));
            p.z = static_cast<float>(z);
            p.seed = pointSeed;
            pts.push_back(p);
            lattice++;
          }
        }
        // Canonical ordering: stable sort by seed (JS sortBySeedCanonical).
        std::stable_sort(pts.begin(), pts.end(),
                         [](const Point& a, const Point& b) {
                           return a.seed < b.seed;
                         });
        break;
      }
      case NodeType::DensityFilter: {
        std::vector<unsigned char> keep(pts.size());
        for (size_t i = 0; i < pts.size(); i++) {
          keep[i] =
              Hash01(pts[i].seed ^ spec.seed) < spec.density ? 1 : 0;
        }
        compact(keep);
        break;
      }
      case NodeType::SlopeFilter: {
        const double e = 0.5;
        std::vector<unsigned char> keep(pts.size());
        for (size_t i = 0; i < pts.size(); i++) {
          const double x = pts[i].x;
          const double z = pts[i].z;
          const double gx =
              (args.heights.sample(x + e, z) - args.heights.sample(x - e, z)) /
              (2 * e);
          const double gz =
              (args.heights.sample(x, z + e) - args.heights.sample(x, z - e)) /
              (2 * e);
          const double slope = std::sqrt(gx * gx + gz * gz);
          keep[i] = slope <= spec.maxSlope ? 1 : 0;
        }
        compact(keep);
        break;
      }
      case NodeType::AttributeFilter: {
        std::vector<float>* col = findAttr(spec.attribute);
        if (col == nullptr) {
          err = "scatter: attributeFilter on unknown attribute \"" +
                spec.attribute + "\"";
          return false;
        }
        std::vector<unsigned char> keep(pts.size());
        for (size_t i = 0; i < pts.size(); i++) {
          const double v = (*col)[i];
          keep[i] = (v >= spec.minVal && v <= spec.maxVal) ? 1 : 0;
        }
        compact(keep);
        break;
      }
      case NodeType::SetAttribute: {
        std::vector<float>* col = findAttr(spec.attribute);
        if (col == nullptr) {
          attrs.push_back({spec.attribute,
                           std::vector<float>(pts.size(), 0.0f)});
          col = &attrs.back().col;
        }
        const float v = static_cast<float>(spec.value);
        for (size_t i = 0; i < pts.size(); i++) (*col)[i] = v;
        break;
      }
      case NodeType::TransformPoints: {
        const uint32_t saltYaw = HashU32(spec.seed ^ 0x12345678u);
        const uint32_t saltScale = HashU32(spec.seed ^ 0x87654321u);
        for (auto& p : pts) {
          const double yaw = spec.yawMin +
                             Hash01(p.seed ^ saltYaw) *
                                 (spec.yawMax - spec.yawMin);
          const double s = spec.scaleMin +
                           Hash01(p.seed ^ saltScale) *
                               (spec.scaleMax - spec.scaleMin);
          p.yaw = static_cast<float>(yaw);
          p.sx = static_cast<float>(s);
          p.sy = static_cast<float>(s);
          p.sz = static_cast<float>(s);
        }
        break;
      }
      case NodeType::MeshSpawner: {
        if (spec.entries.empty()) {
          err = "scatter: meshSpawner needs at least one entry";
          return false;
        }
        double total = 0.0;
        for (const auto& e : spec.entries) total += e.weight;
        out.clear();
        out.reserve(pts.size());
        for (size_t i = 0; i < pts.size(); i++) {
          const Point& p = pts[i];
          double r = Hash01(p.seed ^ spec.seed) * total;
          std::string asset = spec.entries.back().asset;
          for (const auto& e : spec.entries) {
            r -= e.weight;
            if (r < 0) {
              asset = e.asset;
              break;
            }
          }
          SpawnRecord rec;
          rec.x = p.x;
          rec.y = p.y;
          rec.z = p.z;
          rec.yaw = p.yaw;
          rec.pitch = p.pitch;
          rec.roll = p.roll;
          rec.sx = p.sx;
          rec.sy = p.sy;
          rec.sz = p.sz;
          rec.asset = asset;
          rec.variantSeed =
              HashU32(p.seed ^ HashU32(spec.seed ^ 0xabcdefu));
          rec.seed = p.seed;
          for (const auto& a : attrs) {
            rec.attrs.emplace_back(a.name,
                                   static_cast<double>(a.col[i]));
          }
          out.push_back(std::move(rec));
        }
        return true;  // spawner is terminal (cooker guarantees it is last)
      }
    }
  }
  err = "scatter: plan has no spawner";
  return false;
}

}  // namespace mmo_scatter
