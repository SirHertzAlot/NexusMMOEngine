# VFX C++ Mapping

How engine-agnostic `VfxEffect` JSON maps to C++ structs for the backend.

## Design principles

1. **The JSON is the source of truth.** Both the JS client and C++ backend parse the same `content/vfx/*.json` files.
2. **Simulation is deterministic.** All randomness uses a seeded PRNG. The same seed + effect + tick = same particle positions on any platform.
3. **Curves are baked.** `VfxCurve` (piecewise-linear) is sampled into a fixed lookup table at load time (e.g. 64 samples). C++ and JS use the same table size and sampling.
4. **Units are SI.** Positions in meters, time in seconds, angles in radians.

## C++ struct mapping

```cpp
// Mirrors VfxCurvePoint
struct VfxCurvePoint {
    float t;      // [0,1] normalized life
    float value;
};

// Baked lookup table (64 samples)
struct VfxCurveTable {
    float samples[64];
    float evaluate(float t) const;  // linear interpolation
};

struct VfxVec3 { float x, y, z; };
struct VfxColor { float r, g, b, a; };

enum class VfxSpawnKind { Point, Sphere, Box, Cone, Disc };
struct VfxSpawnShape {
    VfxSpawnKind kind;
    union {
        struct { float radius; } sphere;
        struct { VfxVec3 halfExtents; } box;
        struct { float angle, radius, height; } cone;
        struct { float radius; VfxVec3 normal; } disc;
    };
};

enum class VfxForceKind { Gravity, Drag, Turbulence, Attractor };
struct VfxForce {
    VfxForceKind kind;
    union {
        VfxVec3 acceleration;                    // gravity
        float dragCoefficient;                   // drag
        struct { float intensity, frequency; } turbulence;
        struct { VfxVec3 target; float strength; } attractor;
    };
};

struct VfxBurst {
    float time;
    uint32_t count;
    uint32_t repeat;    // 0 = infinite
    float interval;
};

struct VfxEmitter {
    char name[64];
    float rate;                    // particles/second
    std::vector<VfxBurst> bursts;
    float duration;                // 0 = infinite
    bool looping;
    uint32_t maxParticles;
    VfxSpawnShape spawnShape;
    VfxCurveTable speed;           // baked from VfxScalar
    VfxVec3 direction;
    float spread;                  // radians
    VfxCurveTable lifetime;
    VfxCurveTable size;
    // Color: either constant or gradient
    bool hasColorGradient;
    VfxColor constantColor;
    struct { float t; VfxColor color; } colorStops[16];
    uint8_t colorStopCount;
    std::vector<VfxForce> forces;
    VfxVec3 position;              // local offset
};

enum class VfxBlendMode { Normal, Additive, Multiply, Screen };

struct VfxEffect {
    char id[64];
    char name[128];
    uint32_t version;
    std::vector<VfxEmitter> emitters;
    VfxBlendMode blendMode;
    char texture[256];             // asset ID, empty if untextured
    // authoredTier is metadata only; the backend uses its own budgets
};
```

## Determinism requirements

- **PRNG:** Use a seeded xorshift or splitmix64. The seed comes from `(effectId hash) ^ (emitterIndex) ^ (serverTick)`.
- **Curve sampling:** 64 samples, linear interpolation. Both JS (`vfx-convert.ts`) and C++ must use identical sample positions: `t = i / 63` for `i` in `[0, 63]`.
- **Integration:** Semi-implicit Euler with fixed timestep (1/60s). Forces applied in the order listed in the JSON.
- **Spawn shapes:** Sample uniformly. Document the sampling method per shape so JS and C++ match.

## JSON loading (C++)

Use a JSON library (e.g. nlohmann/json) to parse `content/vfx/*.json`, validate against the same rules as the zod schema (see `packages/art/src/vfx-schema.ts` for the authoritative field list), then bake curves to lookup tables.

## What the backend does with VFX

The C++ backend uses VFX for **server-authoritative effects**: hit impacts, spell casts, environmental effects that need to be consistent across clients. The backend simulates the particle positions (for gameplay-relevant queries like "did the fire hit?") while the client renders the visuals.

Gameplay-relevant VFX (damage zones, telegraphs) are simulated server-side. Purely cosmetic VFX (embers, ambient motes) are client-only.
