# Internals

Subsystem design references that **source code points at by path**, usually
with a section number. They are engineering notes for people changing these
subsystems, not part of the documentation set in [`../README.md`](../README.md).

If you are building a game on this engine, you want
[BUILDING-A-GAME.md](../BUILDING-A-GAME.md) instead. Come here when a comment
in the code sends you.

| Doc | Subsystem | Cited from |
|---|---|---|
| [SAB-LOGGING-LAYER-SPEC.md](SAB-LOGGING-LAYER-SPEC.md) | The lock-free log rings and the log worker | `packages/logging/*`, `packages/engine-core/src/logging/*`, `scripts/lint-no-console.mjs` |
| [EDGE-CORE-SPLIT.md](EDGE-CORE-SPLIT.md) | The edge process, the framed channel and the metrics catalog | `apps/edge/*`, `packages/channel/*`, `packages/nethealth/*` |
| [EDGE-SPLIT-RESULTS.md](EDGE-SPLIT-RESULTS.md) | The edge/core benchmark log, appended to by the harness | `packages/channel/test/bench/results.mjs`, `scripts/bench-e5.mjs` |
| [CPP-MAIN-TICK-SPEC.md](CPP-MAIN-TICK-SPEC.md) | The native tick and the shared-memory data plane | `packages/engine-core/test/*`, the data-plane benches |
| [CLIENT-SAB-ASSET-PIPELINE.md](CLIENT-SAB-ASSET-PIPELINE.md) | Off-main-thread asset decoding and the COOP/COEP requirement | `apps/client/src/assets/sab-support.ts`, `apps/client/vite.config.ts` |
| [EDITOR-ARCHITECTURE.md](EDITOR-ARCHITECTURE.md) | The modular editor's shell and panel model | `apps/editor/src/ui/App.tsx`, `packages/engine-core/src/persist/persistence-core.ts` |
| [EDITOR-AUTHORING.md](EDITOR-AUTHORING.md) | The view-centered authoring model | `apps/editor/src/ui/authoring-view.tsx` |
| [VFX-SHADER-POSTFX-BLUEPRINT.md](VFX-SHADER-POSTFX-BLUEPRINT.md) | The VFX, shader and post-processing contract | `packages/render-fx/src/types.ts` |
| [VFX-CPP-MAPPING.md](VFX-CPP-MAPPING.md) | The VFX structures a C++ backend would consume | `packages/art/src/vfx-convert.ts`, `packages/art/src/vfx-schema.ts` |
| [TERRAIN-MASK.md](TERRAIN-MASK.md) | Terrain material masks and the bake envelope | `packages/art/src/media/terrain-mask.ts`, `packages/engine-core/src/terrain/mask-bake.ts` |
| [CEL-SHADING-AUDIT.md](CEL-SHADING-AUDIT.md) | Where cel shading is and is not applied | `apps/client/src/render/shading/world-classes.ts` |
| [ANIMATION-BAKE-PIPELINE.md](ANIMATION-BAKE-PIPELINE.md) | The animation bake addon, not yet implemented | `packages/art/src/animation-bake.ts` (its error messages name this file) |
| [VALGRIND_BASELINES.md](VALGRIND_BASELINES.md) | The memcheck and callgrind baselines for the native addons | `npm run valgrind:*` |

**Before deleting one of these, grep for its path.** The code is what keeps
them alive; when the last reference goes, so should the file.
