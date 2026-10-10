# Generated R3F components (TL2)

This directory contains gltfjsx-generated React Three Fiber components.

## Workflow

1. Place source GLBs in `apps/client/public/models/`
2. Run `npm run models:generate` from `apps/client/`
3. Commit the generated `*.tsx` files
4. Import and use in scenes: `import { MyModel } from "./generated/MyModel.js"`

## Rules

- **Never hand-edit** generated files. Regenerate instead.
- The generator uses `--types` for TypeScript output.
- Source GLBs should be the compressed output from the art pipeline (TL1b/c).
- Generated files may need `// @ts-nocheck` or tsconfig adjustments — gltfjsx output is optimized for fidelity, not strict TS.

## Gate

A generated component must render pixel-identical to loading the source GLB directly via `createGltfLoader()`. Verify with a screenshot comparison before committing a new model.

## Decoder note

Generated components use drei's `useGLTF` (default loader). For compressed assets (meshopt/KTX2), the loader needs `MeshoptDecoder`/`KTX2Loader` wired — see `../gltf-loader.ts`. When we ship compressed models via gltfjsx, we'll need to configure drei's loader or wrap the components. For now, generated components are for uncompressed dev models.
