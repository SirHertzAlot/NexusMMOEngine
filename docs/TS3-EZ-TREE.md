# TS3: EZ-Tree Spike

## Verdict: ADOPT (with bake-time constraint)

**@dgreenheck/ez-tree** (MIT, v1.1.0) — procedural tree generator for Three.js.

## Gate

| Gate | Target | Status |
|------|--------|--------|
| Distinct species at impostor distance | Visually distinct silhouettes | ✅ Preset-driven (Oak, Pine, Birch, etc.) |
| Same seed → byte-identical output | Deterministic generation | ⏳ Needs seeded RNG verification |

## Constraint: Bake-time only

EZ-Tree requires a DOM (`document.createElementNS` for textures). It cannot run in pure Node. The integration path is:

1. **Bake time** (editor or CI with headless browser): generate tree GLBs from seeds
2. **Runtime**: load baked GLBs like any other asset
3. **Impostor baker**: feed baked trees into the octahedral impostor pipeline

This matches the existing pattern: procedural at build, static at runtime.

## Integration plan

```
Seed + Species Preset
    ↓
EZ-Tree (headless browser / editor)
    ↓
Tree GLB (baked, committed to content/trees/)
    ↓
Impostor baker → distant LOD
    ↓
InstancedMesh2 scattering (TS4)
```

## Species presets (from EZ-Tree)

- Oak: broad canopy, gnarled branches
- Pine: conical, needle clusters
- Birch: slender, white bark
- Willow: drooping branches
- Custom: tunable (branch angle, length, leaf size, etc.)

## Follow-up

1. Seeded determinism test (same seed → byte-identical GLB)
2. Bake script (`npm run bake:trees`)
3. Impostor integration
4. TS4 scattering integration
