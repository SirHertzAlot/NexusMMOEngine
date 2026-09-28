// scatter_core.h — pure C++17 PCG scatter executor (no Node headers).
//
// Executes a *cooked* scatter plan (see @mmo-engine/scatter) for one chunk:
// sampler -> filters/modifiers -> spawner, producing spawn records.
//
// Bit-exactness contract with the JS reference evaluator
// (packages/scatter/src/reference.ts):
//   - All point fields are float32 (like the JS Float32Array SoA):
//     every write quantizes float64 -> float32, every read widens back.
//   - All hash arithmetic is uint32_t (wrapping multiply = Math.imul).
//   - All float64 arithmetic follows the JS op order exactly; the build
//     disables FP contraction (-ffp-contract=off, /fp:precise) so no
//     fused multiply-add changes rounding vs the JS engine.
//   - No C++ exceptions (matches the /EHsc- / -fno-exceptions addon
//     builds): errors come back via the `err` out-param.
//
// The heightfield is an input tile (Float64Array from JS), sampled with
// bilinear interpolation. slopeFilter only needs local gradients, so the
// tile must cover the chunk footprint plus the sample epsilon.

#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace mmo_scatter {

// Chunk footprint in world units (matches addon-procgen CHUNK_SIZE and
// the JS SCATTER_CHUNK_SIZE).
inline constexpr double kChunkSize = 16.0;

// ---------------------------------------------------------------------------
// Hash primitives (the single source of all scatter randomness).
// ---------------------------------------------------------------------------

inline uint32_t HashU32(uint32_t x) {
  x = x ^ (x >> 16);
  x = x * 0x45d9f3bu;  // wraps mod 2^32, like Math.imul
  x = x ^ (x >> 16);
  x = x * 0x45d9f3bu;
  x = x ^ (x >> 16);
  return x;
}

inline double Hash01(uint32_t x) {
  return static_cast<double>(HashU32(x)) / 4294967296.0;
}

inline uint32_t DeriveChunkSeed(uint32_t worldSeed, int32_t cx, int32_t cz) {
  const uint32_t mixed = worldSeed ^
                         (static_cast<uint32_t>(cx) * 374761393u) ^
                         (static_cast<uint32_t>(cz) * 668265263u);
  return HashU32(mixed);
}

// ---------------------------------------------------------------------------
// Heightfield tile.
// ---------------------------------------------------------------------------

struct HeightGrid {
  const double* data = nullptr;  // row-major, gridN x gridN
  int gridN = 0;
  double ox = 0.0;   // world x of data[0]
  double oz = 0.0;   // world z of data[0]
  double step = 1.0;

  // Bilinear sample. Exact on grid nodes; clamps at the tile border.
  double sample(double x, double z) const;
};

// ---------------------------------------------------------------------------
// Cooked plan (resolved by the JS cooker; the addon only executes).
// ---------------------------------------------------------------------------

enum class NodeType : uint8_t {
  GridSampler,
  DensityFilter,
  SlopeFilter,
  AttributeFilter,
  SetAttribute,
  TransformPoints,
  MeshSpawner,
};

struct SpawnEntry {
  std::string asset;
  double weight = 0.0;
};

struct NodeSpec {
  NodeType type = NodeType::GridSampler;
  // gridSampler
  double spacing = 0.0;
  double jitter = 0.0;
  uint32_t seed = 0;
  // densityFilter
  double density = 0.0;
  // slopeFilter
  double maxSlope = 0.0;
  // attributeFilter / setAttribute
  std::string attribute;
  double minVal = 0.0;
  double maxVal = 0.0;
  double value = 0.0;
  // transformPoints
  double yawMin = 0.0;
  double yawMax = 0.0;
  double scaleMin = 1.0;
  double scaleMax = 1.0;
  // meshSpawner
  std::vector<SpawnEntry> entries;
};

struct ScatterArgs {
  uint32_t worldSeed = 0;
  int32_t cx = 0;
  int32_t cz = 0;
  HeightGrid heights;
};

// One point: float32 fields (JS Float32Array parity), u32 seed.
struct Point {
  float x = 0, y = 0, z = 0;
  float yaw = 0, pitch = 0, roll = 0;
  float sx = 1, sy = 1, sz = 1;
  float density = 1;
  uint32_t seed = 0;
};

struct SpawnRecord {
  double x = 0, y = 0, z = 0;
  double yaw = 0, pitch = 0, roll = 0;
  double sx = 1, sy = 1, sz = 1;
  std::string asset;
  uint32_t variantSeed = 0;
  uint32_t seed = 0;
  // Dynamic attributes in first-set order (JS Map insertion order).
  std::vector<std::pair<std::string, double>> attrs;
};

// Execute the ordered node specs for one chunk.
// Returns false and sets err on invalid input (unknown type with no
// handler is a caller bug — the cooker guarantees validity).
bool ScatterChunk(const std::vector<NodeSpec>& orderedNodes,
                  const ScatterArgs& args, std::vector<SpawnRecord>& out,
                  std::string& err);

}  // namespace mmo_scatter
