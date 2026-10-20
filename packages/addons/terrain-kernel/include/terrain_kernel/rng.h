// Deterministic PRNGs for the terrain kernel.
//
// Mulberry32 is bit-identical to `mulberry32` in
// packages/engine-core/src/terrain/survey.ts (pure integer ops), so the
// C++ droplet stage consumes exactly the same random sequence the JS
// reference does for the same seed. SplitMix64 is the kernel-internal
// seeder for stages with no JS equivalent (tectonics).

#pragma once

#include <cstdint>

namespace terrain_kernel {

// Bit-identical to the JS mulberry32: returns doubles in [0, 1).
class Mulberry32 {
 public:
  explicit Mulberry32(uint32_t seed) : a_(seed) {}

  double next() {
    a_ += 0x6d2b79f5u;
    uint32_t t = imul(a_ ^ (a_ >> 15), 1u | a_);
    t = (t + imul(t ^ (t >> 7), 61u | t)) ^ t;
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  }

 private:
  // Math.imul semantics: low 32 bits of the product (uint32 wrap).
  static uint32_t imul(uint32_t x, uint32_t y) { return x * y; }
  uint32_t a_;
};

// SplitMix64 (Steele, Lea, Vigna 2014): 64-bit state, uniform doubles.
class SplitMix64 {
 public:
  explicit SplitMix64(uint64_t seed) : state_(seed) {}

  uint64_t nextU64() {
    uint64_t z = (state_ += 0x9e3779b97f4a7c15ull);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return z ^ (z >> 31);
  }

  // Uniform double in [0, 1): top 53 bits of the generator output.
  double next() {
    return static_cast<double>(nextU64() >> 11) / 9007199254740992.0;
  }

 private:
  uint64_t state_;
};

}  // namespace terrain_kernel
