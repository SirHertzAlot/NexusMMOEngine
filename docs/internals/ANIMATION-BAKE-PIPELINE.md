# TL5: ozz-animation + acl Bake Pipeline

## Decision (from ANIMATION-RUNTIME.md)

- **ozz-animation** → ADOPT (MIT). Native skeletal animation runtime + offline toolchain.
- **acl** → ADOPT at bake (MIT). Animation compression library.
- **Motion matching** → PARKED (memory, corpus, CPU cost).

## Architecture

```
GLB/FBX (source)
    ↓
[convert:animations] (existing JS step)
    ↓
ozz offline toolchain (via N-API addon)
    ├── Retargeting (skeleton → skeleton)
    ├── Validation (loop continuity, foot-slide, bone budget)
    └── Root-motion extraction
    ↓
acl compression (via N-API addon)
    ├── Compress clips at bake
    └── Output: compressed clip data + decompression metadata
    ↓
content/animations/*.anim (engine format)
    ↓
Client: three.js AnimationMixer (for now)
    ↓ (future)
Client: ozz WASM (gated on measured 100+ character benchmark)
```

## N-API Addon Interface (packages/art/src/native/)

The addon exposes:

```typescript
// Retarget a clip from source skeleton to target skeleton
retargetClip(
  sourceClip: ArrayBuffer,  // GLB animation data
  sourceSkeleton: SkeletonDef,
  targetSkeleton: SkeletonDef
): ArrayBuffer;  // ozz runtime format

// Compress with acl
compressClip(
  clip: ArrayBuffer,  // ozz format
  errorThreshold: number  // max position error in cm
): {
  data: ArrayBuffer;  // acl-compressed
  stats: {
    rawBytes: number;
    compressedBytes: number;
    maxError: number;
  };
};

// Validate a clip
validateClip(clip: ArrayBuffer): {
  loopContinuous: boolean;
  footSlide: number;  // max foot displacement during contact
  boneCount: number;
};
```

## JS-side (this PR)

- `packages/art/src/animation-bake.ts`: TypeScript interface + stub implementations
- Tests verify the interface contract (not the native code)

## Native side (follow-up)

1. Vendor ozz-animation (MIT) under `native/ozz/`
2. Vendor acl (MIT) under `native/acl/`
3. Build N-API addon (`packages/art/native/`)
4. Same pattern as Jolt/navmesh addons

## Web client path

three.js `AnimationMixer` stays for now. ozz-to-WASM is the upgrade path, gated on:
- Per-character CPU at 100+ visible characters
- WASM vs. current mixer measurement

Do not migrate on faith; migrate on numbers.
