#!/usr/bin/env node
/**
 * CLI for Baked Asset Store B2 clip baking (`BAKED-ASSET-STORE-SPEC.md §5 B2`):
 *
 *   npm run bake:clips -w @mmo-engine/art -- --manifest assets/models/glb/modular-fantasy-hero/Rigged/animations.json --out <dir>
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bakeClipStore } from "../baked-clips-bake.js";
import type { ClipCompressionMode } from "../baked-clips.js";
import type { BakeTarget } from "../baked-store.js";

function main(): void {
  const argv = process.argv.slice(2);
  let assetsRoot = "assets/models/glb/modular-fantasy-hero/Rigged";
  let manifestPath: string | undefined = "assets/models/glb/modular-fantasy-hero/Rigged/animations.json";
  let rigPath: string | undefined = "assets/models/glb/modular-fantasy-hero/Rigged/rig.glb";
  let outDir = "baked-clips-out";
  let kit = "character-clips";
  let target: BakeTarget = "own-game";
  let compression: ClipCompressionMode = "quant16";
  let creditsPath: string | undefined = "content/credits.json";
  const sourceIds: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--assets" && argv[i + 1]) assetsRoot = argv[++i];
    else if (a === "--manifest" && argv[i + 1]) manifestPath = argv[++i];
    else if (a === "--rig" && argv[i + 1]) rigPath = argv[++i];
    else if (a === "--out" && argv[i + 1]) outDir = argv[++i];
    else if (a === "--kit" && argv[i + 1]) kit = argv[++i];
    else if (a === "--target" && argv[i + 1]) target = argv[++i] as BakeTarget;
    else if (a === "--compression" && argv[i + 1]) compression = argv[++i] as ClipCompressionMode;
    else if (a === "--source" && argv[i + 1]) sourceIds.push(argv[++i]);
    else if (a === "--credits" && argv[i + 1]) creditsPath = argv[++i];
  }

  const res = bakeClipStore({
    assetsRoot: resolve(assetsRoot),
    animationsManifestPath: manifestPath && existsSync(resolve(manifestPath)) ? resolve(manifestPath) : undefined,
    rigGlbPath: rigPath && existsSync(resolve(rigPath)) ? resolve(rigPath) : undefined,
    outDir: resolve(outDir),
    kit,
    target,
    compression,
    sourceIds: sourceIds.length > 0 ? sourceIds : undefined,
    creditsPath: creditsPath && existsSync(resolve(creditsPath)) ? resolve(creditsPath) : undefined,
  });

  try {
    process.stdout.write(
      `${JSON.stringify(
        {
          kit,
          target,
          compression,
          bakedCount: res.bakedCount,
          uniqueBlobCount: res.uniqueBlobCount,
          rejectedCount: res.rejectedCount,
          totalRawBytes: res.totalRawBytes,
          totalCompressedBytes: res.totalCompressedBytes,
          compressionRatio: res.totalRawBytes > 0 ? +(res.totalCompressedBytes / res.totalRawBytes).toFixed(4) : 1,
          maxPositionErrorM: +res.maxPositionErrorM.toExponential(3),
          maxRotationErrorRad: +res.maxRotationErrorRad.toExponential(3),
          chunkHash: res.manifest.chunkHash,
          manifestPath: res.manifestPath,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    res.store.close();
  }
}

main();
