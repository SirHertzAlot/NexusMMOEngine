# TS5: GLB Delivery Desk — Batch QA Evaluation

## Verdict: NO ADOPTION (covered by existing validators)

**Evaluated:** Batch GLB QA tooling for asset pipelines.

## Finding

The engine already has comprehensive GLB validation:

1. **Manifest validation** (`packages/art`): schema-checked asset manifests
2. **TL1d golden test**: byte reduction + visual delta + decoder verification
3. **A-ANIM validators** (ANIMATION-RUNTIME.md): loop continuity, root-motion, foot-slide, bone budget, event-track completeness
4. **TL4 Gobkit tests**: rig/animation contract verification

These cover >50% of what external batch QA tools offer. Per the roadmap gate ("adopt missing checks unless it covers over 50% of ours"), no adoption.

## What would trigger re-evaluation

- A specific tool with checks we lack (e.g., automated LOD validation, PBR material conformance)
- Batch processing at a scale our validators can't handle (1000+ assets)

## Recommendation

Keep building validators in `packages/art` as needed. The TL1d pattern (golden test per asset) scales better than a generic batch tool.
